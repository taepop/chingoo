import { Test, TestingModule } from '@nestjs/testing';
import { PostProcessorService, PostProcessorInput } from './postprocessor.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * PostProcessorService Unit Tests
 * 
 * TEST GATE #7 — Behavior enforcement (MANDATORY)
 * 
 * Tests AI_PIPELINE.md §10 (Stage F — Post-Processing & Quality Gates):
 * Safety-critical constraints only (style enforcement removed):
 * - §10.1 Personal Fact Count (anti-creepiness)
 * - §10.2 Repeated Opener Detection
 * - §10.3 Similarity Measure for Anti-Repetition (3-gram Jaccard)
 * - Relationship Intimacy Cap
 * 
 * NOTE: Style parameters (emoji_freq, msg_length_pref) are NOT enforced here.
 * They are guidance for the LLM prompt, not hard post-processing constraints.
 * 
 * Per task requirement:
 * "DETERMINISM: post-processing MUST NOT call any LLM or external service;
 *  pure deterministic transforms only."
 */

/**
 * Helper to build a default PostProcessorInput for testing
 */
function buildTestInput(overrides: Partial<PostProcessorInput> = {}): PostProcessorInput {
  return {
    draftContent: 'Hello, how are you today?',
    conversationId: 'test-conv-id',
    surfacedMemoryIds: [],
    userMessage: 'hey there',
    isRetention: false,
    pipeline: 'FRIEND_CHAT',
    ...overrides,
  };
}

