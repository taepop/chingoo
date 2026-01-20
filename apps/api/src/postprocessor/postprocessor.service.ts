import { Injectable, Logger } from '@nestjs/common';
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
 * Violation types detected during post-processing per AI_PIPELINE.md §10
 * 
 * NOTE: Style violations (emoji, sentence length) are NOT enforced here.
 * Style parameters (emoji_freq, msg_length_pref, humor_mode, etc.) are
 * guidance for the LLM prompt, not hard constraints. Only safety-critical
 * violations are enforced via post-processing:
 * - Anti-repetition (opener and similarity)
 * - Personal fact count (anti-creepiness)
 * - Intimacy cap violations
 */
export type ViolationType =
  | 'OPENER_REPETITION'
  | 'MESSAGE_SIMILARITY'
  | 'PERSONAL_FACT_VIOLATION'
  | 'INTIMACY_CAP_VIOLATION';

/**
 * PostProcessor input
 * 
 * NOTE: Style parameters (emoji_freq, msg_length_pref) are NOT included here.
 * Style is handled via LLM prompt guidance, not post-processing enforcement.
 * Post-processor only enforces safety-critical constraints.
 */
export interface PostProcessorInput {
  /** Draft assistant message content */
  draftContent: string;
  /** Conversation ID for fetching recent assistant messages */
  conversationId: string;
  /** Relationship stage for intimacy cap enforcement */
  relationshipStage?: RelationshipStage;
  /** Memory IDs surfaced in this response per AI_PIPELINE.md §10.1 */
  surfacedMemoryIds: string[];
  /** User's message text for recall detection per AI_PIPELINE.md §10.1 */
  userMessage: string;
  /** Whether this is a retention message per AI_PIPELINE.md §10.1 */
  isRetention?: boolean;
  /** Pipeline type for safe fallbacks */
  pipeline?: string;
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
  violations: ViolationType[];
  /** Number of rewrite attempts */
  rewriteAttempts: number;
  /** Surfaced memory IDs (may be reduced if personal_fact_count exceeded) */
  surfacedMemoryIds: string[];
}

/**
 * Emoji bands per AI_PIPELINE.md §10.4
 * - none: emoji_count MUST be 0
 * - light: emoji_count MUST be in [0, 2]
 * - frequent: emoji_count MUST be in [1, 6]
 */
const EMOJI_BANDS: Record<EmojiFreq, { min: number; max: number }> = {
  none: { min: 0, max: 0 },
  light: { min: 0, max: 2 },
  frequent: { min: 1, max: 6 },
};

/**
 * Sentence length bands per AI_PIPELINE.md §10.5
 * 
 * Limits by StableStyleParams.msg_length_pref:
 * - short: sentence_count in [1, 3] AND avg_words_per_sentence <= 14
 * - medium: sentence_count in [2, 5] AND avg_words_per_sentence in [10, 22]
 * - long: sentence_count in [3, 8] AND avg_words_per_sentence >= 15
 */
const SENTENCE_LENGTH_BANDS: Record<
  MsgLengthPref,
  {
    sentenceCount: { min: number; max: number };
    avgWords: { min: number; max: number };
  }
> = {
  short: {
    sentenceCount: { min: 1, max: 3 },
    avgWords: { min: 0, max: 14 },
  },
  medium: {
    sentenceCount: { min: 2, max: 5 },
    avgWords: { min: 10, max: 22 },
  },
  long: {
    sentenceCount: { min: 3, max: 8 },
    avgWords: { min: 15, max: Infinity },
  },
};

/**
 * Personal fact limits per AI_PIPELINE.md §10.1
 * - Normal chat: max 2 facts (unless user asked for recall)
 * - Retention/proactive messages: max 1 fact only
 */
const PERSONAL_FACT_LIMITS = {
  normalChat: 2,
  retention: 1,
};

/**
 * Regex patterns for detecting user recall requests per AI_PIPELINE.md §10.1
 * "Unless user asked for recall ('remember', 'you said', 'last time')"
 */
const RECALL_REQUEST_PATTERNS = [
  /\bremember\b/i,
  /\byou\s+said\b/i,
  /\blast\s+time\b/i,
];

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
 * Safe fallback responses per AI_PIPELINE.md §10 Rewrite Pass
 * Used when rewrite still fails after one attempt
 */
