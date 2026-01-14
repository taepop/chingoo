import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HeuristicFlags } from '../router/router.service';
import { TopicMatchResult } from '../topicmatch/topicmatch.service';

/**
 * Memory types per AI_PIPELINE.md §12.1
 */
export type MemoryType = 'FACT' | 'PREFERENCE' | 'RELATIONSHIP_EVENT' | 'EMOTIONAL_PATTERN';

/**
 * MemoryCandidate - extracted memory before persistence
 * 
 * Per AI_PIPELINE.md §2.6:
 * - type = FACT | PREFERENCE | RELATIONSHIP_EVENT | EMOTIONAL_PATTERN
 * - memory_key (string; canonical per §12.3.1)
 * - memory_value (string; canonical)
 * - confidence (float 0.0–1.0)
 */
export interface MemoryCandidate {
  type: MemoryType;
  memoryKey: string;
  memoryValue: string;
  confidence: number;
}

/**
 * CorrectionResult - result of correction handling
 */
export interface CorrectionResult {
  invalidated_memory_ids: string[];
  needs_clarification: boolean;
  suppressed_keys_added: string[];
}

/**
 * Input for memory extraction
 */
export interface ExtractionInput {
  userMessage: string;
  normNoPunct: string;
  heuristicFlags: HeuristicFlags;
}

/**
 * Input for correction handling
 */
export interface CorrectionInput {
  userId: string;
  aiFriendId: string;
  conversationId: string;
  normNoPunct: string;
  heuristicFlags: HeuristicFlags;
}

/**
 * Input for memory surfacing selection
 */
export interface SurfacingInput {
  userId: string;
  aiFriendId: string;
  userMessage: string;
  topicMatches: TopicMatchResult[];
}

/**
 * Input for persisting a memory candidate
 */
export interface PersistInput {
  userId: string;
  aiFriendId: string;
  messageId: string;
  candidate: MemoryCandidate;
}

/**
 * MemoryService
 * 
 * Implements Memory MVP per AI_PIPELINE.md §12:
 * - Heuristic extraction (no LLM)
 * - Dedup/conflict handling
 * - Correction targeting (surfaced-only safety)
 * - Memory surfacing for assistant messages
 * 
 * CRITICAL: This service is DETERMINISTIC for extraction.
 * No LLM calls, no randomness, no external services.
 * 
 * Per AI_PIPELINE.md §12.4 - Correction Targeting (Authoritative):
 * "A correction command MUST target memories ONLY through surfaced_memory_ids
 * from the immediately previous assistant message."
 */
@Injectable()
export class MemoryService {
  // Confidence initialization per AI_PIPELINE.md §12.3
  private readonly HEURISTIC_CONFIDENCE = 0.60;
  private readonly CONFIDENCE_INCREMENT = 0.15;
  private readonly MAX_CONFIDENCE = 1.0;

  // Preference patterns per AI_PIPELINE.md §5
  private readonly preferencePatterns = {
    like: ['i like', 'i love', 'my favorite'],
    dislike: ['i hate', 'i dislike'],
  };

  // Fact patterns per AI_PIPELINE.md §5
  private readonly factPatterns = {
    home_country: ["i'm from", "im from"],
    current_city: ['i live in'],
    occupation: ['my job is', "i'm a", "im a", 'i work as'],
    school: ['i study at', 'i go to', 'my school'],
    major: ['i major in', 'my major is', 'studying'],
  };

  // Food-related keywords for preference categorization
  private readonly foodKeywords = [
    'pizza', 'sushi', 'burger', 'pasta', 'ramen', 'korean food', 'chinese food',
    'mexican food', 'thai food', 'indian food', 'breakfast', 'lunch', 'dinner',
    'coffee', 'tea', 'boba', 'ice cream', 'chocolate', 'cake', 'fruit', 'vegetable',
  ];

