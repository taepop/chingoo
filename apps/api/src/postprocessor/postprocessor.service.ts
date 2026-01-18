import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RelationshipStage } from '@prisma/client';

/**
 * StableStyleParams emoji_freq values per AI_PIPELINE.md §2.4
 */
export type EmojiFreq = 'none' | 'light' | 'frequent';

/**
 * StableStyleParams msg_length_pref values per AI_PIPELINE.md §2.4
 */
export type MsgLengthPref = 'short' | 'medium' | 'long';

/**
 * PostProcessor input
 */
export interface PostProcessorInput {
  /** Draft assistant message content */
  draftContent: string;
  /** Conversation ID for fetching recent assistant messages */
  conversationId: string;
  /** emoji_freq from StableStyleParams */
  emojiFreq: EmojiFreq;
  /** msg_length_pref from StableStyleParams (optional for v0.1) */
  msgLengthPref?: MsgLengthPref;
  /** Relationship stage for intimacy cap enforcement */
  relationshipStage?: RelationshipStage;
}

/**
 * PostProcessor result
 */
export interface PostProcessorResult {
  /** Final processed content */
  content: string;
  /** Computed opener_norm for storage */
  openerNorm: string;
  /** List of violations detected */
  violations: string[];
  /** Number of rewrite attempts */
  rewriteAttempts: number;
}

/**
 * Emoji bands per AI_PIPELINE.md §10.4
 */
const EMOJI_BANDS: Record<EmojiFreq, { min: number; max: number }> = {
  none: { min: 0, max: 0 },
  light: { min: 0, max: 2 },
  frequent: { min: 1, max: 6 },
};

/**
 * Similarity threshold per AI_PIPELINE.md §10.3
 * "If similarity with ANY of the last 20 assistant messages is >= 0.70"
 */
const SIMILARITY_THRESHOLD = 0.70;

/**
 * Number of recent assistant messages to check per AI_PIPELINE.md §10.2, §10.3
 */
const RECENT_MESSAGES_LIMIT = 20;

/**
 * PostProcessorService
 * 
 * Implements AI_PIPELINE.md §10 (Stage F — Post-Processing & Quality Gates):
 * - §10.2 Repeated Opener Detection
 * - §10.3 Similarity Measure for Anti-Repetition (3-gram Jaccard)
 * - §10.4 Emoji Band Enforcement
 * 
 * CRITICAL: This service is PURE DETERMINISTIC.
 * - No LLM calls, no network calls, no randomness.
 * - Same input always produces identical output.
 * 
 * Per AI_PIPELINE.md §16:
 * "PostProcessor must be the final enforcement point for persona constraints"
 */
@Injectable()
export class PostProcessorService {
  constructor(private prisma: PrismaService) {}