const SAFE_FALLBACKS: Record<string, string> = {
  FRIEND_CHAT: "That's interesting! Tell me more.",
  EMOTIONAL_SUPPORT: 'I hear you. That sounds tough.',
  INFO_QA: "I'm not entirely sure about that.",
  ONBOARDING_CHAT: "Nice to meet you! What would you like to chat about?",
  REFUSAL: 'Please complete onboarding before chatting.',
  DEFAULT: "That's interesting! Tell me more.",
};

/**
 * PostProcessorService
 * 
 * Implements AI_PIPELINE.md §10 (Stage F — Post-Processing & Quality Gates)
 * for SAFETY-CRITICAL constraints only:
 * - §10.1 Personal Fact Count (anti-creepiness)
 * - §10.2 Repeated Opener Detection
 * - §10.3 Similarity Measure for Anti-Repetition (3-gram Jaccard)
 * - Relationship Intimacy Cap enforcement
 * 
 * STYLE PARAMETERS (emoji_freq, msg_length_pref, humor_mode, etc.) are
 * NOT enforced here. They are handled via LLM prompt guidance in llm.service.ts.
 * This approach avoids excessive fallbacks and preserves natural responses.
 */
@Injectable()
export class PostProcessorService {
  private readonly logger = new Logger(PostProcessorService.name);
  private readonly apiKey: string;
  private readonly apiUrl = 'https://api.openai.com/v1/chat/completions';
  private readonly model = 'gpt-4o-mini';

  constructor(private prisma: PrismaService) {
    this.apiKey = (process.env.LLM_API_KEY || '').trim();
  }