  // Correction trigger patterns per AI_PIPELINE.md §12.4
  private readonly correctionPatterns = {
    invalidate: [
      "that's not true", "thats not true", "not true", "wrong",
      "don't remember that", "dont remember that", "forget that",
    ],
    suppress_topic: [
      "don't bring this topic up again", "dont bring this topic up again",
      "don't mention", "dont mention",
    ],
  };

  constructor(private prisma: PrismaService) {}

  /**
   * Extract memory candidates from user message using HEURISTICS ONLY.
   * 
   * Per AI_PIPELINE.md §12.2:
   * "Run heuristic extractor always."
   * 
   * Per task requirement:
   * "Determinism: Do NOT call any LLM or external service for memory extraction."
   * 
   * @param input - User message and heuristic flags
   * @returns Array of memory candidates
   */
  extractMemoryCandidates(input: ExtractionInput): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];
    const textLower = input.normNoPunct.toLowerCase();

    // Extract preferences if trigger detected
    if (input.heuristicFlags.has_preference_trigger) {
      const prefCandidates = this.extractPreferences(textLower, input.userMessage);
      candidates.push(...prefCandidates);
    }

    // Extract facts if trigger detected
    if (input.heuristicFlags.has_fact_trigger) {
      const factCandidates = this.extractFacts(textLower, input.userMessage);
      candidates.push(...factCandidates);
    }

    // Extract events if trigger detected (basic implementation for v0.1)
    if (input.heuristicFlags.has_event_trigger) {
      const eventCandidates = this.extractEvents(textLower, input.userMessage);
      candidates.push(...eventCandidates);
    }

    return candidates;
  }

  /**
   * Extract PREFERENCE memories from text.
   * 
   * Per AI_PIPELINE.md §12.3.1:
   * Format: pref:<category>:<item_slug>
   * Categories (v0.1): food, drink, music, movie_genre, game, sport, hobby, study_style
   * 
   * Per AI_PIPELINE.md §12.3.2:
   * "PREFERENCE memory_value MUST be like|<value> or dislike|<value>."
   */
  private extractPreferences(textLower: string, originalMessage: string): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];

    // Check for "like" patterns
    for (const pattern of this.preferencePatterns.like) {
      const patternIndex = textLower.indexOf(pattern);
      if (patternIndex !== -1) {
        // Extract what comes after the pattern
        const afterPattern = textLower.substring(patternIndex + pattern.length).trim();
        const item = this.extractFirstItem(afterPattern);
        if (item) {
          const category = this.categorizeItem(item);
          const slug = this.slugify(item);
          candidates.push({
            type: 'PREFERENCE',
            memoryKey: `pref:${category}:${slug}`,
            memoryValue: `like|${item}`,
            confidence: this.HEURISTIC_CONFIDENCE,
          });
        }
        break; // Only extract one preference per pattern type
      }
    }

    // Check for "dislike" patterns
    for (const pattern of this.preferencePatterns.dislike) {
      const patternIndex = textLower.indexOf(pattern);
      if (patternIndex !== -1) {
        const afterPattern = textLower.substring(patternIndex + pattern.length).trim();
        const item = this.extractFirstItem(afterPattern);
        if (item) {
          const category = this.categorizeItem(item);
          const slug = this.slugify(item);
          candidates.push({
            type: 'PREFERENCE',
            memoryKey: `pref:${category}:${slug}`,
            memoryValue: `dislike|${item}`,
            confidence: this.HEURISTIC_CONFIDENCE,
          });
        }
        break;
      }
    }

    return candidates;
  }

  /**
   * Extract FACT memories from text.
   * 
   * Per AI_PIPELINE.md §12.3.1:
   * FACT keys: fact:home_country, fact:home_city, fact:current_city, 
   * fact:timezone, fact:occupation, fact:school, fact:major, fact:language_primary
   */
  private extractFacts(textLower: string, originalMessage: string): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];

    // Check for home_country patterns
    for (const pattern of this.factPatterns.home_country) {
      const patternIndex = textLower.indexOf(pattern);
      if (patternIndex !== -1) {
        const afterPattern = textLower.substring(patternIndex + pattern.length).trim();
        const value = this.extractFirstItem(afterPattern);
        if (value) {
          candidates.push({
            type: 'FACT',
            memoryKey: 'fact:home_country',
            memoryValue: value,
            confidence: this.HEURISTIC_CONFIDENCE,
          });
        }
        break;
      }
    }

    // Check for current_city patterns
    for (const pattern of this.factPatterns.current_city) {
      const patternIndex = textLower.indexOf(pattern);
      if (patternIndex !== -1) {
        const afterPattern = textLower.substring(patternIndex + pattern.length).trim();
        const value = this.extractFirstItem(afterPattern);
        if (value) {
          candidates.push({
            type: 'FACT',
            memoryKey: 'fact:current_city',
            memoryValue: value,
            confidence: this.HEURISTIC_CONFIDENCE,
          });
        }
        break;
      }
    }

    // Check for occupation patterns
    for (const pattern of this.factPatterns.occupation) {
      const patternIndex = textLower.indexOf(pattern);
      if (patternIndex !== -1) {
        const afterPattern = textLower.substring(patternIndex + pattern.length).trim();
        const value = this.extractFirstItem(afterPattern);
        if (value) {
          candidates.push({
            type: 'FACT',
            memoryKey: 'fact:occupation',
            memoryValue: value,
            confidence: this.HEURISTIC_CONFIDENCE,
          });
        }
        break;
      }
    }

    return candidates;
  }

  /**
   * Extract RELATIONSHIP_EVENT memories from text.
   * Basic implementation for v0.1 - minimal event detection.
   * 
   * Per AI_PIPELINE.md §12.3.1:
   * Format: event:<domain>:<yyyy_mm>:<event_slug>
   * Domains (v0.1): school, work, travel, relationship, family, health, other
   */
  private extractEvents(textLower: string, originalMessage: string): MemoryCandidate[] {
    // Basic implementation - not fully extracting events in v0.1
    // Full event extraction would require more complex parsing
    return [];
  }

  /**
   * Extract the first meaningful item/noun from text.
   * Simple extraction - takes words until a sentence boundary or common stop words.
   */
  private extractFirstItem(text: string): string | null {
    // Remove leading punctuation and extra spaces
    const cleaned = text.replace(/^[\s,.:;]+/, '').trim();
    
    // Stop words that indicate end of item
    const stopWords = ['and', 'but', 'because', 'so', 'when', 'if', 'or', 'is', 'are', 'was', 'were'];
    
    // Split by spaces and take words until stop word or punctuation
    const words = cleaned.split(/\s+/);
    const itemWords: string[] = [];
    
    for (const word of words) {
      const cleanWord = word.replace(/[.,!?;:]$/, '').toLowerCase();
      if (stopWords.includes(cleanWord) || word.match(/[.,!?;:]$/)) {
        break;
      }
      itemWords.push(cleanWord);
      // Limit to 3 words for item extraction
      if (itemWords.length >= 3) {
        break;
      }
    }
    
    const item = itemWords.join(' ').trim();
    return item.length > 0 ? item : null;
  }

  /**
   * Categorize an item into preference categories.
   * Per AI_PIPELINE.md §12.3.1:
   * Categories (v0.1): food, drink, music, movie_genre, game, sport, hobby, study_style
   */
  private categorizeItem(item: string): string {
    const itemLower = item.toLowerCase();
    
    // Check for food keywords
    if (this.foodKeywords.some(kw => itemLower.includes(kw) || kw.includes(itemLower))) {
      return 'food';
    }
    
    // Check for drink keywords
    if (['coffee', 'tea', 'boba', 'drink', 'soda', 'juice'].some(kw => itemLower.includes(kw))) {
      return 'drink';
    }
    
    // Check for music keywords
    if (['song', 'music', 'band', 'kpop', 'rock', 'pop', 'jazz', 'hip hop'].some(kw => itemLower.includes(kw))) {
      return 'music';
    }
    
    // Check for game keywords
    if (['game', 'playing', 'fps', 'mmorpg', 'valorant', 'lol', 'minecraft'].some(kw => itemLower.includes(kw))) {
      return 'game';
    }
    
    // Default to hobby
    return 'hobby';
  }

  /**
   * Slugify an item per AI_PIPELINE.md §12.3.1:
   * - Unicode NFKC, trim
   * - replace spaces with underscores
   * - remove punctuation except underscores
   * - keep non-Latin characters (do NOT romanize)
   * - max length 48 chars; truncate deterministically
   */
  private slugify(item: string): string {
    let slug = item
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^\w가-힣ㄱ-ㅎㅏ-ㅣ_]/g, '')
      .toLowerCase();
    
    // Truncate to 48 chars
    if (slug.length > 48) {
      slug = slug.substring(0, 48);
    }
    
    return slug;
  }

  /**
   * Handle user correction command.
   * 
   * Per AI_PIPELINE.md §12.4 - Correction Targeting (Authoritative, v0.1):
   * "A correction command MUST target memories ONLY through surfaced_memory_ids
   * from the immediately previous assistant message."
   * "If surfaced_memory_ids is empty: do NOT invalidate anything"
   * 
   * @param input - Correction handling input
   * @returns CorrectionResult with invalidated memory IDs
   */
  async handleCorrection(input: CorrectionInput): Promise<CorrectionResult> {
    const result: CorrectionResult = {
      invalidated_memory_ids: [],
      needs_clarification: false,
      suppressed_keys_added: [],
    };

    // Only process if correction trigger detected
    if (!input.heuristicFlags.has_correction_trigger) {
      return result;
    }

    // Step 1: Find the immediately previous assistant message
    // Per AI_PIPELINE.md §12.4: "from the immediately previous assistant message"
    const prevAssistantMsg = await this.prisma.message.findFirst({
      where: {
        conversationId: input.conversationId,
        role: 'assistant',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        surfacedMemoryIds: true,
      },
    });

    // If no previous assistant message, need clarification
    if (!prevAssistantMsg) {
      result.needs_clarification = true;
      return result;
    }

    // Get surfaced_memory_ids from previous assistant message
    const surfacedIds = (prevAssistantMsg.surfacedMemoryIds as string[]) || [];

    // Per AI_PIPELINE.md §12.4:
    // "If surfaced_memory_ids is empty: do NOT invalidate anything"
    if (surfacedIds.length === 0) {
      result.needs_clarification = true;
      return result;
    }

    // Determine correction type
    const textLower = input.normNoPunct.toLowerCase();
    const isInvalidation = this.correctionPatterns.invalidate.some(p => textLower.includes(p));
    const isTopicSuppression = this.correctionPatterns.suppress_topic.some(p => textLower.includes(p));

    if (isInvalidation) {
      // Per AI_PIPELINE.md §12.4:
      // "Target = the LAST memory_id in surfaced_memory_ids (most recent mention)"
      const targetMemoryId = surfacedIds[surfacedIds.length - 1];

      // Fetch the memory to get its key
      const memories = await this.prisma.memory.findMany({
        where: {
          id: { in: [targetMemoryId] },
          status: 'ACTIVE',
        },
      });

      if (memories.length > 0) {
        const memory = memories[0];

        // Invalidate the memory
        await this.prisma.memory.update({
          where: { id: targetMemoryId },
          data: {
            status: 'INVALID',
            invalidReason: 'user_correction',
          },
        });

        result.invalidated_memory_ids.push(targetMemoryId);

        // If "don't remember that" / "forget that", also add to suppressed_memory_keys
        if (textLower.includes('remember') || textLower.includes('forget')) {
          await this.addToSuppressedMemoryKeys(input.userId, memory.memoryKey);
          result.suppressed_keys_added.push(memory.memoryKey);
        }
      }
    }

    return result;
  }

  /**
   * Add a memory key to user's suppressed_memory_keys.
   * 
   * Per AI_PIPELINE.md §12.4:
   * "add its memory_key to UserControls.suppressed_memory_keys"
   */
  private async addToSuppressedMemoryKeys(userId: string, memoryKey: string): Promise<void> {
    const userControls = await this.prisma.userControls.findUnique({
      where: { userId },
      select: { suppressedMemoryKeys: true },
    });

    const currentKeys = (userControls?.suppressedMemoryKeys as string[]) || [];
    
    if (!currentKeys.includes(memoryKey)) {
      await this.prisma.userControls.update({
        where: { userId },
        data: {
          suppressedMemoryKeys: [...currentKeys, memoryKey],
        },
      });
    }
  }

  /**
   * Select which memories to surface for the assistant response.
   * 
   * Per AI_PIPELINE.md §12.4:
   * "Each assistant message must store surfaced_memory_ids
   * (memory IDs actually referenced or used in the answer)."
   * 
   * For v0.1 MVP: Simple relevance matching based on user message keywords.
   * Full implementation would integrate with LLM response generation.
   * 
   * @param input - Surfacing selection input
   * @returns Array of memory IDs to surface (empty array if none relevant)
   */
  async selectMemoriesForSurfacing(input: SurfacingInput): Promise<string[]> {
    // Fetch ACTIVE memories for the user (excluding suppressed keys)
    const userControls = await this.prisma.userControls.findUnique({
      where: { userId: input.userId },
      select: { suppressedMemoryKeys: true },
    });
    
    const suppressedKeys = (userControls?.suppressedMemoryKeys as string[]) || [];

    const memories = await this.prisma.memory.findMany({
      where: {
        userId: input.userId,
        aiFriendId: input.aiFriendId,
        status: 'ACTIVE',
        memoryKey: {
          notIn: suppressedKeys.length > 0 ? suppressedKeys : undefined,
        },
      },
      select: {
        id: true,
        memoryKey: true,
        memoryValue: true,
        type: true,
      },
    });

    // For v0.1 MVP: Simple keyword matching
    // Return empty array if no memories (must be [] not null per task requirement)
    if (memories.length === 0) {
      return [];
    }

    // Simple relevance check: look for keyword matches in user message
    const userMsgLower = input.userMessage.toLowerCase();
    const relevantIds: string[] = [];

    for (const memory of memories) {
      // Extract item from memory key/value for matching
      const valueParts = memory.memoryValue.split('|');
      const item = valueParts.length > 1 ? valueParts[1] : memory.memoryValue;
      
      // Check if user message mentions this item
      if (item && userMsgLower.includes(item.toLowerCase())) {
        relevantIds.push(memory.id);
      }
    }

    // Per AI_PIPELINE.md §10.1:
    // "In normal chat: if personal_fact_count > 2... rewrite to reduce surfaced_memory_ids to at most 2"
    // For v0.1, limit to 2 surfaced memories max
    return relevantIds.slice(0, 2);
  }

  /**
   * Persist a memory candidate with dedup/conflict handling.
   * 
   * Per AI_PIPELINE.md §12.3:
   * - if key exists with same value (ACTIVE): merge sources; increase confidence by +0.15 (cap 1.0)
   * - if key exists with different value (ACTIVE): create new ACTIVE record, mark old as SUPERSEDED
   * 
   * @param input - Persist input with candidate and context
   * @returns Created or updated memory ID
   */
  async persistMemoryCandidate(input: PersistInput): Promise<string> {
    const { userId, aiFriendId, messageId, candidate } = input;

    // Check for existing memory with same key
    const existingMemory = await this.prisma.memory.findFirst({
      where: {
        userId,
        aiFriendId,
        memoryKey: candidate.memoryKey,
        status: 'ACTIVE',
      },
    });

    if (existingMemory) {
      // Same key exists - check if same value
      if (existingMemory.memoryValue === candidate.memoryValue) {
        // Same key + same value → merge sources, increase confidence
        const newConfidence = Math.min(
          Number(existingMemory.confidence) + this.CONFIDENCE_INCREMENT,
          this.MAX_CONFIDENCE,
        );

        const sourceIds = (existingMemory.sourceMessageIds as string[]) || [];
        if (!sourceIds.includes(messageId)) {
          sourceIds.push(messageId);
        }

        await this.prisma.memory.update({
          where: { id: existingMemory.id },
          data: {
            confidence: newConfidence,
            sourceMessageIds: sourceIds,
            lastConfirmedAt: new Date(),
          },
        });

        return existingMemory.id;
      } else {
        // Same key + different value
        // For FACT keys: supersede old
        // For PREFERENCE keys with opposite stance: supersede old
        if (candidate.type === 'FACT' || this.isOppositeStance(existingMemory.memoryValue, candidate.memoryValue)) {
          // Create new memory
          const newMemory = await this.prisma.memory.create({
            data: {
              userId,
              aiFriendId,
              type: candidate.type,
              memoryKey: candidate.memoryKey,
              memoryValue: candidate.memoryValue,
              confidence: candidate.confidence,
              status: 'ACTIVE',
              sourceMessageIds: [messageId],
            },
          });

          // Mark old as SUPERSEDED
          await this.prisma.memory.update({
            where: { id: existingMemory.id },
            data: {
              status: 'SUPERSEDED',
              supersededBy: newMemory.id,
            },
          });

          return newMemory.id;
        }
      }
    }

    // No existing memory - create new
    const newMemory = await this.prisma.memory.create({
      data: {
        userId,
        aiFriendId,
        type: candidate.type,
        memoryKey: candidate.memoryKey,
        memoryValue: candidate.memoryValue,
        confidence: candidate.confidence,
        status: 'ACTIVE',
        sourceMessageIds: [messageId],
      },
    });

    return newMemory.id;
  }

  /**
   * Check if two preference values have opposite stances.
   * Per AI_PIPELINE.md §12.3.2:
   * "PREFERENCE memory_value MUST be like|<value> or dislike|<value>"
   */
  private isOppositeStance(value1: string, value2: string): boolean {
    const stance1 = value1.startsWith('like|') ? 'like' : value1.startsWith('dislike|') ? 'dislike' : null;
    const stance2 = value2.startsWith('like|') ? 'like' : value2.startsWith('dislike|') ? 'dislike' : null;

    if (!stance1 || !stance2) {
      return false;
    }

    return stance1 !== stance2;
  }

  /**
   * Extract and persist all memory candidates from a user message.
   * This is the main entry point for memory extraction in the chat pipeline.
   * 
   * @param params - Extraction parameters
   * @returns Array of extracted memory IDs
   */
  async extractAndPersist(params: {
    userId: string;
    aiFriendId: string;
    messageId: string;
    userMessage: string;
    normNoPunct: string;
    heuristicFlags: HeuristicFlags;
  }): Promise<string[]> {
    const candidates = this.extractMemoryCandidates({
      userMessage: params.userMessage,
      normNoPunct: params.normNoPunct,
      heuristicFlags: params.heuristicFlags,
    });

    const extractedIds: string[] = [];

    for (const candidate of candidates) {
      const memoryId = await this.persistMemoryCandidate({
        userId: params.userId,
        aiFriendId: params.aiFriendId,
        messageId: params.messageId,
        candidate,
      });
      extractedIds.push(memoryId);
    }

    return extractedIds;
  }
}