  /**
   * Process assistant draft message per AI_PIPELINE.md §10.
   * 
   * CRITICAL ORDER INVARIANT (task requirement):
   * This MUST be called BEFORE assistant message persistence.
   * The stored assistant message content MUST be the post-processed output.
   * 
   * @param input - PostProcessor input with draft content and constraints
   * @returns PostProcessorResult with final content and opener_norm
   */
  async process(input: PostProcessorInput): Promise<PostProcessorResult> {
    const violations: string[] = [];
    let rewriteAttempts = 0;
    let content = input.draftContent;

    // Step 1: Fetch recent assistant messages for repetition checks
    const recentMessages = await this.getRecentAssistantMessages(
      input.conversationId,
      RECENT_MESSAGES_LIMIT,
    );

    // Step 2: Compute opener_norm per AI_PIPELINE.md §10.2
    let openerNorm = this.computeOpenerNorm(content);

    // Step 3: Check opener repetition per AI_PIPELINE.md §10.2
    // "If opener_norm exactly matches any opener_norm from the last 20 assistant messages"
    const recentOpenerNorms = recentMessages
      .map(m => m.openerNorm)
      .filter((n): n is string => n !== null);

    if (recentOpenerNorms.includes(openerNorm)) {
      violations.push('OPENER_REPETITION');
      // Rewrite opener deterministically
      content = this.rewriteOpener(content, recentOpenerNorms);
      openerNorm = this.computeOpenerNorm(content);
      rewriteAttempts++;
    }

    // Step 4: Check message similarity per AI_PIPELINE.md §10.3
    // "If similarity with ANY of the last 20 assistant messages is >= 0.70"
    const normNoPunct = this.normalizeNoPunct(content);
    const recentContentNorms = recentMessages.map(m => 
      this.normalizeNoPunct(m.content),
    );

    for (const recentNorm of recentContentNorms) {
      const similarity = this.computeJaccardSimilarity(normNoPunct, recentNorm);
      if (similarity >= SIMILARITY_THRESHOLD) {
        violations.push('MESSAGE_SIMILARITY');
        // Rewrite to shorter, different structure
        content = this.rewriteForDifferentStructure(content);
        rewriteAttempts++;
        break; // Only one rewrite pass per AI_PIPELINE.md §10
      }
    }

    // Step 5: Emoji band enforcement per AI_PIPELINE.md §10.4
    const emojiCount = this.countEmojis(content);
    const band = EMOJI_BANDS[input.emojiFreq];

    if (emojiCount < band.min || emojiCount > band.max) {
      violations.push('EMOJI_BAND_VIOLATION');
      content = this.enforceEmojiBand(content, input.emojiFreq, emojiCount);
      // Recompute opener_norm after emoji changes (emojis stripped anyway)
      openerNorm = this.computeOpenerNorm(content);
      rewriteAttempts++;
    }

    // Step 6: Relationship intimacy cap enforcement per AI_PIPELINE.md §10
    // "Relationship intimacy cap: STRANGER: avoid overly intimate language"
    if (input.relationshipStage) {
      const intimacyViolation = this.checkIntimacyCap(content, input.relationshipStage);
      if (intimacyViolation) {
        violations.push('INTIMACY_CAP_VIOLATION');
        content = this.enforceIntimacyCap(content, input.relationshipStage);
        // Recompute opener_norm after intimacy adjustments
        openerNorm = this.computeOpenerNorm(content);
        rewriteAttempts++;
      }
    }

    return {
      content,
      openerNorm,
      violations,
      rewriteAttempts,
    };
  }