  /**
   * Process assistant draft message per AI_PIPELINE.md §10.
   * 
   * CRITICAL ORDER INVARIANT (task requirement):
   * This MUST be called BEFORE assistant message persistence.
   * The stored assistant message content MUST be the post-processed output.
   * 
   * Safety Gates Implemented (only safety-critical constraints):
   * 1. Personal Fact Count (§10.1) - anti-creepiness
   * 2. Repeated Opener Detection (§10.2)
   * 3. Similarity Measure for Anti-Repetition (§10.3)
   * 4. Relationship Intimacy Cap
   * 
   * STYLE PARAMETERS (emoji, sentence length) are NOT enforced here.
   * They guide the LLM via prompt, not via post-processing.
   * 
   * @param input - PostProcessor input with draft content and constraints
   * @returns PostProcessorResult with final content and opener_norm
   */
  async process(input: PostProcessorInput): Promise<PostProcessorResult> {
    const violations: ViolationType[] = [];
    let rewriteAttempts = 0;
    let content = input.draftContent;
    let surfacedMemoryIds = [...input.surfacedMemoryIds];

    // Step 1: Personal Fact Count per AI_PIPELINE.md §10.1
    // "do not mention >2 personal facts in one message unless user asked"
    const personalFactViolation = this.checkPersonalFactCount(input);
    if (personalFactViolation) {
      violations.push('PERSONAL_FACT_VIOLATION');
      // Reduce surfacedMemoryIds to the allowed limit
      surfacedMemoryIds = this.enforcePersonalFactLimit(input);
    }

    // Step 2: Fetch recent assistant messages for repetition checks
    const recentMessages = await this.getRecentAssistantMessages(
      input.conversationId,
      RECENT_MESSAGES_LIMIT,
    );

    // Step 3: Compute opener_norm per AI_PIPELINE.md §10.2
    let openerNorm = this.computeOpenerNorm(content);

    // Step 4: Check opener repetition per AI_PIPELINE.md §10.2
    // "If opener_norm exactly matches any opener_norm from the last 20 assistant messages"
    const recentOpenerNorms = recentMessages
      .map(m => m.openerNorm)
      .filter((n): n is string => n !== null);

    if (recentOpenerNorms.includes(openerNorm)) {
      violations.push('OPENER_REPETITION');
    }

    // Step 5: Check message similarity per AI_PIPELINE.md §10.3
    // "If similarity with ANY of the last 20 assistant messages is >= 0.70"
    const normNoPunct = this.normalizeNoPunct(content);
    const recentContentNorms = recentMessages.map(m => 
      this.normalizeNoPunct(m.content),
    );

    for (const recentNorm of recentContentNorms) {
      const similarity = this.computeJaccardSimilarity(normNoPunct, recentNorm);
      if (similarity >= SIMILARITY_THRESHOLD) {
        violations.push('MESSAGE_SIMILARITY');
        break;
      }
    }

    // Step 6: Relationship intimacy cap enforcement per AI_PIPELINE.md §10
    // "Relationship intimacy cap: STRANGER: avoid overly intimate language"
    if (input.relationshipStage) {
      const intimacyViolation = this.checkIntimacyCap(content, input.relationshipStage);
      if (intimacyViolation) {
        violations.push('INTIMACY_CAP_VIOLATION');
      }
    }

    // Step 7: If violations detected, perform SINGLE rewrite pass
    // Only for safety-critical violations (repetition, intimacy)
    if (violations.length > 0) {
      this.logger.debug(`Post-processor detected violations: ${violations.join(', ')}`);
      
      // Try deterministic rewrites first for simple violations
      content = this.applyDeterministicRewrites(content, violations, {
        relationshipStage: input.relationshipStage,
        recentOpenerNorms,
      });
      rewriteAttempts++;

      // Recompute violation checks after deterministic rewrites
      const postRewriteViolations = this.computeRemainingViolations(content, {
        relationshipStage: input.relationshipStage,
        recentOpenerNorms,
        recentContentNorms,
      });

      // If still has violations, attempt LLM rewrite (one call max)
      if (postRewriteViolations.length > 0 && this.apiKey) {
        const llmRewritten = await this.attemptLlmRewrite(
          content,
          postRewriteViolations,
          input,
        );

        if (llmRewritten) {
          content = llmRewritten;
          rewriteAttempts++;

          // Final validation after LLM rewrite
          const finalViolations = this.computeRemainingViolations(content, {
            relationshipStage: input.relationshipStage,
            recentOpenerNorms,
            recentContentNorms,
          });

          // If still failing, fall back to safe response
          if (finalViolations.length > 0) {
            content = this.getSafeFallback(input.pipeline);
            this.logger.warn(`LLM rewrite still has violations, using safe fallback`);
          }
        } else {
          // LLM rewrite failed, fall back to safe response
          content = this.getSafeFallback(input.pipeline);
          this.logger.warn(`LLM rewrite failed, using safe fallback`);
        }
      }
    }

    // Final opener_norm computation
    openerNorm = this.computeOpenerNorm(content);

    return {
      content,
      openerNorm,
      violations,
      rewriteAttempts,
      surfacedMemoryIds,
    };
  }

  /**
   * Check if personal fact count exceeds limit per AI_PIPELINE.md §10.1
   * 
   * Rules:
   * - Normal chat: max 2 facts (unless user asked for recall)
   * - Retention/proactive messages: max 1 fact only
   */
  private checkPersonalFactCount(input: PostProcessorInput): boolean {
    const factCount = input.surfacedMemoryIds.length;

    // Check if user asked for recall
    const userAskedRecall = RECALL_REQUEST_PATTERNS.some(pattern =>
      pattern.test(input.userMessage),
    );

    // If user asked for recall, no limit
    if (userAskedRecall) {
      return false;
    }

    // Check retention limit
    if (input.isRetention) {
      return factCount > PERSONAL_FACT_LIMITS.retention;
    }

    // Check normal chat limit
    return factCount > PERSONAL_FACT_LIMITS.normalChat;
  }

  /**
   * Enforce personal fact limit by reducing surfacedMemoryIds
   * Per AI_PIPELINE.md §10.1: "Reduce surfacedMemoryIds to at most 2"
   */
  private enforcePersonalFactLimit(input: PostProcessorInput): string[] {
    const limit = input.isRetention
      ? PERSONAL_FACT_LIMITS.retention
      : PERSONAL_FACT_LIMITS.normalChat;

    // Keep only the first N memories
    return input.surfacedMemoryIds.slice(0, limit);
  }

