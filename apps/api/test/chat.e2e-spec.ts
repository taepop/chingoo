import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LlmService } from '../src/llm/llm.service';
import {
  UserState,
  ChatRequestDto,
  ChatResponseDto,
  OnboardingRequestDto,
  AgeBand,
  OccupationCategory,
  TopicId,
  ApiErrorDto,
} from '@chingoo/shared';
import * as jwt from 'jsonwebtoken';

/**
 * Mock LLM Service for E2E tests
 * 
 * Per task requirement: "For tests, mock the LLM call so CI is deterministic (no network calls during tests)"
 */
class MockLlmService {
  async generate(context: { isFirstMessage?: boolean; pipeline?: string }): Promise<string> {
    // Deterministic responses for testing
    if (context.pipeline === 'REFUSAL') {
      return 'Please complete onboarding before chatting.';
    }
    if (context.isFirstMessage) {
      return "Hey! It's great to meet you. I'm really happy you're here. What's on your mind?";
    }
    return "I hear you! That's really interesting. Tell me more about that.";
  }
}

/**
 * Chat E2E Tests for POST /chat/send
 * 
 * Per API_CONTRACT.md §3 and SPEC_PATCH.md:
 * - Idempotency by message_id
 * - ONBOARDING → ACTIVE atomic transition
 * - INSERT new assistant message row (SPEC_PATCH override)
 * - surfaced_memory_ids field
 */