  /**
   * Compute opener_norm per AI_PIPELINE.md §10.2:
   * 
   * "Compute opener_norm as the first 12 tokens of the assistant message after:
   *  1) stripping leading emojis
   *  2) lowercasing ASCII only
   *  3) collapsing whitespace
   *  4) removing punctuation except apostrophes"
   */
  computeOpenerNorm(content: string): string {
    // Step 1: Strip leading emojis
    let processed = this.stripLeadingEmojis(content);

    // Step 2: Lowercase ASCII only (preserve non-Latin scripts)
    processed = processed.replace(/[A-Z]/g, char => char.toLowerCase());

    // Step 3: Collapse whitespace
    processed = processed.replace(/\s+/g, ' ').trim();

    // Step 4: Remove punctuation except apostrophes
    processed = processed.replace(/[^\w\s'가-힣ㄱ-ㅎㅏ-ㅣ]/g, '');

    // Get first 12 tokens
    const tokens = processed.split(/\s+/).filter(t => t.length > 0);
    const first12 = tokens.slice(0, 12).join(' ');

    return first12;
  }

  /**
   * Strip leading emojis from text.
   * Uses Unicode emoji detection.
   */
  private stripLeadingEmojis(text: string): string {
    // Unicode emoji regex - matches emoji at start of string
    const emojiRegex = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f\s]+/u;
    return text.replace(emojiRegex, '').trim();
  }

  /**
   * Normalize text for similarity comparison (norm_no_punct).
   * Per AI_PIPELINE.md §2.8 User Text Normalization:
   * - Unicode NFKC
   * - strip zero-width chars
   * - collapse whitespace
   * - trim
   * - lowercase ASCII only
   * - remove punctuation except apostrophes
   */
  private normalizeNoPunct(text: string): string {
    let normalized = text
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '') // Strip zero-width chars
      .replace(/\s+/g, ' ')
      .trim();

    // Lowercase ASCII only
    normalized = normalized.replace(/[A-Z]/g, char => char.toLowerCase());

    // Remove punctuation except apostrophes
    normalized = normalized.replace(/[^\w\s'가-힣ㄱ-ㅎㅏ-ㅣ]/g, '');

    return normalized;
  }

  /**
   * Compute 3-gram Jaccard similarity per AI_PIPELINE.md §10.3:
   * 
   * "Let G(msg) be the set of 3-grams over tokens (min 3 tokens; otherwise empty).
   *  Jaccard = |G(a) ∩ G(b)| / |G(a) ∪ G(b)|."
   */
  computeJaccardSimilarity(text1: string, text2: string): number {
    const grams1 = this.computeTokenThreeGrams(text1);
    const grams2 = this.computeTokenThreeGrams(text2);

    // If either set is empty (< 3 tokens), return 0
    if (grams1.size === 0 || grams2.size === 0) {
      return 0;
    }

    // Compute intersection
    const intersection = new Set<string>();
    for (const gram of grams1) {
      if (grams2.has(gram)) {
        intersection.add(gram);
      }
    }

    // Compute union
    const union = new Set([...grams1, ...grams2]);

    // Jaccard = |intersection| / |union|
    return intersection.size / union.size;
  }

  /**
   * Compute set of token 3-grams from text.
   * Per AI_PIPELINE.md §10.3: "min 3 tokens; otherwise empty"
   */
  private computeTokenThreeGrams(text: string): Set<string> {
    const tokens = text.split(/\s+/).filter(t => t.length > 0);

    // Min 3 tokens required
    if (tokens.length < 3) {
      return new Set();
    }

    const grams = new Set<string>();
    for (let i = 0; i <= tokens.length - 3; i++) {
      const gram = tokens.slice(i, i + 3).join(' ');
      grams.add(gram);
    }

    return grams;
  }

  /**
   * Count Unicode emojis in text per AI_PIPELINE.md §10.4:
   * "Define emoji_count as the count of Unicode emoji codepoints"
   */
  countEmojis(text: string): number {
    // Match emoji characters using Unicode properties
    // This regex matches emoji presentation characters
    const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
    const matches = text.match(emojiRegex);
    return matches ? matches.length : 0;
  }

  /**
   * Enforce emoji band by adding or removing emojis.
   * Per AI_PIPELINE.md §10.4:
   * "If out of band: rewrite to bring into band without changing meaning."
   */
  private enforceEmojiBand(
    content: string,
    emojiFreq: EmojiFreq,
    currentCount: number,
  ): string {
    const band = EMOJI_BANDS[emojiFreq];

    if (currentCount > band.max) {
      // Remove excess emojis (keep from end up to max)
      return this.removeExcessEmojis(content, band.max);
    }

    if (currentCount < band.min) {
      // Add emojis to meet minimum (only for 'frequent' which requires min 1)
      return this.addEmojisToMeetMin(content, band.min);
    }

    return content;
  }

  /**
   * Remove excess emojis from content, keeping at most maxCount.
   * Removes from left to right to preserve trailing emojis.
   */
  private removeExcessEmojis(content: string, maxCount: number): string {
    const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
    
    if (maxCount === 0) {
      // Remove all emojis
      return content.replace(emojiRegex, '').replace(/\s+/g, ' ').trim();
    }

    // Find all emoji positions and keep last maxCount
    const matches: { index: number; emoji: string }[] = [];
    let match;
    while ((match = emojiRegex.exec(content)) !== null) {
      matches.push({ index: match.index, emoji: match[0] });
    }

    if (matches.length <= maxCount) {
      return content;
    }

    // Keep the last maxCount emojis, remove the rest
    const emojisToRemove = matches.slice(0, matches.length - maxCount);
    let result = content;
    
    // Remove from end to start to preserve indices
    for (let i = emojisToRemove.length - 1; i >= 0; i--) {
      const { index, emoji } = emojisToRemove[i];
      result = result.substring(0, index) + result.substring(index + emoji.length);
    }

    // Clean up extra spaces
    return result.replace(/\s+/g, ' ').trim();
  }

  /**
   * Add emojis to content to meet minimum count.
   * Uses deterministic emoji selection based on content.
   */
  private addEmojisToMeetMin(content: string, minCount: number): string {
    const currentCount = this.countEmojis(content);
    const needed = minCount - currentCount;

    if (needed <= 0) {
      return content;
    }

    // Deterministic emoji selection - use simple friendly emoji
    const defaultEmoji = '😊';
    const emojisToAdd = defaultEmoji.repeat(needed);

    // Add at end of content
    return `${content} ${emojisToAdd}`.trim();
  }

  /**
   * Rewrite opener to avoid repetition.
   * Per AI_PIPELINE.md §10.2:
   * "rewrite the opener (single rewrite pass allowed by §10) while preserving meaning."
   * 
   * DETERMINISTIC: Uses content-based transformation.
   */
  private rewriteOpener(content: string, existingOpeners: string[]): string {
    // Deterministic rewrite strategies based on content characteristics
    const words = content.split(/\s+/);
    
    // Strategy 1: If starts with greeting, rotate to different greeting
    const greetings = ['hey', 'hi', 'hello', 'oh', 'wow', 'ah', 'so', 'well'];
    const firstWordLower = words[0]?.toLowerCase().replace(/[^a-z]/g, '');
    
    if (greetings.includes(firstWordLower)) {
      // Remove the greeting and start with the substance
      const withoutGreeting = words.slice(1).join(' ');
      if (withoutGreeting.length > 0) {
        return withoutGreeting;
      }
    }

    // Strategy 2: Add a transitional word if not present
    const transitions = ['actually', 'honestly', 'hmm'];
    for (const trans of transitions) {
      const testOpener = this.computeOpenerNorm(`${trans} ${content}`);
      if (!existingOpeners.includes(testOpener)) {
        return `${trans.charAt(0).toUpperCase() + trans.slice(1)}, ${content.charAt(0).toLowerCase() + content.slice(1)}`;
      }
    }

    // Strategy 3: Restructure by moving first clause
    const punctIndex = content.search(/[,!?]/);
    if (punctIndex > 5 && punctIndex < content.length - 10) {
      const firstPart = content.substring(0, punctIndex);
      const rest = content.substring(punctIndex + 1).trim();
      if (rest.length > 0) {
        return `${rest.charAt(0).toUpperCase() + rest.slice(1)} - ${firstPart.toLowerCase()}`;
      }
    }

    // Strategy 4: Simple prefix change
    return `Well, ${content.charAt(0).toLowerCase() + content.slice(1)}`;
  }

  /**
   * Rewrite message for different structure when similarity is too high.
   * Per AI_PIPELINE.md §10.3:
   * "MUST be rewritten shorter and with a different structure."
   */
  private rewriteForDifferentStructure(content: string): string {
    // Deterministic shortening: keep first sentence only
    const sentences = content.split(/(?<=[.!?])\s+/);
    
    if (sentences.length > 1) {
      // Keep just the first sentence
      return sentences[0].trim();
    }

    // If single sentence, truncate to first 15 words
    const words = content.split(/\s+/);
    if (words.length > 15) {
      return words.slice(0, 15).join(' ') + '...';
    }

    // Already short, just return as-is
    return content;
  }

  /**
   * Check if content violates intimacy cap for the given relationship stage.
   * Per AI_PIPELINE.md §10:
   * - STRANGER: avoid overly intimate language
   * - CLOSE_FRIEND: warmer allowed, but still no dependency/exclusivity
   */
  private checkIntimacyCap(content: string, stage: RelationshipStage): boolean {
    const normalized = content.toLowerCase();
    
    // Overly intimate phrases that should be avoided in STRANGER/ACQUAINTANCE stages
    const overlyIntimatePhrases = [
      'i love you',
      'i miss you',
      'i need you',
      'can\'t live without you',
      'you\'re my everything',
      'you complete me',
      'i\'m nothing without you',
      'you\'re the only one',
      'i\'m yours',
      'you belong to me',
      'we\'re meant to be',
      'soulmate',
      'destined',
    ];
    
    // Dependency/exclusivity phrases (not allowed even for CLOSE_FRIEND)
    const dependencyPhrases = [
      'i can\'t function without you',
      'you\'re my only reason',
      'i exist for you',
      'you\'re my world',
      'nothing matters without you',
    ];
    
    // Check dependency phrases (forbidden at all stages)
    for (const phrase of dependencyPhrases) {
      if (normalized.includes(phrase)) {
        return true;
      }
    }
    
    // Check overly intimate phrases based on stage
    if (stage === 'STRANGER' || stage === 'ACQUAINTANCE') {
      for (const phrase of overlyIntimatePhrases) {
        if (normalized.includes(phrase)) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Enforce intimacy cap by rewriting overly intimate language.
   * Per AI_PIPELINE.md §10: Rewrite to appropriate level for relationship stage.
   */
  private enforceIntimacyCap(content: string, stage: RelationshipStage): string {
    let rewritten = content;
    const normalized = content.toLowerCase();
    
    // Replace overly intimate phrases with stage-appropriate alternatives
    const replacements: Record<string, Record<RelationshipStage, string>> = {
      'i love you': {
        STRANGER: 'I appreciate that',
        ACQUAINTANCE: 'That\'s really nice of you',
        FRIEND: 'That means a lot',
        CLOSE_FRIEND: 'That\'s really sweet',
      },
      'i miss you': {
        STRANGER: 'Good to hear from you',
        ACQUAINTANCE: 'Nice to chat again',
        FRIEND: 'Good to talk again',
        CLOSE_FRIEND: 'Great to hear from you',
      },
      'i need you': {
        STRANGER: 'I\'m here to help',
        ACQUAINTANCE: 'I\'m here if you need someone',
        FRIEND: 'I\'m here for you',
        CLOSE_FRIEND: 'I\'m always here for you',
      },
    };
    
    // Apply replacements
    for (const [phrase, stageReplacements] of Object.entries(replacements)) {
      if (normalized.includes(phrase)) {
        const replacement = stageReplacements[stage] || stageReplacements.FRIEND;
        // Case-insensitive replacement
        const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        rewritten = rewritten.replace(regex, replacement);
      }
    }
    
    // Remove dependency phrases entirely (replace with neutral response)
    const dependencyPhrases = [
      'i can\'t live without you',
      'you\'re my everything',
      'you complete me',
      'i\'m nothing without you',
      'you\'re the only one',
    ];
    
    for (const phrase of dependencyPhrases) {
      if (normalized.includes(phrase)) {
        // Replace with a supportive but boundary-respecting phrase
        const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        rewritten = rewritten.replace(regex, 'I\'m here to support you as a friend');
      }
    }
    
    return rewritten.trim() || content; // Fallback to original if rewrite is empty
  }

  /**
   * Get recent assistant messages for repetition checking.
   */
  private async getRecentAssistantMessages(
    conversationId: string,
    limit: number,
  ): Promise<{ content: string; openerNorm: string | null }[]> {
    const messages = await this.prisma.message.findMany({
      where: {
        conversationId,
        role: 'assistant',
        status: 'COMPLETED',
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        content: true,
        openerNorm: true,
      },
    });

    return messages;
  }
}