  /**
   * Check sentence length band per AI_PIPELINE.md §10.5
   * 
   * Bands:
   * - short: sentence_count in [1, 3] AND avg_words_per_sentence <= 14
   * - medium: sentence_count in [2, 5] AND avg_words_per_sentence in [10, 22]
   * - long: sentence_count in [3, 8] AND avg_words_per_sentence >= 15
   */
  private checkSentenceLengthBand(content: string, msgLengthPref: MsgLengthPref): boolean {
    const { sentenceCount, avgWordsPerSentence } = this.computeSentenceMetrics(content);
    const band = SENTENCE_LENGTH_BANDS[msgLengthPref];

    // Check sentence count
    if (sentenceCount < band.sentenceCount.min || sentenceCount > band.sentenceCount.max) {
      return true;
    }

    // Check average words per sentence
    if (avgWordsPerSentence < band.avgWords.min || avgWordsPerSentence > band.avgWords.max) {
      return true;
    }

    return false;
  }

  /**
   * Compute sentence metrics for length band enforcement
   * Per AI_PIPELINE.md §10.5:
   * - Split on `.`, `!`, `?`, `…`, or Korean `.` equivalents
   * - Treat consecutive delimiters as one
   * - Ignore empty segments
   */
  computeSentenceMetrics(content: string): {
    sentenceCount: number;
    avgWordsPerSentence: number;
    totalWords: number;
  } {
    // Split on sentence-ending punctuation (including Korean equivalents)
    // Per AI_PIPELINE.md §10.5: Split on `.`, `!`, `?`, `…`, or Korean `.` equivalents
    const sentenceDelimiters = /[.!?…。？！]+/;
    const sentences = content
      .split(sentenceDelimiters)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    const sentenceCount = Math.max(1, sentences.length);

    // Count total words (tokenized on whitespace)
    const totalWords = content
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 0).length;

    const avgWordsPerSentence = sentenceCount > 0 ? totalWords / sentenceCount : 0;

