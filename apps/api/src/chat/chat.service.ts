import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TraceService } from '../trace/trace.service';
import { RouterService, RouterDecision, HeuristicFlags } from '../router/router.service';
import { TopicMatchService, TopicMatchResult } from '../topicmatch/topicmatch.service';
import { MemoryService } from '../memory/memory.service';
import { PostProcessorService } from '../postprocessor/postprocessor.service';
import { LlmService, LlmGenerationContext } from '../llm/llm.service';
import { RelationshipService } from '../relationship/relationship.service';
import { PersonaService } from '../persona/persona.service';
import {
  ChatRequestDto,
  ChatResponseDto,
  GetHistoryRequestDto,
  HistoryResponseDto,
  UserState,
  ApiErrorDto,
  AgeBand,
} from '@chingoo/shared';
import { createHash } from 'crypto';
import { MessageStatus, Prisma } from '@prisma/client';

/**
 * ChatService
 * 
 * Implements POST /chat/send per:
 * - API_CONTRACT.md §3 (DTOs)
 * - SPEC_PATCH.md (Idempotency replay semantics, INSERT new assistant row)
 * - AI_PIPELINE.md §4.1.2 (ONBOARDING → ACTIVE atomic commit)
 * 
 * Q10: Integrates Router + TopicMatch for deterministic routing decisions.
 * Q11: Integrates MemoryService for extraction + surfacing + correction targeting.
 * 
 * Per AI_PIPELINE.md §12.4 - Memory correction targeting:
 * "A correction command MUST target memories ONLY through surfaced_memory_ids
 * from the immediately previous assistant message."
 * 
 * [MINIMAL DEVIATION] Deterministic assistant message ID:
 * Uses SHA-256(namespace + message_id) formatted as UUID to derive assistant message ID.
 * The spec does not specify the linkage mechanism, so this is a safe deterministic choice.
 */

