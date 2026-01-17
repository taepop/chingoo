import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HeuristicFlags } from '../router/router.service';
import { RelationshipStage, Prisma } from '@prisma/client';

/**
 * Evidence detected from user message
 * Per AI_PIPELINE.md §11.2
 */
export interface EvidenceResult {
  preferenceShareCount: number;       // Number of preferences detected
  isMeaningfulResponse: boolean;      // ≥10 tokens and not disengaged
  hasEmotionalDisclosure: boolean;    // High intensity emotion
  referencesPastConversation: boolean; // References past chat
  isDisengaged: boolean;              // Short reply (<4 tokens or generic)
}

/**
 * Input for relationship update
 */
export interface RelationshipUpdateInput {
  userId: string;
  aiFriendId: string;
  userMessage: string;
  heuristicFlags: HeuristicFlags;
  wasAiQuestion: boolean;  // Whether previous AI message was a question
}

/**
 * Result of relationship update
 */
export interface RelationshipUpdateResult {
  delta: number;
  newRapportScore: number;
  oldRapportScore: number;
  newStage: RelationshipStage;
  oldStage: RelationshipStage;
  wasPromoted: boolean;
  isNewSession: boolean;
  evidence: EvidenceResult;
}

/**
 * Stage thresholds per PRODUCT.md §7.2
 */
const STAGE_THRESHOLDS: Record<RelationshipStage, number> = {
  STRANGER: 0,
  ACQUAINTANCE: 15,
  FRIEND: 40,
  CLOSE_FRIEND: 75,
};

/**
 * Session gap threshold in milliseconds (4 hours)
 * Per AI_PIPELINE.md §11.1
 */
const SESSION_GAP_MS = 4 * 60 * 60 * 1000;

/**
 * Disengaged reply patterns
 * Per AI_PIPELINE.md §11.2
 */
const DISENGAGED_REPLIES = ['k', 'ok', 'okay', 'idk', 'lol', 'sure', 'yeah', 'yea', 'yep', 'nope', 'mhm', 'hmm'];

/**
 * Past reference keywords
 * Per AI_PIPELINE.md §11.2
 */
const PAST_REFERENCE_PATTERNS = [
  'remember',
  'like we said',
  'last time',
  'you mentioned',
  'we talked about',
  'you told me',
  'earlier you',
  'before you said',
  'as you said',
];

/**
 * Emotional disclosure indicators
 * Per AI_PIPELINE.md §11.2
 */
const EMOTIONAL_DISCLOSURE_PATTERNS = [
  // Sadness
  'i feel sad', 'i\'m sad', 'im sad', 'feeling down', 'i\'m depressed', 'im depressed',
  'i feel empty', 'i\'m lonely', 'im lonely', 'i feel alone',
  // Anxiety
  'i\'m anxious', 'im anxious', 'i\'m worried', 'im worried', 'i\'m scared', 'im scared',
  'i\'m panicking', 'im panicking', 'anxiety', 'panic attack',
  // Stress
  'i\'m stressed', 'im stressed', 'so stressed', 'overwhelmed', 'can\'t cope',
  // Joy (high intensity positive)
  'i\'m so happy', 'im so happy', 'i\'m thrilled', 'im thrilled', 'best day',
  'i\'m ecstatic', 'im ecstatic', 'over the moon',
  // Anger
  'i\'m furious', 'im furious', 'so angry', 'i hate', 'i\'m pissed', 'im pissed',
  // Korean emotional terms
  '우울', '불안', '외로워', '힘들어', '스트레스', '행복해', '화나',
];

/**
 * RelationshipService
 * 
 * Implements AI_PIPELINE.md §11 - Stage G — Relationship Update
 * 
 * Responsibilities:
 * - Session accounting (§11.1)
 * - Evidence detection (§11.2)
 * - Score update with clamping (§11.3)
 * - Stage promotion checks
 * 
 * CRITICAL: Evidence detectors must be deterministic.
 */
@Injectable()
export class RelationshipService {
  constructor(private prisma: PrismaService) {}

