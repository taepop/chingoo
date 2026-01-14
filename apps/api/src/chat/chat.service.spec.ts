import { Test, TestingModule } from '@nestjs/testing';
import { ChatService } from './chat.service';
import { PrismaService } from '../prisma/prisma.service';
import { TraceService } from '../trace/trace.service';
import { RouterService } from '../router/router.service';
import { TopicMatchService } from '../topicmatch/topicmatch.service';
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
 */
describe('ChatService', () => {
  let service: ChatService;
  let prismaService: jest.Mocked<PrismaService>;
  let traceService: jest.Mocked<TraceService>;
  let routerService: jest.Mocked<RouterService>;
  let topicMatchService: jest.Mocked<TopicMatchService>;

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: TraceService, useValue: mockTraceService },
        { provide: RouterService, useValue: mockRouterService },
        { provide: TopicMatchService, useValue: mockTopicMatchService },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
    prismaService = module.get(PrismaService);
    traceService = module.get(TraceService);
    routerService = module.get(RouterService);
    topicMatchService = module.get(TopicMatchService);
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
  });
});
