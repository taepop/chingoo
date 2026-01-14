import { Test, TestingModule } from '@nestjs/testing';
import { ChatService } from './chat.service';
import { PrismaService } from '../prisma/prisma.service';
import { TraceService } from '../trace/trace.service';
import { RouterService } from '../router/router.service';
import { TopicMatchService } from '../topicmatch/topicmatch.service';
import { MemoryService } from '../memory/memory.service';
import { PostProcessorService } from '../postprocessor/postprocessor.service';
import {
  ChatRequestDto,
  UserState,
} from '@chingoo/shared';
import { ForbiddenException, BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'crypto';

/**
 * ChatService Unit Tests
 * 
 * Tests core logic for:
 * - Idempotency handling (COMPLETED, RECEIVED/PROCESSING)
 * - ONBOARDING → ACTIVE transition validation
 * - Deterministic assistant message ID generation
 * - Input validation
 * - Q11: Memory extraction + surfacing + correction targeting
 * - Q12: PostProcessor integration + persistence order invariant
 */
describe('ChatService', () => {
  let service: ChatService;
  let prismaService: jest.Mocked<PrismaService>;
  let traceService: jest.Mocked<TraceService>;
  let routerService: jest.Mocked<RouterService>;
  let topicMatchService: jest.Mocked<TopicMatchService>;
  let memoryService: jest.Mocked<MemoryService>;
  let postProcessorService: jest.Mocked<PostProcessorService>;

  const ASSISTANT_MSG_NAMESPACE = 'chingoo-assistant-message-v1';
  
  // Helper to derive assistant message ID (same logic as service)
  function deriveAssistantMessageId(userMessageId: string): string {
    const hash = createHash('sha256')
      .update(ASSISTANT_MSG_NAMESPACE + userMessageId)
      .digest('hex');
    return [
      hash.substring(0, 8),
      hash.substring(8, 12),
      hash.substring(12, 16),
      hash.substring(16, 20),
      hash.substring(20, 32),
    ].join('-');
  }

  beforeEach(async () => {
    const mockPrismaService = {
      message: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      conversation: {
        findUnique: jest.fn(),
      },
      user: {
        update: jest.fn(),
      },
      userOnboardingAnswers: {
        findUnique: jest.fn(),
      },
      relationship: {
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    const mockTraceService = {
      getTraceId: jest.fn().mockReturnValue('mock-trace-id'),
    };

    // Q10: Mock RouterService to return deterministic routing decisions
    const mockRouterService = {
      route: jest.fn().mockReturnValue({
        topic_id: null,
        confidence: 0,
        route: 'friend_chat',
        pipeline: 'FRIEND_CHAT',
        safety_policy: 'ALLOW',
        memory_read_policy: 'FULL',
        memory_write_policy: 'SELECTIVE',
        vector_search_policy: 'ON_DEMAND',
        relationship_update_policy: 'ON',
        retrieval_query_text: null,
        notes: null,
      }),
    };

    // Q10: Mock TopicMatchService to return empty topic matches
    const mockTopicMatchService = {
      computeTopicMatches: jest.fn().mockReturnValue([]),
    };

    // Q11: Mock MemoryService
    const mockMemoryService = {
      handleCorrection: jest.fn().mockResolvedValue({
        invalidated_memory_ids: [],
        needs_clarification: false,
        suppressed_keys_added: [],
      }),
      selectMemoriesForSurfacing: jest.fn().mockResolvedValue([]),
      extractAndPersist: jest.fn().mockResolvedValue([]),
      extractMemoryCandidates: jest.fn().mockReturnValue([]),
      persistMemoryCandidate: jest.fn().mockResolvedValue('mock-memory-id'),
    };

    // Q12: Mock PostProcessorService
    const mockPostProcessorService = {
      process: jest.fn().mockResolvedValue({
        content: 'Post-processed content',
        openerNorm: 'post processed content',
        violations: [],
        rewriteAttempts: 0,
      }),
      computeOpenerNorm: jest.fn().mockReturnValue('test opener norm'),
      computeJaccardSimilarity: jest.fn().mockReturnValue(0),
      countEmojis: jest.fn().mockReturnValue(0),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: TraceService, useValue: mockTraceService },
        { provide: RouterService, useValue: mockRouterService },
        { provide: TopicMatchService, useValue: mockTopicMatchService },
        { provide: MemoryService, useValue: mockMemoryService },
        { provide: PostProcessorService, useValue: mockPostProcessorService },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
    prismaService = module.get(PrismaService);
    traceService = module.get(TraceService);
    routerService = module.get(RouterService);
    topicMatchService = module.get(TopicMatchService);
    memoryService = module.get(MemoryService);
    postProcessorService = module.get(PostProcessorService);
  });

  describe('sendMessage', () => {
    const mockUserId = '550e8400-e29b-41d4-a716-446655440000';
    const mockMessageId = '550e8400-e29b-41d4-a716-446655440001';
    const mockConversationId = '550e8400-e29b-41d4-a716-446655440002';

    const validDto: ChatRequestDto = {
      message_id: mockMessageId,
      conversation_id: mockConversationId,
      user_message: 'Hello!',
      local_timestamp: new Date().toISOString(),
      user_timezone: 'America/New_York',
    };

    describe('User state validation', () => {
      it('should throw ForbiddenException for CREATED user state', async () => {
        await expect(
          service.sendMessage(mockUserId, UserState.CREATED, validDto),
        ).rejects.toThrow(ForbiddenException);
      });
    });

    describe('Input validation', () => {
      it('should throw BadRequestException for missing message_id', async () => {
        const invalidDto = { ...validDto, message_id: '' };
        await expect(
          service.sendMessage(mockUserId, UserState.ACTIVE, invalidDto),
        ).rejects.toThrow(BadRequestException);
      });

      it('should throw BadRequestException for invalid UUID message_id', async () => {
        const invalidDto = { ...validDto, message_id: 'not-a-uuid' };
        await expect(
          service.sendMessage(mockUserId, UserState.ACTIVE, invalidDto),
        ).rejects.toThrow(BadRequestException);
      });

      it('should throw BadRequestException for user_message exceeding 4000 chars', async () => {
        const invalidDto = { ...validDto, user_message: 'x'.repeat(4001) };
        await expect(
          service.sendMessage(mockUserId, UserState.ACTIVE, invalidDto),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('Idempotency - COMPLETED message', () => {
      it('should return stored assistant response for COMPLETED message', async () => {
        const assistantMsgId = deriveAssistantMessageId(mockMessageId);
        const mockCreatedAt = new Date();

        // Setup: existing COMPLETED message
        (prismaService.message.findUnique as jest.Mock)
          .mockResolvedValueOnce({
            id: mockMessageId,
            status: 'COMPLETED',
            traceId: 'trace-123',
          })
          .mockResolvedValueOnce({
            id: assistantMsgId,
            content: 'Stored response',
            createdAt: mockCreatedAt,
          })
          .mockResolvedValueOnce({
            id: mockMessageId,
            user: { id: mockUserId, state: 'ACTIVE' },
          });

        const result = await service.sendMessage(mockUserId, UserState.ACTIVE, validDto);

        expect(result.message_id).toBe(mockMessageId);
        expect(result.assistant_message.id).toBe(assistantMsgId);
        expect(result.assistant_message.content).toBe('Stored response');
      });
    });

    describe('Idempotency - PROCESSING message', () => {
      it('should throw ConflictException (409) for PROCESSING message', async () => {
        // Setup: existing PROCESSING message
        (prismaService.message.findUnique as jest.Mock).mockResolvedValueOnce({
          id: mockMessageId,
          status: 'PROCESSING',
          traceId: 'trace-123',
        });

        await expect(
          service.sendMessage(mockUserId, UserState.ACTIVE, validDto),
        ).rejects.toThrow(ConflictException);
      });

      it('should throw ConflictException (409) for RECEIVED message', async () => {
        // Setup: existing RECEIVED message
        (prismaService.message.findUnique as jest.Mock).mockResolvedValueOnce({
          id: mockMessageId,
          status: 'RECEIVED',
          traceId: 'trace-123',
        });

        await expect(
          service.sendMessage(mockUserId, UserState.ACTIVE, validDto),
        ).rejects.toThrow(ConflictException);
      });
    });

    describe('ONBOARDING validation', () => {
      it('should throw ForbiddenException when persona is not assigned', async () => {
        // No existing message
        (prismaService.message.findUnique as jest.Mock).mockResolvedValueOnce(null);

        // Conversation exists with unassigned persona
        (prismaService.conversation.findUnique as jest.Mock).mockResolvedValueOnce({
          id: mockConversationId,
          userId: mockUserId,
          aiFriendId: 'ai-friend-123',
          aiFriend: {
            personaTemplateId: null,
            stableStyleParams: null,
          },
          user: {
            id: mockUserId,
            state: 'ONBOARDING',
            onboardingAnswers: {},
          },
        });

        // Onboarding answers exist
        (prismaService.userOnboardingAnswers.findUnique as jest.Mock).mockResolvedValueOnce({
          userId: mockUserId,
          preferredName: 'Test',
          ageBand: 'AGE_18_24',
        });

        await expect(
          service.sendMessage(mockUserId, UserState.ONBOARDING, validDto),
        ).rejects.toThrow(ForbiddenException);
      });

      it('should throw ForbiddenException when onboarding answers missing', async () => {
        // No existing message
        (prismaService.message.findUnique as jest.Mock).mockResolvedValueOnce(null);

        // Conversation exists
        (prismaService.conversation.findUnique as jest.Mock).mockResolvedValueOnce({
          id: mockConversationId,
          userId: mockUserId,
          aiFriendId: 'ai-friend-123',
          aiFriend: {
            personaTemplateId: 'PT01',
            stableStyleParams: {},
          },
          user: {
            id: mockUserId,
            state: 'ONBOARDING',
            onboardingAnswers: null,
          },
        });

        // No onboarding answers
        (prismaService.userOnboardingAnswers.findUnique as jest.Mock).mockResolvedValueOnce(null);

        await expect(
          service.sendMessage(mockUserId, UserState.ONBOARDING, validDto),
        ).rejects.toThrow(ForbiddenException);
      });
    });

    describe('Deterministic assistant message ID', () => {
      it('should generate consistent assistant ID from message_id using SHA-256', () => {
        const testMessageId = '550e8400-e29b-41d4-a716-446655440000';
        const expectedAssistantId = deriveAssistantMessageId(testMessageId);

        // Call twice with same input - should get same output
        const result1 = deriveAssistantMessageId(testMessageId);
        const result2 = deriveAssistantMessageId(testMessageId);

        expect(result1).toBe(expectedAssistantId);
        expect(result2).toBe(expectedAssistantId);
        expect(result1).not.toBe(testMessageId); // Different from input
        // Verify it looks like a UUID format
        expect(result1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      });
    });

    /**
     * TEST GATE #7.3: Persistence order invariant (regression safety for Q9 replay)
     * 
     * Per task requirement:
     * "CRITICAL ORDER INVARIANT: post-processing MUST happen BEFORE assistant message persistence.
     *  The stored assistant message content in DB MUST be the post-processed output
     *  so idempotency replay returns the enforced version."
     */
    describe('Q12 - PostProcessor Integration', () => {
      it('should call PostProcessor BEFORE persisting assistant message', async () => {
        const mockCreatedAt = new Date();
        const postProcessedContent = 'Post-processed response content';
        const postProcessedOpenerNorm = 'post processed response content';

        // No existing message (new message)
        (prismaService.message.findUnique as jest.Mock).mockResolvedValueOnce(null);

        // Conversation exists with persona
        (prismaService.conversation.findUnique as jest.Mock).mockResolvedValueOnce({
          id: mockConversationId,
          userId: mockUserId,
          aiFriendId: 'ai-friend-123',
          aiFriend: {
            id: 'ai-friend-123',
            personaTemplateId: 'PT01',
            stableStyleParams: { emoji_freq: 'light' },
          },
          user: {
            id: mockUserId,
            state: 'ACTIVE',
            onboardingAnswers: {},
          },
        });

        // Mock PostProcessor to return specific content
        (postProcessorService.process as jest.Mock).mockResolvedValueOnce({
          content: postProcessedContent,
          openerNorm: postProcessedOpenerNorm,
          violations: [],
          rewriteAttempts: 0,
        });

        // Track what gets created in transaction
        let createdAssistantContent: string | undefined;
        let createdOpenerNorm: string | undefined;
        (prismaService.$transaction as jest.Mock).mockImplementation(async (callback: Function) => {
          const txMock = {
            message: {
              create: jest.fn().mockImplementation((args: { data: { content: string; openerNorm?: string } }) => {
                if (args.data.content) {
                  // This is either user or assistant message
                  if (args.data.openerNorm !== undefined) {
                    // Assistant message has openerNorm
                    createdAssistantContent = args.data.content;
                    createdOpenerNorm = args.data.openerNorm;
                  }
                }
                return { id: 'mock-id', content: args.data.content, createdAt: mockCreatedAt };
              }),
              update: jest.fn(),
            },
            user: { update: jest.fn() },
            relationship: { updateMany: jest.fn() },
          };
          const result = await callback(txMock);
          return {
            newState: 'ACTIVE',
            assistantMessage: { id: 'mock-id', content: createdAssistantContent, createdAt: mockCreatedAt },
          };
        });

        await service.sendMessage(mockUserId, UserState.ACTIVE, validDto);

        // Assert PostProcessor was called
        expect(postProcessorService.process).toHaveBeenCalledWith(
          expect.objectContaining({
            conversationId: mockConversationId,
            emojiFreq: 'light',
          }),
        );

        // Assert the stored content is the post-processed content
        expect(createdAssistantContent).toBe(postProcessedContent);
        expect(createdOpenerNorm).toBe(postProcessedOpenerNorm);
      });

      it('should store opener_norm on assistant message per AI_PIPELINE.md §10.2', async () => {
        const mockCreatedAt = new Date();
        const expectedOpenerNorm = 'hey how are you doing';

        // No existing message
        (prismaService.message.findUnique as jest.Mock).mockResolvedValueOnce(null);

        // Conversation exists
        (prismaService.conversation.findUnique as jest.Mock).mockResolvedValueOnce({
          id: mockConversationId,
          userId: mockUserId,
          aiFriendId: 'ai-friend-123',
          aiFriend: {
            id: 'ai-friend-123',
            personaTemplateId: 'PT01',
            stableStyleParams: { emoji_freq: 'none' },
          },
          user: {
            id: mockUserId,
            state: 'ACTIVE',
          },
        });

        // Mock PostProcessor
        (postProcessorService.process as jest.Mock).mockResolvedValueOnce({
          content: 'Hey! How are you doing?',
          openerNorm: expectedOpenerNorm,
          violations: [],
          rewriteAttempts: 0,
        });

        let storedOpenerNorm: string | null = null;
        (prismaService.$transaction as jest.Mock).mockImplementation(async (callback: Function) => {
          const txMock = {
            message: {
              create: jest.fn().mockImplementation((args: { data: { openerNorm?: string | null } }) => {
                if (args.data.openerNorm !== undefined) {
                  storedOpenerNorm = args.data.openerNorm ?? null;
                }
                return { id: 'mock-id', content: 'test', createdAt: mockCreatedAt };
              }),
              update: jest.fn(),
            },
            user: { update: jest.fn() },
            relationship: { updateMany: jest.fn() },
          };
          await callback(txMock);
          return {
            newState: 'ACTIVE',
            assistantMessage: { id: 'mock-id', content: 'test', createdAt: mockCreatedAt },
          };
        });

        await service.sendMessage(mockUserId, UserState.ACTIVE, validDto);

        // Assert opener_norm was stored
        expect(storedOpenerNorm).toBe(expectedOpenerNorm);
      });

      it('should use default emoji_freq=light when stableStyleParams is missing', async () => {
        const mockCreatedAt = new Date();

        // No existing message
        (prismaService.message.findUnique as jest.Mock).mockResolvedValueOnce(null);

        // Conversation exists WITHOUT stableStyleParams
        (prismaService.conversation.findUnique as jest.Mock).mockResolvedValueOnce({
          id: mockConversationId,
          userId: mockUserId,
          aiFriendId: 'ai-friend-123',
          aiFriend: {
            id: 'ai-friend-123',
            personaTemplateId: 'PT01',
            stableStyleParams: null, // Missing
          },
          user: {
            id: mockUserId,
            state: 'ACTIVE',
          },
        });

        (postProcessorService.process as jest.Mock).mockResolvedValueOnce({
          content: 'Test content',
          openerNorm: 'test content',
          violations: [],
          rewriteAttempts: 0,
        });

        (prismaService.$transaction as jest.Mock).mockImplementation(async (callback: Function) => {
          const txMock = {
            message: { create: jest.fn().mockReturnValue({ id: 'id', content: 'c', createdAt: mockCreatedAt }), update: jest.fn() },
            user: { update: jest.fn() },
            relationship: { updateMany: jest.fn() },
          };
          await callback(txMock);
          return { newState: 'ACTIVE', assistantMessage: { id: 'id', content: 'c', createdAt: mockCreatedAt } };
        });

        await service.sendMessage(mockUserId, UserState.ACTIVE, validDto);

        // Assert PostProcessor was called with default emoji_freq='light'
        expect(postProcessorService.process).toHaveBeenCalledWith(
          expect.objectContaining({
            emojiFreq: 'light',
          }),
        );
      });
    });
  });
});