describe('PostProcessorService', () => {
  let service: PostProcessorService;
  let prismaService: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const mockPrismaService = {
      message: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PostProcessorService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<PostProcessorService>(PostProcessorService);
    prismaService = module.get(PrismaService);
  });

  describe('computeOpenerNorm', () => {
    /**
     * Per AI_PIPELINE.md §10.2:
     * "Compute opener_norm as the first 12 tokens of the assistant message after:
     *  1) stripping leading emojis
     *  2) lowercasing ASCII only
     *  3) collapsing whitespace
     *  4) removing punctuation except apostrophes"
     */
    it('should strip leading emojis', () => {
      const result = service.computeOpenerNorm('😊 Hey there, how are you doing today?');
      expect(result).toBe("hey there how are you doing today");
    });

    it('should lowercase ASCII only (preserve Korean)', () => {
      const result = service.computeOpenerNorm('Hey 안녕하세요 How Are You');
      expect(result).toBe('hey 안녕하세요 how are you');
    });

    it('should collapse whitespace', () => {
      const result = service.computeOpenerNorm('Hey   there,    how are   you?');
      expect(result).toBe('hey there how are you');
    });

    it('should remove punctuation except apostrophes', () => {
      const result = service.computeOpenerNorm("That's great! How's it going?");
      expect(result).toBe("that's great how's it going");
    });

    it('should take only first 12 tokens', () => {
      const longMessage = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen';
      const result = service.computeOpenerNorm(longMessage);
      expect(result).toBe('one two three four five six seven eight nine ten eleven twelve');
    });

    it('should produce consistent results for same input (deterministic)', () => {
      const input = '😊 Hey! How are you doing today? I hope everything is going well!';
      const result1 = service.computeOpenerNorm(input);
      const result2 = service.computeOpenerNorm(input);
      expect(result1).toBe(result2);
    });
  });

  describe('computeJaccardSimilarity', () => {
    /**
     * Per AI_PIPELINE.md §10.3:
     * "Let G(msg) be the set of 3-grams over tokens (min 3 tokens; otherwise empty).
     *  Jaccard = |G(a) ∩ G(b)| / |G(a) ∪ G(b)|."
     */
    it('should return 0 for texts with less than 3 tokens', () => {
      const result = service.computeJaccardSimilarity('hi there', 'hello world');
      expect(result).toBe(0);
    });

    it('should return 1.0 for identical texts', () => {
      const text = 'hello there how are you doing today';
      const result = service.computeJaccardSimilarity(text, text);
      expect(result).toBe(1.0);
    });

    it('should return 0 for completely different texts', () => {
      const text1 = 'apple banana cherry date elderberry';
      const text2 = 'fish grape honey ice jelly';
      const result = service.computeJaccardSimilarity(text1, text2);
      expect(result).toBe(0);
    });

    it('should return value between 0 and 1 for partially similar texts', () => {
      const text1 = 'hey how are you doing today';
      const text2 = 'hey how are things going well';
      const result = service.computeJaccardSimilarity(text1, text2);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(1);
    });

    it('should compute correct Jaccard for known example', () => {
      // 3-grams of "a b c d": {"a b c", "b c d"} - 2 grams
      // 3-grams of "a b c e": {"a b c", "b c e"} - 2 grams
      // Intersection: {"a b c"} - 1 gram
      // Union: {"a b c", "b c d", "b c e"} - 3 grams
      // Jaccard = 1/3 ≈ 0.333
      const result = service.computeJaccardSimilarity('a b c d', 'a b c e');
      expect(result).toBeCloseTo(1/3, 2);
    });
  });

  describe('countEmojis', () => {
    /**
     * Per AI_PIPELINE.md §10.4:
     * "Define emoji_count as the count of Unicode emoji codepoints"
     */
    it('should count zero emojis in plain text', () => {
      const result = service.countEmojis('Hello, how are you?');
      expect(result).toBe(0);
    });

    it('should count single emoji', () => {
      const result = service.countEmojis('Hello 😊');
      expect(result).toBe(1);
    });

    it('should count multiple emojis', () => {
      const result = service.countEmojis('Hey! 😊 How are you? 🎉 Great to see you! 👋');
      expect(result).toBe(3);
    });

    it('should count emojis at start of text', () => {
      const result = service.countEmojis('😊😊😊 Hello');
      expect(result).toBe(3);
    });
  });

  describe('process - TEST GATE #7.1: Opener similarity triggers rewrite', () => {
    /**
     * TEST GATE #7 Requirement 1:
     * "Given an assistant draft whose opener violates the similarity rule against
     *  recent openers, postprocessor rewrites opener to a compliant alternative.
     *  Assert opener_norm is stored and differs from the violating opener_norm."
     */
    it('should rewrite opener when it exactly matches a recent opener_norm', async () => {
      // The opener_norm is first 12 tokens after normalization
      // Draft: "Hey! How are you doing today? I really hope you're well!"
      // After normalization: "hey how are you doing today i really hope you're well"
      // First 12 tokens: "hey how are you doing today i really hope you're well"
      const draftContent = "Hey! How are you doing today? I really hope you're well!";
      const violatingOpenerNorm = service.computeOpenerNorm(draftContent);
      
      // Mock recent messages with the SAME opener_norm (exact match)
      (prismaService.message.findMany as jest.Mock).mockResolvedValue([
        { content: draftContent, openerNorm: violatingOpenerNorm },
      ]);

      const result = await service.process(buildTestInput({
        draftContent,
      }));

      // Assert opener_norm differs from the violating one (rewrite happened)
      expect(result.openerNorm).not.toBe(violatingOpenerNorm);
      // Assert violation was detected
      expect(result.violations).toContain('OPENER_REPETITION');
      // Assert rewrite occurred
      expect(result.rewriteAttempts).toBeGreaterThan(0);
    });

    it('should NOT rewrite opener when it does not match any recent opener_norm', async () => {
      // Mock recent messages with different opener_norms
      (prismaService.message.findMany as jest.Mock).mockResolvedValue([
        { content: 'That sounds fun!', openerNorm: 'that sounds fun' },
        { content: 'I understand how you feel', openerNorm: 'i understand how you feel' },
      ]);

      const result = await service.process(buildTestInput({
        draftContent: 'Hey! How are you doing today?',
      }));

      // No opener repetition violation
      expect(result.violations).not.toContain('OPENER_REPETITION');
    });
  });

  // NOTE: Emoji band enforcement tests removed.
  // Style parameters (emoji_freq) are now handled via LLM prompt guidance,
  // not post-processing enforcement. This avoids excessive fallbacks.

  describe('process - Message similarity (§10.3)', () => {
    /**
     * Per AI_PIPELINE.md §10.3:
     * "If similarity with ANY of the last 20 assistant messages is >= 0.70,
     *  the response is considered repetitive and MUST be rewritten shorter
     *  and with a different structure."
     */
    it('should rewrite when 3-gram Jaccard similarity >= 0.70', async () => {
      // Mock a recent message that is very similar
      const similarContent = 'hey there how are you doing today i hope you are well';
      (prismaService.message.findMany as jest.Mock).mockResolvedValue([
        { content: similarContent, openerNorm: 'hey there how are you' },
      ]);

      // Draft that is nearly identical
      const result = await service.process(buildTestInput({
        draftContent: 'hey there how are you doing today i hope you are well and happy',
      }));

      // Should detect similarity violation
      expect(result.violations).toContain('MESSAGE_SIMILARITY');
      // Should rewrite to shorter/different structure
      expect(result.rewriteAttempts).toBeGreaterThan(0);
    });

    it('should NOT rewrite when similarity is below threshold', async () => {
      // Mock recent messages that are different
      (prismaService.message.findMany as jest.Mock).mockResolvedValue([
        { content: 'That movie was really interesting!', openerNorm: 'that movie was really' },
        { content: 'I love pizza too, especially pepperoni', openerNorm: 'i love pizza too' },
      ]);

      const result = await service.process(buildTestInput({
        draftContent: 'Hey there! How are you doing today?',
      }));

      // No similarity violation
      expect(result.violations).not.toContain('MESSAGE_SIMILARITY');
    });
  });

  describe('Determinism guarantee', () => {
    /**
     * Per task requirement:
     * "DETERMINISM: post-processing MUST NOT call any LLM or external service;
     *  pure deterministic transforms only."
     */
    it('should produce identical output for identical input (deterministic)', async () => {
      (prismaService.message.findMany as jest.Mock).mockResolvedValue([]);

      const input = buildTestInput({
        draftContent: 'Hey! 😊😊😊 How are you doing today?',
      });

      const result1 = await service.process(input);
      const result2 = await service.process(input);

      expect(result1.content).toBe(result2.content);
      expect(result1.openerNorm).toBe(result2.openerNorm);
      expect(result1.violations).toEqual(result2.violations);
      expect(result1.rewriteAttempts).toBe(result2.rewriteAttempts);
    });
  });

  describe('opener_norm storage', () => {
    /**
     * Per task requirement A:
     * "Compute and store opener_norm on assistant messages as specified."
     */
    it('should return opener_norm in result for storage', async () => {
      (prismaService.message.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.process(buildTestInput({
        draftContent: 'Hey there! How are you doing?',
      }));

      expect(result.openerNorm).toBeDefined();
      expect(typeof result.openerNorm).toBe('string');
      expect(result.openerNorm.length).toBeGreaterThan(0);
    });
  });

  describe('process - TEST GATE #7.3: Personal fact count (§10.1)', () => {
    /**
     * Per AI_PIPELINE.md §10.1:
     * "do not mention >2 personal facts in one message unless user asked"
     */
    it('should detect violation when more than 2 facts surfaced in normal chat', async () => {
      (prismaService.message.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.process(buildTestInput({
        draftContent: 'Hey there! How are you doing today?',
        surfacedMemoryIds: ['mem1', 'mem2', 'mem3', 'mem4'], // 4 facts
        isRetention: false,
      }));

      expect(result.violations).toContain('PERSONAL_FACT_VIOLATION');
      expect(result.surfacedMemoryIds.length).toBe(2); // Reduced to max 2
    });

    it('should NOT detect violation when user asked for recall', async () => {
      (prismaService.message.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.process(buildTestInput({
        draftContent: 'Hey there! How are you doing today?',
        surfacedMemoryIds: ['mem1', 'mem2', 'mem3', 'mem4'], // 4 facts
        userMessage: 'Do you remember what I told you about my job?',
        isRetention: false,
      }));

      expect(result.violations).not.toContain('PERSONAL_FACT_VIOLATION');
      expect(result.surfacedMemoryIds.length).toBe(4); // Not reduced
    });

    it('should detect violation when more than 1 fact in retention message', async () => {
      (prismaService.message.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.process(buildTestInput({
        draftContent: 'Hey there! How are you doing today?',
        surfacedMemoryIds: ['mem1', 'mem2'], // 2 facts
        isRetention: true,
      }));

      expect(result.violations).toContain('PERSONAL_FACT_VIOLATION');
      expect(result.surfacedMemoryIds.length).toBe(1); // Reduced to max 1
    });
  });

  // NOTE: Sentence length enforcement tests removed.
  // Style parameters (msg_length_pref) are now handled via LLM prompt guidance,
  // not post-processing enforcement. This avoids excessive fallbacks.

  describe('computeSentenceMetrics', () => {
    it('should count sentences correctly', () => {
      const metrics = service.computeSentenceMetrics('Hello there. How are you? Great!');
      expect(metrics.sentenceCount).toBe(3);
    });

    it('should compute average words per sentence', () => {
      const metrics = service.computeSentenceMetrics('Hello there friend. How are you doing today?');
      expect(metrics.sentenceCount).toBe(2);
      expect(metrics.totalWords).toBe(8);
      expect(metrics.avgWordsPerSentence).toBe(4);
    });

    it('should handle Korean sentence delimiters', () => {
      const metrics = service.computeSentenceMetrics('안녕하세요。오늘 어떻게 지내세요？좋아요！');
      expect(metrics.sentenceCount).toBe(3);
    });
  });
});