    return {
      sentenceCount,
      avgWordsPerSentence: Math.round(avgWordsPerSentence * 100) / 100,
      totalWords,
    };
  }

  /**
   * Apply deterministic rewrites for violations that don't need LLM
   */
  private applyDeterministicRewrites(
    content: string,
    violations: ViolationType[],
    params: {
      relationshipStage?: RelationshipStage;
      recentOpenerNorms: string[];
    },
  ): string {
    let rewritten = content;

    // Handle opener repetition
    if (violations.includes('OPENER_REPETITION')) {
      rewritten = this.rewriteOpener(rewritten, params.recentOpenerNorms);
    }

    // Handle message similarity
    if (violations.includes('MESSAGE_SIMILARITY')) {
      rewritten = this.rewriteForDifferentStructure(rewritten);
    }

    // Handle intimacy cap violation
    if (violations.includes('INTIMACY_CAP_VIOLATION') && params.relationshipStage) {
      rewritten = this.enforceIntimacyCap(rewritten, params.relationshipStage);
    }

    return rewritten;
  }

  /**
   * Compute remaining violations after rewrite (safety-critical only)
   */
  private computeRemainingViolations(
    content: string,
    params: {
      relationshipStage?: RelationshipStage;
      recentOpenerNorms: string[];
      recentContentNorms: string[];
    },
  ): ViolationType[] {
    const violations: ViolationType[] = [];

    // Check opener repetition
    const openerNorm = this.computeOpenerNorm(content);
    if (params.recentOpenerNorms.includes(openerNorm)) {
      violations.push('OPENER_REPETITION');
    }

    // Check message similarity
    const normNoPunct = this.normalizeNoPunct(content);
    for (const recentNorm of params.recentContentNorms) {
      if (this.computeJaccardSimilarity(normNoPunct, recentNorm) >= SIMILARITY_THRESHOLD) {
        violations.push('MESSAGE_SIMILARITY');
        break;
      }
    }

    // Check intimacy cap
    if (params.relationshipStage && this.checkIntimacyCap(content, params.relationshipStage)) {
      violations.push('INTIMACY_CAP_VIOLATION');
    }

    return violations;
  }

  /**
   * Attempt LLM rewrite for violations that couldn't be fixed deterministically
   * Per AI_PIPELINE.md §10: "one extra LLM call max"
   */
  private async attemptLlmRewrite(
    originalContent: string,
    violations: ViolationType[],
    input: PostProcessorInput,
  ): Promise<string | null> {
    if (!this.apiKey) {
      return null;
    }

    try {
      const rewritePrompt = this.buildRewritePrompt(originalContent, violations, input);

      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: 'You are a rewriting assistant. Your job is to fix specific constraint violations in a message while preserving its meaning.' },
            { role: 'user', content: rewritePrompt },
          ],
          max_tokens: 200,
          temperature: 0.3, // Lower temperature for more controlled output
        }),
      });

      if (!response.ok) {
        this.logger.error(`LLM rewrite API error: ${response.status}`);
        return null;
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const rewrittenContent = data.choices?.[0]?.message?.content?.trim();

      if (!rewrittenContent || rewrittenContent.length === 0) {
        return null;
      }

      return rewrittenContent;
    } catch (error) {
      this.logger.error(`LLM rewrite failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  /**
   * Build rewrite prompt for LLM (safety violations only)
   */
  private buildRewritePrompt(
    originalContent: string,
    violations: ViolationType[],
    _input: PostProcessorInput,
  ): string {
    const violationDescriptions: string[] = [];

    for (const violation of violations) {
      switch (violation) {
        case 'OPENER_REPETITION':
          violationDescriptions.push('- Opening phrase is too similar to recent messages. Use a different start.');
          break;
        case 'MESSAGE_SIMILARITY':
          violationDescriptions.push('- Message structure is too similar to recent responses. Rewrite with different structure.');
          break;
        case 'INTIMACY_CAP_VIOLATION':
          violationDescriptions.push('- Language is too intimate for current relationship stage. Use more appropriate phrasing.');
          break;
      }
    }

    return `The following response has violations that need fixing:

ORIGINAL: "${originalContent}"

VIOLATIONS:
${violationDescriptions.join('\n')}

Rewrite the response to:
1. Fix all listed violations
2. Preserve the core meaning
3. Sound natural and conversational

REWRITTEN:`;
  }

  /**
   * Get safe fallback response
   * Per AI_PIPELINE.md §10: "fall back to a safe, shorter response"
   */
  private getSafeFallback(pipeline?: string): string {
    if (pipeline && SAFE_FALLBACKS[pipeline]) {
      return SAFE_FALLBACKS[pipeline];
    }
    return SAFE_FALLBACKS.DEFAULT;
  }

  /**
   * Enforce sentence length band by adjusting content
   * Per AI_PIPELINE.md §10.5: "rewrite to match the nearest band while preserving content"
   */
  private enforceSentenceLengthBand(content: string, msgLengthPref: MsgLengthPref): string {
    const { sentenceCount, avgWordsPerSentence } = this.computeSentenceMetrics(content);
    const band = SENTENCE_LENGTH_BANDS[msgLengthPref];

    // Split into sentences
    const sentenceDelimiters = /(?<=[.!?…。？！])\s*/;
    const sentences = content.split(sentenceDelimiters).filter(s => s.trim().length > 0);

    // Too many sentences - truncate
    if (sentenceCount > band.sentenceCount.max) {
      const truncated = sentences.slice(0, band.sentenceCount.max).join(' ');
      return truncated.trim();
    }

    // Too few sentences for medium/long - try to split
    if (sentenceCount < band.sentenceCount.min) {
      // For 'short' preference with min=1, a single sentence is always valid
      if (msgLengthPref === 'short') {
        return content;
      }

      // Can't easily add sentences deterministically, so return as-is
      // LLM rewrite will handle this
      return content;
    }

    // Average words too high - try shortening sentences
    if (avgWordsPerSentence > band.avgWords.max) {
      // Shorten each sentence to roughly the max average
      const targetWords = band.avgWords.max;
      const shortened = sentences.map(s => {
        const words = s.trim().split(/\s+/);
        if (words.length > targetWords * 1.2) {
          // Keep first targetWords words and add ellipsis
          return words.slice(0, targetWords).join(' ');
        }
        return s;
      });
      return shortened.join(' ').trim();
    }

    return content;
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