  /**
   * Update relationship after processing a user message.
   * Per AI_PIPELINE.md §11
   * 
   * @param input - Relationship update input
   * @returns RelationshipUpdateResult with delta, scores, and stage info
   */
  async updateAfterMessage(
    input: RelationshipUpdateInput,
  ): Promise<RelationshipUpdateResult> {
    const { userId, aiFriendId, userMessage, heuristicFlags, wasAiQuestion } = input;

    // 1. Fetch current relationship state
    const relationship = await this.prisma.relationship.findUnique({
      where: {
        userId_aiFriendId: { userId, aiFriendId },
      },
    });

    if (!relationship) {
      throw new Error(`Relationship not found for user ${userId} and aiFriend ${aiFriendId}`);
    }

    const now = new Date();
    const oldRapportScore = relationship.rapportScore;
    const oldStage = relationship.relationshipStage;

    // 2. Session accounting per §11.1
    const lastInteractionAt = relationship.lastInteractionAt;
    const timeSinceLastInteraction = now.getTime() - lastInteractionAt.getTime();
    const isNewSession = timeSinceLastInteraction > SESSION_GAP_MS;

    // Reset short reply count on new session
    let currentSessionShortReplyCount = isNewSession 
      ? 0 
      : relationship.currentSessionShortReplyCount;

    // 3. Detect evidence per §11.2
    const evidence = this.detectEvidence(userMessage, heuristicFlags, wasAiQuestion);

    // Track disengaged replies in session
    if (evidence.isDisengaged) {
      currentSessionShortReplyCount++;
    }

    // 4. Compute delta per §11.3
    let delta = 0;

    // Positive evidence (can stack)
    if (evidence.preferenceShareCount >= 2) {
      delta += 2;  // ≥2 distinct preferences: +2 (instead of +1)
    } else if (evidence.preferenceShareCount >= 1) {
      delta += 1;  // ≥1 preference: +1
    }

    if (evidence.isMeaningfulResponse) {
      delta += 1;  // Meaningful response to AI question: +1
    }

    if (evidence.hasEmotionalDisclosure) {
      delta += 4;  // Emotional disclosure: +4
    }

    if (evidence.referencesPastConversation) {
      delta += 4;  // References past conversation: +4
    }

    // Negative evidence
    if (currentSessionShortReplyCount >= 3) {
      delta -= 2;  // ≥3 short replies in session: -2
    }

    // Clamp per-message delta to [-2, +5]
    delta = Math.max(-2, Math.min(5, delta));

    // Apply delta and clamp rapport_score to [0, 100]
    let newRapportScore = Math.max(0, Math.min(100, oldRapportScore + delta));

    // 5. Check stage promotion
    const newStage = this.computeStage(newRapportScore);
    const wasPromoted = this.stageToNumber(newStage) > this.stageToNumber(oldStage);

    // 6. Update relationship in database
    const updateData: Prisma.RelationshipUpdateInput = {
      rapportScore: newRapportScore,
      relationshipStage: newStage,
      lastInteractionAt: now,
      currentSessionShortReplyCount,
    };

    if (isNewSession) {
      updateData.sessionsCount = { increment: 1 };
      updateData.lastSessionAt = now;
    }

    if (wasPromoted) {
      updateData.lastStagePromotionAt = now;
    }

    await this.prisma.relationship.update({
      where: {
        userId_aiFriendId: { userId, aiFriendId },
      },
      data: updateData,
    });

    return {
      delta,
      newRapportScore,
      oldRapportScore,
      newStage,
      oldStage,
      wasPromoted,
      isNewSession,
      evidence,
    };
  }