describe('Chat E2E (POST /chat/send)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const TEST_COGNITO_SUB = 'chat-test-user-sub';

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';
    process.env.DEV_BYPASS_AUTH = 'true';
    process.env.DEV_USER_SUB = TEST_COGNITO_SUB;
    if (!process.env.DATABASE_URL) {
      process.env.DATABASE_URL = 'postgresql://chingoo:chingoo@localhost:5432/chingoo';
    }

    // Q13: Override LlmService with mock to avoid network calls in CI
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LlmService)
      .useClass(MockLlmService)
      .compile();

    app = moduleFixture.createNestApplication(new FastifyAdapter());
    prisma = moduleFixture.get<PrismaService>(PrismaService);

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Clean up test user
    await prisma.user.deleteMany({
      where: {
        cognitoSub: {
          startsWith: 'chat-test',
        },
      },
    });
  });

  // Helper: Get auth token and create user
  async function setupUser(cognitoSub: string = TEST_COGNITO_SUB): Promise<{ token: string; userId: string }> {
    process.env.DEV_USER_SUB = cognitoSub;
    const mockToken = jwt.sign(
      { sub: 'ignored', email: 'test@example.com' },
      'any-secret',
    );

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ identity_token: mockToken })
      .expect(200);

    return {
      token: loginRes.body.access_token,
      userId: loginRes.body.user_id,
    };
  }

  // Helper: Complete onboarding
  async function completeOnboarding(token: string): Promise<string> {
    const onboardingDto: OnboardingRequestDto = {
      preferred_name: 'TestUser',
      age_band: AgeBand.AGE_18_24,
      country_or_region: 'US',
      occupation_category: OccupationCategory.STUDENT,
      client_timezone: 'America/New_York',
      proactive_messages_enabled: true,
      suppressed_topics: [],
    };

    const res = await request(app.getHttpServer())
      .post('/user/onboarding')
      .set('Authorization', `Bearer ${token}`)
      .send(onboardingDto)
      .expect(200);

    return res.body.conversation_id;
  }

  // Helper: Assign persona to AI friend (required for ONBOARDING → ACTIVE)
  // Also creates the Relationship record needed for the chat service
  async function assignPersona(userId: string): Promise<void> {
    // First ensure persona_templates has at least one entry (PT01)
    await prisma.personaTemplate.upsert({
      where: { id: 'PT01' },
      create: {
        id: 'PT01',
        coreArchetype: 'Calm_Listener',
        speechStyle: { sentence_length_bias: 'medium', emoji_usage: 'none', punctuation_quirks: [] },
        lexiconBias: { language_cleanliness: 'clean', hint_tokens: [] },
        humorMode: 'none',
        emotionalExpressionLevel: 'restrained',
        tabooSoftBounds: [],
        friendEnergy: 'balanced',
      },
      update: {},
    });

    // Get the AI friend
    const aiFriend = await prisma.aiFriend.findUnique({ where: { userId } });
    if (!aiFriend) {
      throw new Error('AI Friend not found for user');
    }

    // Update AI friend with persona
    await prisma.aiFriend.update({
      where: { userId },
      data: {
        personaTemplateId: 'PT01',
        personaSeed: 12345,
        stableStyleParams: {
          msg_length_pref: 'medium',
          emoji_freq: 'none',
          humor_mode: 'none',
          directness_level: 'balanced',
          followup_question_rate: 'low',
          lexicon_bias: 'clean',
          punctuation_quirks: [],
        },
        assignedAt: new Date(),
      },
    });

    // Create Relationship record (required for ONBOARDING → ACTIVE update)
    await prisma.relationship.upsert({
      where: {
        userId_aiFriendId: {
          userId,
          aiFriendId: aiFriend.id,
        },
      },
      create: {
        userId,
        aiFriendId: aiFriend.id,
        relationshipStage: 'STRANGER',
        rapportScore: 0,
        sessionsCount: 0,
        currentSessionShortReplyCount: 0,
      },
      update: {},
    });
  }

  // Helper: Generate random UUID
  function randomUUID(): string {
    return crypto.randomUUID();
  }

  /**
   * TEST A: E2E/Service test
   * First call creates user msg row + assistant msg row; returns ChatResponseDto shape.
   */
  describe('A) First call creates user + assistant message rows', () => {
    it('should create user message row and assistant message row with ChatResponseDto shape', async () => {
      const { token, userId } = await setupUser('chat-test-a-sub');
      const conversationId = await completeOnboarding(token);
      await assignPersona(userId);

      const messageId = randomUUID();
      const chatDto: ChatRequestDto = {
        message_id: messageId,
        conversation_id: conversationId,
        user_message: 'Hello, this is my first message!',
        local_timestamp: new Date().toISOString(),
        user_timezone: 'America/New_York',
      };

      const response = await request(app.getHttpServer())
        .post('/chat/send')
        .set('Authorization', `Bearer ${token}`)
        .send(chatDto)
        .expect(200);

      // Verify ChatResponseDto shape per API_CONTRACT.md
      const chatResponse: ChatResponseDto = response.body;
      expect(chatResponse).toHaveProperty('message_id', messageId);
      expect(chatResponse).toHaveProperty('user_state', UserState.ACTIVE); // ONBOARDING → ACTIVE
      expect(chatResponse).toHaveProperty('assistant_message');
      expect(chatResponse.assistant_message).toHaveProperty('id');
      expect(chatResponse.assistant_message).toHaveProperty('content');
      expect(chatResponse.assistant_message).toHaveProperty('created_at');
      expect(typeof chatResponse.assistant_message.id).toBe('string');
      expect(typeof chatResponse.assistant_message.content).toBe('string');
      expect(chatResponse.assistant_message.content.length).toBeGreaterThan(0);

      // Verify two message rows exist in DB (user + assistant)
      const messages = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
      });

      expect(messages.length).toBe(2);

      // First message: user
      expect(messages[0].id).toBe(messageId);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Hello, this is my first message!');
      expect(messages[0].status).toBe('COMPLETED');

      // Second message: assistant (SPEC_PATCH: NEW row, not update)
      expect(messages[1].id).toBe(chatResponse.assistant_message.id);
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].content).toBe(chatResponse.assistant_message.content);
      expect(messages[1].status).toBe('COMPLETED');

      // Both should have same trace_id (SPEC_PATCH requirement)
      expect(messages[0].traceId).toBe(messages[1].traceId);
    });
  });

  /**
   * TEST B: Replay test
   * Second call with same message_id returns identical assistant_message
   * and does NOT create new rows.
   */
  describe('B) Idempotency replay returns same assistant_message', () => {
    it('should return identical assistant_message on replay without creating new rows', async () => {
      const { token, userId } = await setupUser('chat-test-b-sub');
      const conversationId = await completeOnboarding(token);
      await assignPersona(userId);

      const messageId = randomUUID();
      const chatDto: ChatRequestDto = {
        message_id: messageId,
        conversation_id: conversationId,
        user_message: 'Hello for replay test!',
        local_timestamp: new Date().toISOString(),
        user_timezone: 'America/New_York',
      };

      // First call
      const firstResponse = await request(app.getHttpServer())
        .post('/chat/send')
        .set('Authorization', `Bearer ${token}`)
        .send(chatDto)
        .expect(200);

      const firstChatResponse: ChatResponseDto = firstResponse.body;

      // Second call (replay)
      const secondResponse = await request(app.getHttpServer())
        .post('/chat/send')
        .set('Authorization', `Bearer ${token}`)
        .send(chatDto)
        .expect(200);

      const secondChatResponse: ChatResponseDto = secondResponse.body;

      // Verify identical assistant_message
      expect(secondChatResponse.message_id).toBe(firstChatResponse.message_id);
      expect(secondChatResponse.assistant_message.id).toBe(firstChatResponse.assistant_message.id);
      expect(secondChatResponse.assistant_message.content).toBe(firstChatResponse.assistant_message.content);
      expect(secondChatResponse.assistant_message.created_at).toBe(firstChatResponse.assistant_message.created_at);

      // Verify no new rows created
      const messages = await prisma.message.findMany({
        where: { conversationId },
      });
      expect(messages.length).toBe(2); // Only user + assistant from first call
    });
  });

  /**
   * TEST C: Concurrency test
   * Two concurrent POST /chat/send with same message_id results in
   * exactly one user msg row and one assistant row, both responses identical.
   */
  describe('C) Concurrency: duplicate-submit safety', () => {
    it('should handle concurrent requests safely with exactly one user + one assistant row', async () => {
      const { token, userId } = await setupUser('chat-test-c-sub');
      const conversationId = await completeOnboarding(token);
      await assignPersona(userId);

      const messageId = randomUUID();
      const chatDto: ChatRequestDto = {
        message_id: messageId,
        conversation_id: conversationId,
        user_message: 'Concurrent test message',
        local_timestamp: new Date().toISOString(),
        user_timezone: 'America/New_York',
      };

      // Send two concurrent requests
      const [response1, response2] = await Promise.all([
        request(app.getHttpServer())
          .post('/chat/send')
          .set('Authorization', `Bearer ${token}`)
          .send(chatDto),
        request(app.getHttpServer())
          .post('/chat/send')
          .set('Authorization', `Bearer ${token}`)
          .send(chatDto),
      ]);

      // Both should succeed (200) or one should get 409 (in-progress)
      const successResponses = [response1, response2].filter(r => r.status === 200);
      const inProgressResponses = [response1, response2].filter(r => r.status === 409);

      // At least one should succeed
      expect(successResponses.length).toBeGreaterThanOrEqual(1);

      // If both succeeded, they should have identical assistant_message
      if (successResponses.length === 2) {
        expect(successResponses[0].body.assistant_message.id)
          .toBe(successResponses[1].body.assistant_message.id);
        expect(successResponses[0].body.assistant_message.content)
          .toBe(successResponses[1].body.assistant_message.content);
      }

      // Verify exactly one user + one assistant row
      const messages = await prisma.message.findMany({
        where: { conversationId },
      });
      expect(messages.length).toBe(2);

      const userMessages = messages.filter(m => m.role === 'user');
      const assistantMessages = messages.filter(m => m.role === 'assistant');
      expect(userMessages.length).toBe(1);
      expect(assistantMessages.length).toBe(1);
    });
  });

  /**
   * TEST D: ONBOARDING → ACTIVE atomic test
   * ONBOARDING user with required onboarding data flips to ACTIVE
   * only inside /chat/send transaction.
   */
  describe('D) ONBOARDING → ACTIVE atomic transition', () => {
    it('should atomically transition from ONBOARDING to ACTIVE on first message', async () => {
      const { token, userId } = await setupUser('chat-test-d-sub');
      const conversationId = await completeOnboarding(token);
      await assignPersona(userId);

      // Verify user is ONBOARDING before chat
      const userBefore = await prisma.user.findUnique({ where: { id: userId } });
      expect(userBefore?.state).toBe(UserState.ONBOARDING);

      const messageId = randomUUID();
      const chatDto: ChatRequestDto = {
        message_id: messageId,
        conversation_id: conversationId,
        user_message: 'My first message to become ACTIVE',
        local_timestamp: new Date().toISOString(),
        user_timezone: 'America/New_York',
      };

      const response = await request(app.getHttpServer())
        .post('/chat/send')
        .set('Authorization', `Bearer ${token}`)
        .send(chatDto)
        .expect(200);

      // Verify response shows ACTIVE
      expect(response.body.user_state).toBe(UserState.ACTIVE);

      // Verify user is ACTIVE in DB
      const userAfter = await prisma.user.findUnique({ where: { id: userId } });
      expect(userAfter?.state).toBe(UserState.ACTIVE);

      // Verify message was persisted (transition was atomic with message write)
      const messages = await prisma.message.findMany({
        where: { conversationId },
      });
      expect(messages.length).toBe(2);
    });

    it('should NOT transition to ACTIVE if already ACTIVE (second message)', async () => {
      const { token, userId } = await setupUser('chat-test-d2-sub');
      const conversationId = await completeOnboarding(token);
      await assignPersona(userId);

      // First message: ONBOARDING → ACTIVE
      const firstDto: ChatRequestDto = {
        message_id: randomUUID(),
        conversation_id: conversationId,
        user_message: 'First message',
        local_timestamp: new Date().toISOString(),
        user_timezone: 'America/New_York',
      };

      await request(app.getHttpServer())
        .post('/chat/send')
        .set('Authorization', `Bearer ${token}`)
        .send(firstDto)
        .expect(200);

      // Second message: should remain ACTIVE
      const secondDto: ChatRequestDto = {
        message_id: randomUUID(),
        conversation_id: conversationId,
        user_message: 'Second message',
        local_timestamp: new Date().toISOString(),
        user_timezone: 'America/New_York',
      };

      const response = await request(app.getHttpServer())
        .post('/chat/send')
        .set('Authorization', `Bearer ${token}`)
        .send(secondDto)
        .expect(200);

      expect(response.body.user_state).toBe(UserState.ACTIVE);

      // Verify 4 messages (2 from first call, 2 from second call)
      const messages = await prisma.message.findMany({
        where: { conversationId },
      });
      expect(messages.length).toBe(4);
    });
  });

  /**
   * TEST E: ONBOARDING failure rollback
   * Missing required onboarding causes rollback (no orphan rows, no state change).
   * 
   * Per AI_PIPELINE.md §3.1: Persona is now assigned during onboarding.
   * To test rollback, we must directly modify the DB to simulate missing persona.
   */
  describe('E) ONBOARDING failure rollback', () => {
    it('should rollback if stableStyleParams is not assigned (no orphan messages)', async () => {
      const { token, userId } = await setupUser('chat-test-e-sub');
      const conversationId = await completeOnboarding(token);
      
      // Per AI_PIPELINE.md §3.1: Persona is now assigned during completeOnboarding.
      // To test the rollback case, we must directly unset stableStyleParams in DB.
      const aiFriend = await prisma.aiFriend.findFirst({
        where: { userId },
      });
      expect(aiFriend).not.toBeNull();
      
      // Simulate missing persona by unsetting stableStyleParams
      await prisma.aiFriend.update({
        where: { id: aiFriend!.id },
        data: { stableStyleParams: null },
      });

      // Verify user is ONBOARDING
      const userBefore = await prisma.user.findUnique({ where: { id: userId } });
      expect(userBefore?.state).toBe(UserState.ONBOARDING);

      const messageId = randomUUID();
      const chatDto: ChatRequestDto = {
        message_id: messageId,
        conversation_id: conversationId,
        user_message: 'This should fail because stableStyleParams is missing',
        local_timestamp: new Date().toISOString(),
        user_timezone: 'America/New_York',
      };

      // Should return error (403) indicating missing persona
      const response = await request(app.getHttpServer())
        .post('/chat/send')
        .set('Authorization', `Bearer ${token}`)
        .send(chatDto);

      // Expect failure (403 Forbidden for missing persona)
      expect(response.status).toBe(403);

      // Verify NO orphan message rows created
      const messages = await prisma.message.findMany({
        where: { conversationId },
      });
      expect(messages.length).toBe(0);

      // Verify user state did NOT change
      const userAfter = await prisma.user.findUnique({ where: { id: userId } });
      expect(userAfter?.state).toBe(UserState.ONBOARDING);
    });

    it('should rollback if onboarding answers are missing (CREATED state)', async () => {
      const { token, userId } = await setupUser('chat-test-e2-sub');
      // Note: NOT completing onboarding

      // User is CREATED (no onboarding, no conversation)
      const user = await prisma.user.findUnique({ where: { id: userId } });
      expect(user?.state).toBe(UserState.CREATED);

      const chatDto: ChatRequestDto = {
        message_id: randomUUID(),
        conversation_id: randomUUID(), // Invalid conversation
        user_message: 'This should fail',
        local_timestamp: new Date().toISOString(),
        user_timezone: 'America/New_York',
      };

      // Per AI_PIPELINE.md §6.1.1: CREATED state should route to REFUSAL
      const response = await request(app.getHttpServer())
        .post('/chat/send')
        .set('Authorization', `Bearer ${token}`)
        .send(chatDto);

      expect([400, 403]).toContain(response.status);

      // Verify user state unchanged
      const userAfter = await prisma.user.findUnique({ where: { id: userId } });
      expect(userAfter?.state).toBe(UserState.CREATED);
    });
  });

  /**
   * Additional: In-progress response (HTTP 409) for RECEIVED/PROCESSING status
   */
  describe('In-progress handling (HTTP 409)', () => {
    it('should return 409 with deterministic in-progress response when message is RECEIVED/PROCESSING', async () => {
      const { token, userId } = await setupUser('chat-test-inprogress-sub');
      const conversationId = await completeOnboarding(token);
      await assignPersona(userId);

      const messageId = randomUUID();

      // Manually insert a RECEIVED message to simulate in-progress state
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { aiFriend: true },
      });

      await prisma.message.create({
        data: {
          id: messageId,
          conversationId,
          userId,
          aiFriendId: conversation!.aiFriendId,
          role: 'user',
          content: 'In progress message',
          status: 'PROCESSING',
          source: 'chat',
          traceId: randomUUID(),
        },
      });

      const chatDto: ChatRequestDto = {
        message_id: messageId,
        conversation_id: conversationId,
        user_message: 'In progress message',
        local_timestamp: new Date().toISOString(),
        user_timezone: 'America/New_York',
      };

      const response = await request(app.getHttpServer())
        .post('/chat/send')
        .set('Authorization', `Bearer ${token}`)
        .send(chatDto)
        .expect(409);

      // Per SPEC_PATCH.md: Return ChatResponseDto with deterministic in-progress message
      expect(response.body).toHaveProperty('message_id', messageId);
      expect(response.body).toHaveProperty('assistant_message');
      // Per SPEC_PATCH.md: deterministic "request in progress, retry" message
      expect(response.body.assistant_message.content).toMatch(/being processed|in progress|retry/i);
    });
  });

  /**
   * surfaced_memory_ids field test
   */
  describe('surfaced_memory_ids field', () => {
    it('should store and return surfaced_memory_ids (empty array for now)', async () => {
      const { token, userId } = await setupUser('chat-test-memory-sub');
      const conversationId = await completeOnboarding(token);
      await assignPersona(userId);

      const messageId = randomUUID();
      const chatDto: ChatRequestDto = {
        message_id: messageId,
        conversation_id: conversationId,
        user_message: 'Test surfaced memory ids',
        local_timestamp: new Date().toISOString(),
        user_timezone: 'America/New_York',
      };

      await request(app.getHttpServer())
        .post('/chat/send')
        .set('Authorization', `Bearer ${token}`)
        .send(chatDto)
        .expect(200);

      // Verify assistant message has surfaced_memory_ids field (can be empty)
      const assistantMsg = await prisma.message.findFirst({
        where: {
          conversationId,
          role: 'assistant',
        },
      });

      expect(assistantMsg).toBeTruthy();
      expect(assistantMsg?.surfacedMemoryIds).toEqual([]);
    });
  });
});