// Namespace for deterministic assistant message ID generation
// Per task requirement 3a: Define deterministic assistant message id derived from message_id
const ASSISTANT_MSG_NAMESPACE = 'chingoo-assistant-message-v1';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private prisma: PrismaService,
    private traceService: TraceService,
    private routerService: RouterService,
    private topicMatchService: TopicMatchService,
    private memoryService: MemoryService,
    private postProcessorService: PostProcessorService,
    private llmService: LlmService,
    private relationshipService: RelationshipService,
    private personaService: PersonaService,
  ) {}

  /**
   * Process chat message with idempotency and ONBOARDING → ACTIVE atomic transition.
   * 
   * Per SPEC_PATCH.md:
   * 1) If message_id COMPLETED → return stored assistant_message (HTTP 200)
   * 2) If message_id RECEIVED/PROCESSING → return deterministic in-progress (HTTP 409)
   * 3) If new message → process and INSERT new assistant message row
   * 
   * Per AI_PIPELINE.md §4.1.2:
   * - ONBOARDING → ACTIVE must be in single Prisma interactive transaction
   */
  async sendMessage(
    userId: string,
    userState: UserState,
    dto: ChatRequestDto,
  ): Promise<ChatResponseDto> {
    // Validate request DTO
    this.validateChatRequest(dto);

    // Check user state per AI_PIPELINE.md §6.1.1
    if (userState === UserState.CREATED) {
      throw new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        message: 'User must complete onboarding before sending chat messages',
        error: 'Forbidden',
      } as ApiErrorDto);
    }

    // Step 1: Idempotency check
    const existingMessage = await this.prisma.message.findUnique({
      where: { id: dto.message_id },
    });

    if (existingMessage) {
      return this.handleExistingMessage(existingMessage, dto.message_id);
    }

    // Step 2: Verify conversation belongs to user
    // Q12: Include stableStyleParams for PostProcessor emoji_freq extraction
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: dto.conversation_id },
      include: {
        aiFriend: {
          select: {
            id: true,
            personaTemplateId: true,
            stableStyleParams: true, // Q12: For emoji_freq in PostProcessor
          },
        },
        user: {
          include: {
            onboardingAnswers: true,
          },
        },
      },
    });

    if (!conversation || conversation.userId !== userId) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Invalid conversation_id',
        error: 'Bad Request',
      } as ApiErrorDto);
    }

    // Step 3: For ONBOARDING users, validate required data exists
    // Also check for ACTIVE users in case persona assignment failed during onboarding
    const isOnboarding = userState === UserState.ONBOARDING;
    if (isOnboarding) {
      await this.validateOnboardingRequirements(userId, conversation.aiFriend);
    }

    // Step 3b: Retry persona assignment if missing (handles failed assignment during onboarding)
    // Per AI_PIPELINE.md §3.1: Persona must be assigned before messages are processed
    if (!conversation.aiFriend.stableStyleParams) {
      this.logger.warn(`Persona not assigned for user ${userId}, attempting assignment...`);
      try {
        await this.personaService.assignPersona(userId, conversation.aiFriend.id);
        this.logger.log(`Persona successfully assigned for user ${userId} during chat`);
        
        // Reload conversation with updated persona data
        const updatedConversation = await this.prisma.conversation.findUnique({
          where: { id: dto.conversation_id },
          include: {
            aiFriend: {
              select: {
                id: true,
                personaTemplateId: true,
                stableStyleParams: true,
              },
            },
            user: {
              include: {
                onboardingAnswers: true,
              },
            },
          },
        });
        
        if (updatedConversation) {
          conversation.aiFriend = updatedConversation.aiFriend;
        }
      } catch (error) {
        this.logger.error(`Failed to assign persona during chat for user ${userId}:`, error);
        throw new ForbiddenException({
          statusCode: HttpStatus.FORBIDDEN,
          message: 'Onboarding incomplete: persona not assigned',
          error: 'Forbidden',
          constraints: ['stable_style_params'],
        } as ApiErrorDto);
      }
    }

    // Step 4: Build TurnPacket components and compute routing decision (Q10)
    const traceId = this.traceService.getTraceId() || crypto.randomUUID();
    
    // Q10: Compute text normalization and topic matches
    // Q11: Also compute heuristic flags for memory extraction
    const { normNoPunct, topicMatches, heuristicFlags } = this.computeTurnPacketComponents(dto.user_message);
    
    // Q10: Get age_band from onboarding answers for routing
    const ageBand = await this.getAgeBandForUser(userId);
    
    // Q10: Compute deterministic routing decision
    const routingDecision = this.routerService.route({
      user_state: userState,
      norm_no_punct: normNoPunct,
      token_estimate: this.estimateTokenCount(dto.user_message),
      topic_matches: topicMatches,
      age_band: ageBand,
    });

    // Step 5: Process message in transaction (Q9 behavior unchanged)
    // Q11: Now includes memory extraction + surfacing + correction handling
    const result = await this.processMessageTransaction(
      userId,
      userState,
      dto,
      conversation,
      traceId,
      isOnboarding,
      routingDecision,
      normNoPunct,
      heuristicFlags,
      topicMatches,
    );

    return result;
  }

  /**
   * Compute TurnPacket components per AI_PIPELINE.md §2.1 and §5.1
   * 
   * Q10: Text normalization per AI_PIPELINE.md §2.8:
   * 1) Unicode NFKC
   * 2) strip zero-width chars
   * 3) collapse whitespace to single spaces
   * 4) trim leading/trailing spaces
   * 5) lowercase ASCII letters only (do NOT lowercase non-Latin scripts)
   * 6) remove punctuation except apostrophes for norm_no_punct
   * 
   * Q11: Also computes heuristic flags for memory extraction triggers.
   */
  private computeTurnPacketComponents(userMessage: string): {
    userTextNorm: string;
    normNoPunct: string;
    topicMatches: TopicMatchResult[];
    heuristicFlags: HeuristicFlags;
  } {
    // Step 1-5: Normalize text
    let normalized = userMessage
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '') // Strip zero-width chars
      .replace(/\s+/g, ' ')                    // Collapse whitespace
      .trim();
    
    // Lowercase ASCII only (preserve non-Latin scripts)
    normalized = normalized.replace(/[A-Z]/g, char => char.toLowerCase());
    
    const userTextNorm = normalized;
    
    // Step 6: Create norm_no_punct (remove punctuation except apostrophes)
    const normNoPunct = normalized.replace(/[^\w\s'가-힣ㄱ-ㅎㅏ-ㅣ]/g, '');
    
    // Compute topic matches
    const topicMatches = this.topicMatchService.computeTopicMatches(normNoPunct);
    
    // Q11: Compute heuristic flags for memory extraction
    const heuristicFlags = this.computeHeuristicFlags(normNoPunct);
    
    return { userTextNorm, normNoPunct, topicMatches, heuristicFlags };
  }

  /**
   * Compute heuristic flags from normalized text.
   * Per AI_PIPELINE.md §5 - Preprocess triggers for memory extraction.
   * Per AI_PIPELINE.md §6.5 - Intent routing flags.
   * 
   * EXPANDED: Much more comprehensive trigger detection for better memory capture.
   */
  private computeHeuristicFlags(normNoPunct: string): HeuristicFlags {
    const textLower = normNoPunct.toLowerCase();

    // ============================================================================
    // PREFERENCE TRIGGERS - Expanded to catch many ways users express preferences
    // ============================================================================
    const preferencePatterns = [
      // Positive preferences
      'i like', 'i love', 'i enjoy', 'i adore', "i'm into", 'im into',
      'my favorite', 'my fav', "i'm a fan of", 'im a fan of', 'i prefer',
      "i'm obsessed with", 'im obsessed with', "i'm really into", 'im really into',
      "i'm passionate about", 'im passionate about', 'i appreciate',
      // Negative preferences
      'i hate', 'i dislike', "i can't stand", 'cant stand', "i don't like", 'dont like',
      "i'm not a fan of", 'im not a fan of', "i'm not into", 'im not into', 'i avoid',
      // Korean
      '좋아', '사랑해', '최애', '싫어', '별로',
    ];
    const has_preference_trigger = preferencePatterns.some(p => textLower.includes(p));

    // ============================================================================
    // FACT TRIGGERS - Massively expanded for personal information capture
    // ============================================================================
    const factPatterns = [
      // Location patterns
      "i'm from", 'im from', 'i come from', 'i live in', 'i moved to', 'i grew up in',
      'i was raised in', 'originally from', "i'm based in", 'im based in', 'my hometown',
      // Occupation/Work patterns
      'my job is', "i'm a", 'im a', 'i work at', 'i work for', 'i work as', 'i work in',
      'my company', 'my boss', 'my coworker', 'my colleague', 'my role is', 'my position',
      'i got a job', 'i joined', "i'm employed", 'im employed',
      // Education patterns
      'i study at', 'i go to', 'my school', 'my university', 'my college', 'i attend',
      'i major in', 'my major is', "i'm studying", 'im studying', 'my degree',
      'i graduated', "i'm a freshman", "i'm a sophomore", "i'm a junior", "i'm a senior",
      // Personal details
      'my birthday', 'born in', 'born on', 'i was born', 'my age is', 'years old',
      'my name is', 'call me', "i'm called", 'im called', 'my nickname',
      // Pets
      'my dog', 'my cat', 'my pet', "dog's name", "cat's name", "pet's name",
      'i have a dog', 'i have a cat', 'i have a pet', 'my puppy', 'my kitten',
      // Family
      'my mom', 'my dad', 'my mother', 'my father', 'my sister', 'my brother',
      'my grandma', 'my grandpa', 'my grandmother', 'my grandfather',
      'my husband', 'my wife', 'my spouse', 'my partner',
      'my son', 'my daughter', 'my kid', 'my child', 'my kids', 'my children',
      // Relationships
      "i'm single", 'im single', "i'm married", 'im married', "i'm dating", 'im dating',
      'my boyfriend', 'my girlfriend', 'my bf', 'my gf', 'my best friend', 'my friend',
      "i'm seeing", 'im seeing', 'i have a boyfriend', 'i have a girlfriend',
      // Health/Physical
      "i'm allergic", 'im allergic', "i'm vegan", 'im vegan', "i'm vegetarian", 'im vegetarian',
      "i don't eat", 'dont eat', "i can't eat", 'cant eat', 'my allergy',
      "i'm tall", 'im tall', "i'm short", 'im short', 'my height',
      // Skills/Abilities
      'i can', 'i know how to', "i'm good at", 'im good at', 'my skill',
      'i speak', "i'm fluent in", 'im fluent in', "i'm learning", 'im learning',
      'i play', 'i can play', 'my instrument',
      // Possessions
      'i drive a', 'my car', 'i have a car', 'i own', 'my phone', 'my laptop', 'my computer',
      // Routines
      'i wake up at', 'i sleep at', 'i go to bed', 'every morning i', 'every day i',
      'i usually', 'i always', 'i tend to', 'my routine', 'on weekends i',
      // Generic personal markers
      "i'm ", 'im ', 'my ', 'i have ',
      // Korean
      '나는', '저는', '제', '내',
    ];
    const has_fact_trigger = factPatterns.some(p => textLower.includes(p));

    // ============================================================================
    // EVENT TRIGGERS - Expanded for life events, milestones, activities
    // ============================================================================
    const eventPatterns = [
      // Past events
      'i went to', 'i visited', 'i attended', 'i saw', 'i watched', 'i met',
      'yesterday i', 'last week i', 'last month i', 'recently i', 'i just',
      'i finally', 'i hung out with', 'i talked to',
      // Upcoming events
      "i'm going to", 'im going to', 'i will', "i'm planning to", 'im planning to',
      'next week i', 'tomorrow i', 'soon i will', "i'm about to", 'im about to',
      // Milestones/Achievements
      'i graduated', 'i got promoted', 'i passed', 'i won', 'i achieved', 'i completed',
      'i finished', 'i earned', 'i received', 'i got accepted', 'i got engaged',
      'i got married', 'i had a baby', 'i bought', 'i moved',
      // Struggles/Challenges
      "i'm struggling", 'im struggling', "i'm having trouble", 'im having trouble',
      'i failed', "i didn't get", 'didnt get', 'i lost', 'i broke up',
      "i'm stressed", 'im stressed', "i'm worried", 'im worried',
      // Started/Stopped
      'i started', 'i began', "i'm starting", 'im starting', 'i picked up',
      'i stopped', 'i quit', "i'm quitting", 'im quitting', 'i gave up',
      "i've been", 'ive been',
      // Goals/Plans
      'i want to', 'i wanna', "i'd like to", 'id like to', 'i wish',
      'i plan to', "i'm planning", 'im planning', 'my plan is', 'my goal is',
      "i'm trying to", 'im trying to', "i'm working on", 'im working on',
      "i'm saving for", 'im saving for', "i'm looking for", 'im looking for',
      'my dream is', 'i hope to',
      // Original spec patterns
      'i broke up', 'my exam', "i'm traveling", 'im traveling', 'interview',
      // Korean
      '갔어', '했어', '봤어', '만났어', '할 거야', '계획', '꿈',
    ];
    const has_event_trigger = eventPatterns.some(p => textLower.includes(p));

    // ============================================================================
    // CORRECTION TRIGGERS
    // Must be specific phrases that indicate user is correcting the AI's memory
    // NOT generic words like "wrong" which appear in normal conversation
    // ============================================================================
    const has_correction_trigger = [
      // Direct memory correction phrases
      "you're wrong", 'youre wrong',
      "that's incorrect", 'thats incorrect',
      // Memory deletion phrases
      "don't remember that", 'dont remember that', 'forget that', 'forget about that',
      "don't remember this", 'dont remember this',
      // Topic suppression phrases
      "don't bring this topic up", 'dont bring this topic up',
      "don't mention that", 'dont mention that', "stop mentioning",
      // Explicit corrections - must have "no" or "not" with AI reference
      'no i', 'no my', "actually no", 'actually i', 'no that',
    ].some(p => textLower.includes(p));

    // ============================================================================
    // OTHER FLAGS (unchanged from original)
    // ============================================================================
    
    // Question detection per AI_PIPELINE.md §6.5
    const questionStarters = ['what', 'why', 'how', 'when', 'where', 'explain', 'define'];
    const words = textLower.split(/\s+/);
    const is_question = textLower.includes('?') || 
      (words.length > 0 && questionStarters.includes(words[0])) ||
      textLower.includes('how do i');

    // Personal pronoun detection per AI_PIPELINE.md §6.5
    const has_personal_pronoun = ['i ', "i'm", 'im ', 'my ', 'me '].some(
      p => textLower.includes(p)
    );

    // Distress detection per AI_PIPELINE.md §6.5
    const distressKeywords = [
      "i can't", 'i feel hopeless', "i'm panicking", "i'm so anxious",
      "i'm depressed", 'overwhelmed', 'so stressed', 'i hate myself',
      'nothing matters', 'i want to disappear',
      '우울', '불안', '공황', '힘들어', '죽고싶',
    ];
    const has_distress = distressKeywords.some(kw => textLower.includes(kw.toLowerCase()));

    // Comfort request detection per AI_PIPELINE.md §6.5
    const comfortKeywords = ['can you stay', 'talk to me', 'i need someone', 'please help me calm down', '위로'];
    const asks_for_comfort = comfortKeywords.some(kw => textLower.includes(kw.toLowerCase()));

    return {
      has_preference_trigger,
      has_fact_trigger,
      has_event_trigger,
      has_correction_trigger,
      is_question,
      has_personal_pronoun,
      has_distress,
      asks_for_comfort,
    };
  }

  /**
   * Get age_band for user from onboarding answers.
   * Per AI_PIPELINE.md §6.2.1: If missing, router treats as AGE_13_17 for safety.
   */
  private async getAgeBandForUser(userId: string): Promise<AgeBand | null> {
    const onboarding = await this.prisma.userOnboardingAnswers.findUnique({
      where: { userId },
      select: { ageBand: true },
    });
    
    if (!onboarding?.ageBand) {
      return null;
    }
    
    // Map Prisma enum to shared enum
    const ageBandMap: Record<string, AgeBand> = {
      'AGE_13_17': AgeBand.AGE_13_17,
      'AGE_18_24': AgeBand.AGE_18_24,
      'AGE_25_34': AgeBand.AGE_25_34,
      'AGE_35_44': AgeBand.AGE_35_44,
      'AGE_45_PLUS': AgeBand.AGE_45_PLUS,
    };
    
    return ageBandMap[onboarding.ageBand] ?? null;
  }

  /**
   * Estimate token count (simple whitespace-based estimation).
   * Per AI_PIPELINE.md §5: "Token count estimate (fast)"
   */
  private estimateTokenCount(text: string): number {
    // Simple estimation: split by whitespace and multiply by ~1.3 for subword tokens
    const words = text.trim().split(/\s+/).filter(w => w.length > 0);
    return Math.ceil(words.length * 1.3);
  }

  /**
   * Handle existing message (idempotency)
   * Per SPEC_PATCH.md: COMPLETED → return stored response, RECEIVED/PROCESSING → HTTP 409
   */
  private async handleExistingMessage(
    existingMessage: { id: string; status: MessageStatus; traceId: string },
    messageId: string,
  ): Promise<ChatResponseDto> {
    if (existingMessage.status === 'COMPLETED') {
      // Fetch the associated assistant message by derived ID
      const assistantMessageId = this.deriveAssistantMessageId(messageId);
      const assistantMessage = await this.prisma.message.findUnique({
        where: { id: assistantMessageId },
      });

      if (!assistantMessage) {
        // Edge case: completed user message but no assistant message
        // This should not happen in normal flow
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          message: 'Message completed but assistant response not found',
          error: 'Conflict',
        } as ApiErrorDto);
      }

      // Get current user state
      const userMessage = await this.prisma.message.findUnique({
        where: { id: messageId },
        include: { user: true },
      });

      return {
        message_id: messageId,
        user_state: userMessage!.user.state as UserState,
        assistant_message: {
          id: assistantMessage.id,
          content: assistantMessage.content,
          created_at: assistantMessage.createdAt.toISOString(),
        },
      };
    }

    // RECEIVED or PROCESSING → HTTP 409 with deterministic in-progress response
    // Per SPEC_PATCH.md: Return deterministic "request in progress, retry" message
    // Do NOT insert any additional assistant message rows
    const assistantMessageId = this.deriveAssistantMessageId(messageId);
    throw new ConflictException({
      message_id: messageId,
      user_state: UserState.ONBOARDING, // Will be corrected when completed
      assistant_message: {
        id: assistantMessageId,
        content: 'Your message is being processed. Please retry in a moment.',
        created_at: new Date().toISOString(),
      },
    } as unknown as ChatResponseDto);
  }

  /**
   * Validate ONBOARDING requirements per AI_PIPELINE.md §4.1.2
   * - Required onboarding answers exist
   * - Persona assignment exists (persona_template_id + stable_style_params)
   */
  private async validateOnboardingRequirements(
    userId: string,
    aiFriend: { personaTemplateId: string | null; stableStyleParams: Prisma.JsonValue | null },
  ): Promise<void> {
    // Check onboarding answers
    const onboarding = await this.prisma.userOnboardingAnswers.findUnique({
      where: { userId },
    });

    if (!onboarding) {
      throw new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        message: 'Onboarding incomplete: required answers missing',
        error: 'Forbidden',
        constraints: ['preferred_name', 'age_band', 'country_or_region', 'occupation_category', 'client_timezone'],
      } as ApiErrorDto);
    }

    // Check persona assignment per AI_PIPELINE.md §4.1.2
    // [MINIMAL DEVIATION] Only checking stableStyleParams since personaTemplateId
    // requires persona_templates table to be seeded (SCHEMA.md B.5).
    // The stableStyleParams contains all behavioral constraints per AI_PIPELINE.md §2.4.
    if (!aiFriend.stableStyleParams) {
      throw new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        message: 'Onboarding incomplete: persona not assigned',
        error: 'Forbidden',
        constraints: ['stable_style_params'],
      } as ApiErrorDto);
    }
  }

  /**
   * Process message in atomic transaction.
   * 
   * Per AI_PIPELINE.md §4.1.2:
   * - Use Prisma Interactive Transaction
   * - INSERT user message, INSERT assistant message (SPEC_PATCH)
   * - If ONBOARDING: transition to ACTIVE atomically
   * - Rollback if any check fails
   * 
   * Q10: routingDecision is passed in but stub response is still used.
   * Q11: Integrates memory extraction + surfacing + correction handling.
   * Q12: Integrates PostProcessor BEFORE persistence per AI_PIPELINE.md §10.
   * 
   * Per SPEC_PATCH.md §6.1:
   * j. Transaction BEGIN:
   *    - INSERT assistant message with surfaced_memory_ids: [list]
   *    - MemoryService.extractAndPersist(user_text)
   *    - COMMIT
   * 
   * CRITICAL ORDER INVARIANT (Q12):
   * Post-processing MUST happen BEFORE assistant message persistence.
   * The stored assistant message content MUST be the post-processed output
   * so idempotency replay returns the enforced version.
   */
  private async processMessageTransaction(
    userId: string,
    userState: UserState,
    dto: ChatRequestDto,
    conversation: {
      id: string;
      aiFriendId: string;
      user: { id: string; state: string };
      aiFriend?: { stableStyleParams: Prisma.JsonValue | null };
    },
    traceId: string,
    isOnboarding: boolean,
    routingDecision: RouterDecision,
    normNoPunct: string,
    heuristicFlags: HeuristicFlags,
    topicMatches: TopicMatchResult[],
  ): Promise<ChatResponseDto> {
    // Derive deterministic assistant message ID
    // [MINIMAL DEVIATION] Per task requirement 3a: UUIDv5(namespace, message_id)
    const assistantMessageId = this.deriveAssistantMessageId(dto.message_id);

    // Q11: Handle correction targeting BEFORE generating response
    // Per AI_PIPELINE.md §12.4: Correction targets surfaced_memory_ids from previous assistant message
    let correctionResult = null;
    if (heuristicFlags.has_correction_trigger) {
      correctionResult = await this.memoryService.handleCorrection({
        userId,
        aiFriendId: conversation.aiFriendId,
        conversationId: dto.conversation_id,
        normNoPunct,
        heuristicFlags,
      });
    }

    // Q11: Select memories for surfacing (keyword-based)
    // Per AI_PIPELINE.md §12.4: "Each assistant message must store surfaced_memory_ids"
    // Per task requirement: "If no memories are relevant, surfaced_memory_ids must be [] (empty array), not null"
    let surfacedMemoryIds = await this.memoryService.selectMemoriesForSurfacing({
      userId,
      aiFriendId: conversation.aiFriendId,
      userMessage: dto.user_message,
      topicMatches,
    });

    // Per AI_PIPELINE.md §13 - Vector Retrieval (Qdrant) - Gated
    // When vector_search_policy is ON_DEMAND, perform semantic search to find additional relevant memories
    if (routingDecision.vector_search_policy === 'ON_DEMAND' && this.memoryService.isVectorSearchReady()) {
      const queryText = routingDecision.retrieval_query_text || normNoPunct;
      const semanticMemoryIds = await this.memoryService.searchSemantically({
        userId,
        aiFriendId: conversation.aiFriendId,
        queryText,
      });

      // Merge semantic results with keyword-based results, avoiding duplicates
      // Per AI_PIPELINE.md §10.1: "do not mention >2 personal facts in one message"
      // Limit to 2 memories max to avoid PERSONAL_FACT_VIOLATION
      const combinedIds = new Set([...surfacedMemoryIds, ...semanticMemoryIds]);
      surfacedMemoryIds = Array.from(combinedIds).slice(0, 2);
    }

    // Fetch conversation history for LLM context
    // Per AI_PIPELINE.md §9: "Conversation recent turns"
    // Loading 40 messages (20 from user, 20 from AI) for better context
    const conversationHistory = await this.getRecentConversationHistory(
      dto.conversation_id,
      20, // Last 40 messages for full context
    );

    // Fetch surfaced memory details for personalization
    const surfacedMemories = await this.memoryService.getMemoriesByIds(surfacedMemoryIds);

    // Fetch relationship stage for intimacy cap enforcement
    const relationship = await this.prisma.relationship.findUnique({
      where: {
        userId_aiFriendId: {
          userId,
          aiFriendId: conversation.aiFriendId,
        },
      },
      select: {
        relationshipStage: true,
      },
    });
    const relationshipStage = relationship?.relationshipStage || 'STRANGER';

    // Parse stableStyleParams for LLM context
    const stableStyleParams = this.parseStableStyleParams(conversation.aiFriend?.stableStyleParams);

    // Fetch onboarding info for LLM context personalization
    // This is always included in the prompt so the AI knows basic facts about the user
    const onboardingData = await this.prisma.userOnboardingAnswers.findUnique({
      where: { userId },
      select: {
        preferredName: true,
        ageBand: true,
        occupationCategory: true,
        countryOrRegion: true,
      },
    });
    
    const userControls = await this.prisma.userControls.findUnique({
      where: { userId },
      select: { suppressedTopics: true },
    });
    
    const onboardingInfo = onboardingData ? {
      preferredName: onboardingData.preferredName,
      ageBand: onboardingData.ageBand,
      occupationCategory: onboardingData.occupationCategory,
      countryOrRegion: onboardingData.countryOrRegion,
      suppressedTopics: (userControls?.suppressedTopics as string[]) || [],
    } : undefined;

    // Q13: Generate AI response using real LLM call
    // Per AI_PIPELINE.md §7.1 step 7: "LLM call"
    // CRITICAL: This call happens BEFORE the transaction to preserve idempotency.
    // If LLM fails, we throw and no messages are marked as COMPLETED.
    let draftContent: string;
    try {
      const llmContext: LlmGenerationContext = {
        userMessage: dto.user_message,
        pipeline: routingDecision.pipeline,
        isFirstMessage: isOnboarding,
        correctionResult,
        heuristicFlags,
        stableStyleParams,
        conversationHistory,
        surfacedMemories: surfacedMemories.map(m => ({
          key: m.memoryKey,
          value: m.memoryValue,
        })),
        relationshipStage,
        onboardingInfo,
      };
      
      draftContent = await this.llmService.generate(llmContext);
    } catch (error) {
      // Per task requirement: "if LLM call fails, the turn must not persist assistant as COMPLETED"
      // Re-throw as InternalServerError to prevent transaction execution
      const errorMessage = error instanceof Error ? error.message : 'Unknown LLM error';
      throw new InternalServerErrorException({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: `Failed to generate response: ${errorMessage}`,
        error: 'Internal Server Error',
      } as ApiErrorDto);
    }

    // Q12: Post-process the draft content BEFORE persistence
    // Per AI_PIPELINE.md §10: Post-processor handles safety-critical constraints
    // (repetition, personal facts, intimacy) - NOT style (emoji, length)
    // Style is handled via LLM prompt guidance in llm.service.ts
    // CRITICAL ORDER INVARIANT: This MUST happen BEFORE INSERT
    const postProcessResult = await this.postProcessorService.process({
      draftContent,
      conversationId: dto.conversation_id,
      relationshipStage,
      surfacedMemoryIds,
      userMessage: dto.user_message,
      isRetention: false, // Normal chat, not retention
      pipeline: routingDecision.pipeline,
    });

    // Use post-processed content and opener_norm for storage
    // Also use the potentially reduced surfacedMemoryIds (per AI_PIPELINE.md §10.1)
    const assistantContent = postProcessResult.content;
    const openerNorm = postProcessResult.openerNorm;
    surfacedMemoryIds = postProcessResult.surfacedMemoryIds;

    // Execute in transaction per AI_PIPELINE.md §4.1.2 Technical Implementation Note
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. INSERT user message with status RECEIVED
      await tx.message.create({
        data: {
          id: dto.message_id,
          conversationId: dto.conversation_id,
          userId,
          aiFriendId: conversation.aiFriendId,
          role: 'user',
          content: dto.user_message,
          status: 'RECEIVED',
          source: 'chat',
          traceId,
          surfacedMemoryIds: [],
          extractedMemoryCandidateIds: [], // Will be updated after extraction
        },
      });

      // 2. If ONBOARDING, transition to ACTIVE
      let newState = userState;
      if (isOnboarding) {
        await tx.user.update({
          where: { id: userId },
          data: { state: UserState.ACTIVE },
        });
        newState = UserState.ACTIVE;

        // Update relationship last_interaction_at per AI_PIPELINE.md §4.1.2
        await tx.relationship.updateMany({
          where: {
            userId,
            aiFriendId: conversation.aiFriendId,
          },
          data: {
            lastInteractionAt: new Date(),
          },
        });
      }

      // 3. INSERT assistant message (SPEC_PATCH: NEW row, not update)
      // Q11: surfacedMemoryIds is now populated from memory surfacing
      // Q12: opener_norm is computed by PostProcessor per AI_PIPELINE.md §10.2
      const assistantMessage = await tx.message.create({
        data: {
          id: assistantMessageId,
          conversationId: dto.conversation_id,
          userId,
          aiFriendId: conversation.aiFriendId,
          role: 'assistant',
          content: assistantContent,
          status: 'COMPLETED',
          source: 'chat',
          traceId, // Same trace_id as user message per SPEC_PATCH
          surfacedMemoryIds, // Q11: Populated from memory surfacing
          extractedMemoryCandidateIds: [],
          openerNorm, // Q12: Per AI_PIPELINE.md §10.2
        },
      });

      // 4. Update user message status to COMPLETED
      await tx.message.update({
        where: { id: dto.message_id },
        data: { status: 'COMPLETED' },
      });

      return {
        newState,
        assistantMessage,
      };
    });

    // Q11: Memory extraction AFTER transaction (per SPEC_PATCH.md)
    // Per AI_PIPELINE.md §12.2: "Run heuristic extractor always"
    // Only extract if memory_write_policy is SELECTIVE
    if (routingDecision.memory_write_policy === 'SELECTIVE') {
      const extractedIds = await this.memoryService.extractAndPersist({
        userId,
        aiFriendId: conversation.aiFriendId,
        messageId: dto.message_id,
        userMessage: dto.user_message,
        normNoPunct,
        heuristicFlags,
      });

      // Update user message with extracted memory IDs
      if (extractedIds.length > 0) {
        await this.prisma.message.update({
          where: { id: dto.message_id },
          data: { extractedMemoryCandidateIds: extractedIds },
        });
      }
    }

    // Q14: Relationship update per AI_PIPELINE.md §11
    // Only update if relationship_update_policy is 'ON'
    if (routingDecision.relationship_update_policy === 'ON') {
      // Check if the previous AI message was a question (for meaningful response detection)
      const wasAiQuestion = await this.relationshipService.wasLastAiMessageQuestion(dto.conversation_id);
      
      await this.relationshipService.updateAfterMessage({
        userId,
        aiFriendId: conversation.aiFriendId,
        userMessage: dto.user_message,
        heuristicFlags,
        wasAiQuestion,
      });
    }

    return {
      message_id: dto.message_id,
      user_state: result.newState,
      assistant_message: {
        id: result.assistantMessage.id,
        content: result.assistantMessage.content,
        created_at: result.assistantMessage.createdAt.toISOString(),
      },
    };
  }

  /**
   * Derive deterministic assistant message ID from user message_id.
   * 
   * [MINIMAL DEVIATION] Per task requirement 3a:
   * The spec does not specify the linkage mechanism, so we use SHA-256(namespace + message_id)
   * formatted as UUID to ensure the assistant message ID is deterministic and can be fetched on replay.
   */
  private deriveAssistantMessageId(userMessageId: string): string {
    const hash = createHash('sha256')
      .update(ASSISTANT_MSG_NAMESPACE + userMessageId)
      .digest('hex');
    
    // Format as UUID v4-like string (8-4-4-4-12 format)
    return [
      hash.substring(0, 8),
      hash.substring(8, 12),
      hash.substring(12, 16),
      hash.substring(16, 20),
      hash.substring(20, 32),
    ].join('-');
  }

  /**
   * Get recent conversation history for LLM context.
   * 
   * Per AI_PIPELINE.md §9: "Conversation recent turns"
   * 
   * @param conversationId - Conversation ID
   * @param limit - Maximum number of messages to fetch
   * @returns Array of recent messages with role and content
   */
  private async getRecentConversationHistory(
    conversationId: string,
    limit: number,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const messages = await this.prisma.message.findMany({
      where: {
        conversationId,
        status: 'COMPLETED',
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        role: true,
        content: true,
      },
    });

    // Reverse to get chronological order
    return messages.reverse().map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
  }

  /**
   * Parse stableStyleParams from JSON to typed object.
   * 
   * Per AI_PIPELINE.md §2.4: StableStyleParams structure
   * 
   * @param stableStyleParams - JSON value from database
   * @returns Parsed params or undefined
   */
  private parseStableStyleParams(
    stableStyleParams: Prisma.JsonValue | null | undefined,
  ): LlmGenerationContext['stableStyleParams'] | undefined {
    if (!stableStyleParams || typeof stableStyleParams !== 'object') {
      return undefined;
    }

    const params = stableStyleParams as Record<string, unknown>;
    
    return {
      msg_length_pref: params.msg_length_pref as 'short' | 'medium' | 'long' | undefined,
      emoji_freq: params.emoji_freq as 'none' | 'light' | 'frequent' | undefined,
      humor_mode: params.humor_mode as 'none' | 'light_sarcasm' | 'frequent_jokes' | 'deadpan' | undefined,
      directness_level: params.directness_level as 'soft' | 'balanced' | 'blunt' | undefined,
      followup_question_rate: params.followup_question_rate as 'low' | 'medium' | undefined,
      lexicon_bias: params.lexicon_bias as 'clean' | 'slang' | 'internet_shorthand' | undefined,
    };
  }

  /**
   * Validate ChatRequestDto fields.
   */
  private validateChatRequest(dto: ChatRequestDto): void {
    const errors: string[] = [];

    if (!dto.message_id || typeof dto.message_id !== 'string') {
      errors.push('message_id is required and must be a string');
    } else if (!this.isValidUUID(dto.message_id)) {
      errors.push('message_id must be a valid UUID');
    }

    if (!dto.conversation_id || typeof dto.conversation_id !== 'string') {
      errors.push('conversation_id is required and must be a string');
    } else if (!this.isValidUUID(dto.conversation_id)) {
      errors.push('conversation_id must be a valid UUID');
    }

    if (!dto.user_message || typeof dto.user_message !== 'string') {
      errors.push('user_message is required and must be a string');
    } else if (dto.user_message.length > 4000) {
      errors.push('user_message must not exceed 4000 characters');
    }

    if (!dto.local_timestamp || typeof dto.local_timestamp !== 'string') {
      errors.push('local_timestamp is required and must be a string');
    }

    if (!dto.user_timezone || typeof dto.user_timezone !== 'string') {
      errors.push('user_timezone is required and must be a string');
    }

    if (errors.length > 0) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Validation failed',
        error: 'Bad Request',
        constraints: errors,
      } as ApiErrorDto);
    }
  }

  /**
   * Simple UUID validation.
   */
  private isValidUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }

  /**
   * GET /chat/history
   * 
   * Per API_CONTRACT.md §5: Returns paginated chat history for a conversation.
   * 
   * @param userId - Authenticated user ID
   * @param dto - GetHistoryRequestDto with conversation_id, optional before_timestamp and limit
   * @returns HistoryResponseDto with messages array
   */
  async getHistory(
    userId: string,
    dto: GetHistoryRequestDto,
  ): Promise<HistoryResponseDto> {
    const { conversation_id, before_timestamp, limit = 50 } = dto;

    // Validate conversation belongs to user
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversation_id },
      select: { userId: true },
    });

    if (!conversation || conversation.userId !== userId) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Invalid conversation_id',
        error: 'Bad Request',
      } as ApiErrorDto);
    }

    // Build query conditions
    const whereConditions: Prisma.MessageWhereInput = {
      conversationId: conversation_id,
      status: 'COMPLETED',
    };

    // If before_timestamp provided, fetch messages older than that
    if (before_timestamp) {
      whereConditions.createdAt = {
        lt: new Date(before_timestamp),
      };
    }

    // Fetch messages
    const messages = await this.prisma.message.findMany({
      where: whereConditions,
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100), // Cap at 100 for safety
      select: {
        id: true,
        role: true,
        content: true,
        createdAt: true,
      },
    });

    // Reverse to get chronological order (oldest first)
    const chronologicalMessages = messages.reverse();

    return {
      messages: chronologicalMessages.map(m => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        created_at: m.createdAt.toISOString(),
      })),
    };
  }
}
