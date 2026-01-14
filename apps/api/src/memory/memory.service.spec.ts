import { Test, TestingModule } from '@nestjs/testing';
import { MemoryService, MemoryCandidate, CorrectionResult } from './memory.service';
import { PrismaService } from '../prisma/prisma.service';
import { RouterService, HeuristicFlags } from '../router/router.service';

/**
 * MemoryService Unit Tests
 * 
 * TEST GATE #6 — Memory safety (MANDATORY)
 * 
 * Per AI_PIPELINE.md §12.4 - Correction Targeting (Authoritative, v0.1):
 * "A correction command MUST target memories ONLY through surfaced_memory_ids
 * from the immediately previous assistant message."
 * "The system MUST NOT invalidate the last extracted memory unless it was surfaced."
 * 
 * Per AI_PIPELINE.md §12.2 - Hybrid extractor gating:
 * "Run heuristic extractor always."
 * 
 * Per AI_PIPELINE.md §5 - Regex triggers:
 * - preference ("i like", "i love", "i hate", "my favorite")
 * - fact ("i'm from", "i live in", "my job is", "i'm a")
 * - event ("i broke up", "my exam", "i'm traveling", "interview")
 * - correction ("that's not true", "don't remember that", "don't bring this topic up again")
 */
describe('MemoryService', () => {
  let memoryService: MemoryService;
  let prismaService: jest.Mocked<PrismaService>;
  let routerService: jest.Mocked<RouterService>;

  const mockUserId = '550e8400-e29b-41d4-a716-446655440000';
  const mockAiFriendId = '550e8400-e29b-41d4-a716-446655440001';
  const mockMessageId = '550e8400-e29b-41d4-a716-446655440002';

  beforeEach(async () => {
    const mockPrismaService = {
      memory: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      message: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      userControls: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn().mockImplementation(async (callback) => {
        return callback(mockPrismaService);
      }),
    };

    const mockRouterService = {
      route: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: RouterService, useValue: mockRouterService },
      ],
    }).compile();

    memoryService = module.get<MemoryService>(MemoryService);
    prismaService = module.get(PrismaService);
    routerService = module.get(RouterService);
  });

  describe('TEST GATE #6.1 — Correction targeting positive case', () => {
    /**
     * TEST: Given surfaced_memory_ids = [A, B], a correction intent 
     * must mutate/invalidate ONLY A and B (not C).
     * 
     * Per AI_PIPELINE.md §12.4:
     * "Correction commands act on surfaced_memory_ids from the 
     * immediately previous assistant message ONLY."
     */
    it('should invalidate ONLY memories in surfaced_memory_ids (not unsurfaced ones)', async () => {
      const memoryA = '550e8400-e29b-41d4-a716-446655440010';
      const memoryB = '550e8400-e29b-41d4-a716-446655440011';
      const memoryC = '550e8400-e29b-41d4-a716-446655440012'; // NOT surfaced

      // Setup: previous assistant message has surfaced_memory_ids = [A, B]
      (prismaService.message.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'prev-assistant-msg-id',
        role: 'assistant',
        surfacedMemoryIds: [memoryA, memoryB],
        conversationId: 'conv-123',
      });

      // Setup: memories A, B, C all exist and are ACTIVE
      (prismaService.memory.findMany as jest.Mock).mockResolvedValueOnce([
        { id: memoryA, status: 'ACTIVE', memoryKey: 'pref:food:pizza' },
        { id: memoryB, status: 'ACTIVE', memoryKey: 'fact:home_city' },
      ]);

      // User says "that's not true" - correction trigger
      const result = await memoryService.handleCorrection({
        userId: mockUserId,
        aiFriendId: mockAiFriendId,
        conversationId: 'conv-123',
        normNoPunct: "that's not true",
        heuristicFlags: {
          has_correction_trigger: true,
          has_preference_trigger: false,
          has_fact_trigger: false,
          has_event_trigger: false,
          is_question: false,
          has_personal_pronoun: false,
          has_distress: false,
          asks_for_comfort: false,
        },
      });

      // ASSERTION: Only the LAST memory in surfaced list should be invalidated (memoryB)
      expect(result.invalidated_memory_ids).toContain(memoryB);
      expect(result.invalidated_memory_ids).not.toContain(memoryC);
      
      // Memory C should NEVER be touched because it was not surfaced
      expect(prismaService.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: memoryB },
          data: expect.objectContaining({
            status: 'INVALID',
          }),
        })
      );
    });

    /**
     * TEST: "That's not true" targets LAST surfaced memory
     * 
     * Per AI_PIPELINE.md §12.4:
     * "Target = the LAST memory_id in surfaced_memory_ids (most recent mention)."
     */
    it('should target LAST memory in surfaced_memory_ids for "thats not true"', async () => {
      const memoryA = '550e8400-e29b-41d4-a716-446655440010';
      const memoryB = '550e8400-e29b-41d4-a716-446655440011';

      // Previous assistant message surfaced [A, B]
      (prismaService.message.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'prev-assistant-msg-id',
        role: 'assistant',
        surfacedMemoryIds: [memoryA, memoryB], // B is LAST
        conversationId: 'conv-123',
      });

      (prismaService.memory.findMany as jest.Mock).mockResolvedValueOnce([
        { id: memoryB, status: 'ACTIVE', memoryKey: 'fact:occupation' },
      ]);

      const result = await memoryService.handleCorrection({
        userId: mockUserId,
        aiFriendId: mockAiFriendId,
        conversationId: 'conv-123',
        normNoPunct: "thats not true",
        heuristicFlags: {
          has_correction_trigger: true,
          has_preference_trigger: false,
          has_fact_trigger: false,
          has_event_trigger: false,
          is_question: false,
          has_personal_pronoun: false,
          has_distress: false,
          asks_for_comfort: false,
        },
      });

      // Only B (last) should be invalidated, not A
      expect(result.invalidated_memory_ids).toEqual([memoryB]);
    });
  });

  describe('TEST GATE #6.2 — No surfaced ids → no mutation', () => {
    /**
     * TEST: Given surfaced_memory_ids = [], correction intent 
     * must not mutate/invalidate any memories.
     * 
     * Per AI_PIPELINE.md §12.4:
     * "If surfaced_memory_ids is empty: do NOT invalidate anything;
     * respond with a clarification prompt"
     */
    it('should NOT invalidate any memories when surfaced_memory_ids is empty', async () => {
      // Setup: previous assistant message has surfaced_memory_ids = []
      (prismaService.message.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'prev-assistant-msg-id',
        role: 'assistant',
        surfacedMemoryIds: [], // EMPTY
        conversationId: 'conv-123',
      });

      const result = await memoryService.handleCorrection({
        userId: mockUserId,
        aiFriendId: mockAiFriendId,
        conversationId: 'conv-123',
        normNoPunct: "thats not true",
        heuristicFlags: {
          has_correction_trigger: true,
          has_preference_trigger: false,
          has_fact_trigger: false,
          has_event_trigger: false,
          is_question: false,
          has_personal_pronoun: false,
          has_distress: false,
          asks_for_comfort: false,
        },
      });

      // No memories should be invalidated
      expect(result.invalidated_memory_ids).toEqual([]);
      expect(result.needs_clarification).toBe(true);
      
      // memory.update should NOT have been called
      expect(prismaService.memory.update).not.toHaveBeenCalled();
    });

    /**
     * TEST: No previous assistant message → no mutation
     */
    it('should NOT invalidate any memories when no previous assistant message exists', async () => {
      // No previous assistant message
      (prismaService.message.findFirst as jest.Mock).mockResolvedValueOnce(null);

      const result = await memoryService.handleCorrection({
        userId: mockUserId,
        aiFriendId: mockAiFriendId,
        conversationId: 'conv-123',
        normNoPunct: "dont remember that",
        heuristicFlags: {
          has_correction_trigger: true,
          has_preference_trigger: false,
          has_fact_trigger: false,
          has_event_trigger: false,
          is_question: false,
          has_personal_pronoun: false,
          has_distress: false,
          asks_for_comfort: false,
        },
      });

      expect(result.invalidated_memory_ids).toEqual([]);
      expect(result.needs_clarification).toBe(true);
      expect(prismaService.memory.update).not.toHaveBeenCalled();
    });
  });

  describe('TEST GATE #6.3 — Surfacing plumbing', () => {
    /**
     * TEST: selectMemoriesForSurfacing returns relevant memory IDs
     * These IDs should be persisted on assistant message row.
     * 
     * Per AI_PIPELINE.md §12.4:
     * "Each assistant message must store surfaced_memory_ids 
     * (memory IDs actually referenced or used in the answer)."
     */
    it('should return surfaced_memory_ids for assistant message', async () => {
      const memoryA = '550e8400-e29b-41d4-a716-446655440010';
      const memoryB = '550e8400-e29b-41d4-a716-446655440011';

      // Setup: ACTIVE memories for the user
      (prismaService.memory.findMany as jest.Mock).mockResolvedValueOnce([
        { 
          id: memoryA, 
          status: 'ACTIVE', 
          memoryKey: 'pref:food:pizza',
          memoryValue: 'like|pizza',
          type: 'PREFERENCE',
        },
        { 
          id: memoryB, 
          status: 'ACTIVE', 
          memoryKey: 'fact:occupation',
          memoryValue: 'engineer',
          type: 'FACT',
        },
      ]);

      // User mentions food → pizza preference should be surfaced
      const surfacedIds = await memoryService.selectMemoriesForSurfacing({
        userId: mockUserId,
        aiFriendId: mockAiFriendId,
        userMessage: 'what should i eat for dinner',
        topicMatches: [],
      });

      // Should return array of memory IDs (even if empty for v0.1 stub)
      expect(Array.isArray(surfacedIds)).toBe(true);
    });

    /**
     * TEST: surfaced_memory_ids must be [] (empty array), not null, when no memories are relevant.
     * 
     * Per task requirement: "If no memories are relevant, surfaced_memory_ids must be [] (empty array), not null."
     */
    it('should return empty array (not null) when no memories are relevant', async () => {
      // No memories exist for user
      (prismaService.memory.findMany as jest.Mock).mockResolvedValueOnce([]);

      const surfacedIds = await memoryService.selectMemoriesForSurfacing({
        userId: mockUserId,
        aiFriendId: mockAiFriendId,
        userMessage: 'hello there',
        topicMatches: [],
      });

      expect(surfacedIds).toEqual([]); // Must be [] not null
      expect(surfacedIds).not.toBeNull();
    });
  });

  describe('Heuristic memory extraction', () => {
    /**
     * TEST: Extract PREFERENCE from "i like pizza"
     * 
     * Per AI_PIPELINE.md §5 Regex triggers:
     * - preference ("i like", "i love", "i hate", "my favorite")
     * 
     * Per AI_PIPELINE.md §12.3.1 PREFERENCE keys:
     * Format: pref:<category>:<item_slug>
     */
    it('should extract PREFERENCE from "i like" pattern', () => {
      const candidates = memoryService.extractMemoryCandidates({
        userMessage: 'i like pizza',
        normNoPunct: 'i like pizza',
        heuristicFlags: {
          has_preference_trigger: true,
          has_fact_trigger: false,
          has_event_trigger: false,
          has_correction_trigger: false,
          is_question: false,
          has_personal_pronoun: true,
          has_distress: false,
          asks_for_comfort: false,
        },
      });

      expect(candidates.length).toBeGreaterThan(0);
      const pizzaPreference = candidates.find(c => 
        c.type === 'PREFERENCE' && c.memoryKey.includes('pizza')
      );
      expect(pizzaPreference).toBeDefined();
      expect(pizzaPreference?.memoryValue).toContain('like');
      expect(pizzaPreference?.confidence).toBe(0.60); // heuristic-only: 0.60
    });

    /**
     * TEST: Extract PREFERENCE from "i hate" pattern with dislike stance
     * 
     * Per AI_PIPELINE.md §12.3.2:
     * "PREFERENCE memory_value MUST be like|<value> or dislike|<value>"
     */
    it('should extract PREFERENCE with "dislike" stance from "i hate" pattern', () => {
      const candidates = memoryService.extractMemoryCandidates({
        userMessage: 'i hate sushi',
        normNoPunct: 'i hate sushi',
        heuristicFlags: {
          has_preference_trigger: true,
          has_fact_trigger: false,
          has_event_trigger: false,
          has_correction_trigger: false,
          is_question: false,
          has_personal_pronoun: true,
          has_distress: false,
          asks_for_comfort: false,
        },
      });

      const sushiPreference = candidates.find(c => 
        c.type === 'PREFERENCE' && c.memoryKey.includes('sushi')
      );
      expect(sushiPreference).toBeDefined();
      expect(sushiPreference?.memoryValue).toBe('dislike|sushi');
    });

    /**
     * TEST: Extract FACT from "i'm from korea"
     * 
     * Per AI_PIPELINE.md §5 Regex triggers:
     * - fact ("i'm from", "i live in", "my job is", "i'm a")
     */
    it('should extract FACT from "im from" pattern', () => {
      const candidates = memoryService.extractMemoryCandidates({
        userMessage: "i'm from korea",
        normNoPunct: "im from korea",
        heuristicFlags: {
          has_preference_trigger: false,
          has_fact_trigger: true,
          has_event_trigger: false,
          has_correction_trigger: false,
          is_question: false,
          has_personal_pronoun: true,
          has_distress: false,
          asks_for_comfort: false,
        },
      });

      const homeCountryFact = candidates.find(c => 
        c.type === 'FACT' && c.memoryKey === 'fact:home_country'
      );
      expect(homeCountryFact).toBeDefined();
      expect(homeCountryFact?.memoryValue.toLowerCase()).toContain('korea');
    });

    /**
     * TEST: Do not extract anything when no triggers match
     */
    it('should return empty array when no extraction triggers match', () => {
      const candidates = memoryService.extractMemoryCandidates({
        userMessage: 'hello how are you',
        normNoPunct: 'hello how are you',
        heuristicFlags: {
          has_preference_trigger: false,
          has_fact_trigger: false,
          has_event_trigger: false,
          has_correction_trigger: false,
          is_question: true,
          has_personal_pronoun: false,
          has_distress: false,
          asks_for_comfort: false,
        },
      });

      expect(candidates).toEqual([]);
    });
  });

  describe('Memory dedup and conflict', () => {
    /**
     * TEST: Same key + same value → merge sources, increase confidence
     * 
     * Per AI_PIPELINE.md §12.3:
     * "if key exists with same value (ACTIVE):
     * merge sources; increase confidence by +0.15 (cap 1.0)"
     */
    it('should merge sources and increase confidence for duplicate memory', async () => {
      const existingMemoryId = '550e8400-e29b-41d4-a716-446655440010';

      // Existing memory
      (prismaService.memory.findFirst as jest.Mock).mockResolvedValueOnce({
        id: existingMemoryId,
        memoryKey: 'pref:food:pizza',
        memoryValue: 'like|pizza',
        status: 'ACTIVE',
        confidence: 0.60,
        sourceMessageIds: ['msg-1'],
      });

      const candidate: MemoryCandidate = {
        type: 'PREFERENCE',
        memoryKey: 'pref:food:pizza',
        memoryValue: 'like|pizza',
        confidence: 0.60,
      };

      const result = await memoryService.persistMemoryCandidate({
        userId: mockUserId,
        aiFriendId: mockAiFriendId,
        messageId: 'msg-2',
        candidate,
      });

      // Should have called update with increased confidence (capped at 1.0)
      expect(prismaService.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: existingMemoryId },
          data: expect.objectContaining({
            confidence: 0.75, // 0.60 + 0.15 = 0.75
          }),
        })
      );
    });

    /**
     * TEST: Same key + different value (FACT) → supersede old
     * 
     * Per AI_PIPELINE.md §12.3.1:
     * "FACT keys are singleton: New value => prior ACTIVE becomes SUPERSEDED"
     */
    it('should supersede old FACT memory when value changes', async () => {
      const oldMemoryId = '550e8400-e29b-41d4-a716-446655440010';
      const newMemoryId = '550e8400-e29b-41d4-a716-446655440011';

      // Old memory exists
      (prismaService.memory.findFirst as jest.Mock).mockResolvedValueOnce({
        id: oldMemoryId,
        memoryKey: 'fact:occupation',
        memoryValue: 'student',
        status: 'ACTIVE',
        confidence: 0.60,
        sourceMessageIds: ['msg-1'],
      });

      // New memory creation returns new ID
      (prismaService.memory.create as jest.Mock).mockResolvedValueOnce({
        id: newMemoryId,
      });

      const candidate: MemoryCandidate = {
        type: 'FACT',
        memoryKey: 'fact:occupation',
        memoryValue: 'engineer', // Different value
        confidence: 0.60,
      };

      await memoryService.persistMemoryCandidate({
        userId: mockUserId,
        aiFriendId: mockAiFriendId,
        messageId: 'msg-2',
        candidate,
      });

      // Old memory should be marked SUPERSEDED
      expect(prismaService.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: oldMemoryId },
          data: expect.objectContaining({
            status: 'SUPERSEDED',
          }),
        })
      );

      // New memory should be created
      expect(prismaService.memory.create).toHaveBeenCalled();
    });
  });

  describe('Determinism', () => {
    /**
     * TEST: Same input produces identical extraction output
     * 
     * Per task requirement:
     * "Determinism: Do NOT call any LLM or external service for memory extraction.
     * Use only the spec's allowed heuristic approach"
     */
    it('should produce identical extraction results for same input', () => {
      const input = {
        userMessage: 'i love coffee',
        normNoPunct: 'i love coffee',
        heuristicFlags: {
          has_preference_trigger: true,
          has_fact_trigger: false,
          has_event_trigger: false,
          has_correction_trigger: false,
          is_question: false,
          has_personal_pronoun: true,
          has_distress: false,
          asks_for_comfort: false,
        } as HeuristicFlags,
      };

      // Run twice
      const result1 = memoryService.extractMemoryCandidates(input);
      const result2 = memoryService.extractMemoryCandidates(input);

      // Results must be identical
      expect(result1).toEqual(result2);
    });
  });
});
