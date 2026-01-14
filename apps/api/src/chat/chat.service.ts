import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TraceService } from '../trace/trace.service';
import {
  ChatRequestDto,
  ChatResponseDto,
  UserState,
  ApiErrorDto,
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
 * [MINIMAL DEVIATION] Deterministic assistant message ID:
 * Uses SHA-256(namespace + message_id) formatted as UUID to derive assistant message ID.
 * The spec does not specify the linkage mechanism, so this is a safe deterministic choice.
 */

// Namespace for deterministic assistant message ID generation
// Per task requirement 3a: Define deterministic assistant message id derived from message_id
const ASSISTANT_MSG_NAMESPACE = 'chingoo-assistant-message-v1';

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private traceService: TraceService,
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
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: dto.conversation_id },
      include: {
        aiFriend: true,
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
    const isOnboarding = userState === UserState.ONBOARDING;
    if (isOnboarding) {
      await this.validateOnboardingRequirements(userId, conversation.aiFriend);
    }

    // Step 4: Process message in transaction
    const traceId = this.traceService.getTraceId() || crypto.randomUUID();
    const result = await this.processMessageTransaction(
      userId,
      userState,
      dto,
      conversation,
      traceId,
      isOnboarding,
    );

    return result;
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
    if (!aiFriend.personaTemplateId || !aiFriend.stableStyleParams) {
      throw new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        message: 'Onboarding incomplete: persona not assigned',
        error: 'Forbidden',
        constraints: ['persona_template_id', 'stable_style_params'],
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
   */
  private async processMessageTransaction(
    userId: string,
    userState: UserState,
    dto: ChatRequestDto,
    conversation: {
      id: string;
      aiFriendId: string;
      user: { id: string; state: string };
    },
    traceId: string,
    isOnboarding: boolean,
  ): Promise<ChatResponseDto> {
    // Derive deterministic assistant message ID
    // [MINIMAL DEVIATION] Per task requirement 3a: UUIDv5(namespace, message_id)
    const assistantMessageId = this.deriveAssistantMessageId(dto.message_id);

    // Generate AI response (stub for now - full pipeline would go through orchestrator)
    const assistantContent = this.generateAssistantResponse(dto.user_message, isOnboarding);

    // Execute in transaction per AI_PIPELINE.md §4.1.2 Technical Implementation Note
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. INSERT user message with status RECEIVED, then update to COMPLETED
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
          extractedMemoryCandidateIds: [],
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
          surfacedMemoryIds: [], // Empty for now per task requirement
          extractedMemoryCandidateIds: [],
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
   * Generate AI assistant response.
   * 
   * NOTE: This is a stub implementation for v0.1.
   * Full implementation would route through:
   * - RouterService.route(turnPacket) → RoutingDecision
   * - OrchestratorService.execute(turnPacket, routingDecision)
   * Per ARCHITECTURE.md §A.2.1
   */
  private generateAssistantResponse(userMessage: string, isFirstMessage: boolean): string {
    // Stub response for v0.1 - actual LLM integration would happen here
    if (isFirstMessage) {
      return "Hey! It's great to meet you. I'm really happy you're here. What's on your mind?";
    }
    return "I hear you! Tell me more about that.";
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
}