  /**
   * Detect evidence from user message.
   * Per AI_PIPELINE.md §11.2
   * 
   * Evidence detectors (cheap-first):
   * - preference share: matched by heuristics or extractor output
   * - meaningful response: user reply ≥ 10 tokens and not in disengaged list
   * - emotional disclosure: emotion analyzer high intensity
   * - past reference: phrases like "remember", "like we said", "last time"
   */
  private detectEvidence(
    userMessage: string,
    heuristicFlags: HeuristicFlags,
    wasAiQuestion: boolean,
  ): EvidenceResult {
    const normalized = userMessage.toLowerCase().trim();
    const tokens = this.tokenize(userMessage);
    const tokenCount = tokens.length;

    // 1. Preference share detection
    // Use heuristic flags from router (already computed)
    let preferenceShareCount = 0;
    if (heuristicFlags.has_preference_trigger) {
      // Count preference indicators in message
      preferenceShareCount = this.countPreferenceIndicators(normalized);
    }

    // 2. Disengaged detection per §11.2
    // short replies <4 tokens OR exactly matches disengaged list
    const isDisengaged = tokenCount < 4 || DISENGAGED_REPLIES.includes(normalized);

    // 3. Meaningful response detection
    // ≥10 tokens AND not disengaged AND was responding to AI question
    const isMeaningfulResponse = wasAiQuestion && tokenCount >= 10 && !isDisengaged;

    // 4. Emotional disclosure detection
    // Check for high-intensity emotional patterns
    const hasEmotionalDisclosure = this.detectEmotionalDisclosure(normalized);

    // 5. Past reference detection
    const referencesPastConversation = this.detectPastReference(normalized);

    return {
      preferenceShareCount,
      isMeaningfulResponse,
      hasEmotionalDisclosure,
      referencesPastConversation,
      isDisengaged,
    };
  }

  /**
   * Count preference indicators in message.
   * Looks for patterns like "I like", "I love", "I hate", "I prefer", "favorite"
   */
  private countPreferenceIndicators(normalized: string): number {
    const preferencePatterns = [
      /\bi (?:like|love|enjoy|prefer|adore)\b/g,
      /\bi (?:hate|dislike|can't stand|don't like)\b/g,
      /\bmy (?:favorite|favourite)\b/g,
      /\bi'm (?:into|a fan of|obsessed with)\b/g,
      /\bi (?:always|usually|never)\b/g,
    ];

    let count = 0;
    for (const pattern of preferencePatterns) {
      const matches = normalized.match(pattern);
      if (matches) {
        count += matches.length;
      }
    }

    return Math.min(count, 3); // Cap at 3 to prevent gaming
  }

  /**
   * Detect emotional disclosure in message.
   * Per AI_PIPELINE.md §11.2: high intensity (abs(valence) ≥ 0.6)
   */
  private detectEmotionalDisclosure(normalized: string): boolean {
    for (const pattern of EMOTIONAL_DISCLOSURE_PATTERNS) {
      if (normalized.includes(pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Detect references to past conversation.
   * Per AI_PIPELINE.md §11.2: "remember", "like we said", "last time"
   */
  private detectPastReference(normalized: string): boolean {
    for (const pattern of PAST_REFERENCE_PATTERNS) {
      if (normalized.includes(pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Simple tokenizer for word count.
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s'-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 0);
  }

  /**
   * Compute relationship stage from rapport score.
   * Per PRODUCT.md §7.2 thresholds.
   */
  private computeStage(rapportScore: number): RelationshipStage {
    if (rapportScore >= STAGE_THRESHOLDS.CLOSE_FRIEND) {
      return RelationshipStage.CLOSE_FRIEND;
    }
    if (rapportScore >= STAGE_THRESHOLDS.FRIEND) {
      return RelationshipStage.FRIEND;
    }
    if (rapportScore >= STAGE_THRESHOLDS.ACQUAINTANCE) {
      return RelationshipStage.ACQUAINTANCE;
    }
    return RelationshipStage.STRANGER;
  }

  /**
   * Convert stage to numeric value for comparison.
   */
  private stageToNumber(stage: RelationshipStage): number {
    const stageOrder: Record<RelationshipStage, number> = {
      STRANGER: 0,
      ACQUAINTANCE: 1,
      FRIEND: 2,
      CLOSE_FRIEND: 3,
    };
    return stageOrder[stage];
  }

  /**
   * Check if the previous AI message was a question.
   * Used for meaningful response detection.
   */
  async wasLastAiMessageQuestion(conversationId: string): Promise<boolean> {
    const lastAiMessage = await this.prisma.message.findFirst({
      where: {
        conversationId,
        role: 'assistant',
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        content: true,
      },
    });

    if (!lastAiMessage) {
      return false;
    }

    // Check if message ends with question mark or contains question patterns
    const content = lastAiMessage.content;
    return content.includes('?') || /\b(what|how|why|when|where|do you|would you|could you|can you)\b/i.test(content);
  }
}
