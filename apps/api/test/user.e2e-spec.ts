import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  UserState,
  ApiErrorDto,
  OnboardingRequestDto,
  OnboardingResponseDto,
  RegisterDeviceDto,
  SuccessResponseDto,
  AgeBand,
  OccupationCategory,
  TopicId,
} from '@chingoo/shared';
import * as jwt from 'jsonwebtoken';

describe('User E2E', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const devBypassOriginal = process.env.DEV_BYPASS_AUTH;
  const devUserSubOriginal = process.env.DEV_USER_SUB;
  const jwtSecretOriginal = process.env.JWT_SECRET;

  beforeAll(async () => {
    // Set JWT_SECRET first (required for JwtModule initialization)
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';
    // Enable dev bypass for tests
    process.env.DEV_BYPASS_AUTH = 'true';
    process.env.DEV_USER_SUB = 'test-user-sub';
    // Set DATABASE_URL for Prisma (matches docker-compose.yml postgres service)
    if (!process.env.DATABASE_URL) {
      process.env.DATABASE_URL = 'postgresql://chingoo:chingoo@localhost:5432/chingoo';
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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
    // Restore original env vars
    if (devBypassOriginal) {
      process.env.DEV_BYPASS_AUTH = devBypassOriginal;
    } else {
      delete process.env.DEV_BYPASS_AUTH;
    }
    if (devUserSubOriginal) {
      process.env.DEV_USER_SUB = devUserSubOriginal;
    } else {
      delete process.env.DEV_USER_SUB;
    }
    if (jwtSecretOriginal) {
      process.env.JWT_SECRET = jwtSecretOriginal;
    } else {
      delete process.env.JWT_SECRET;
    }
  });

  beforeEach(async () => {
    // Clean up test users
    await prisma.user.deleteMany({
      where: {
        cognitoSub: {
          in: ['test-user-sub', 'test-onboarding-sub', 'test-delete-sub'],
        },
      },
    });
  });

  // Helper to get auth token
  async function getAuthToken(cognitoSub: string = 'test-user-sub'): Promise<string> {
    process.env.DEV_USER_SUB = cognitoSub;
    const mockToken = jwt.sign(
      { sub: 'ignored-in-dev-bypass', email: 'test@example.com' },
      'any-secret-for-dev-bypass',
    );

    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ identity_token: mockToken })
      .expect(200);

    return loginResponse.body.access_token;
  }

  describe('GET /user/me', () => {
    it('should return user profile with exact persisted state', async () => {
      const token = await getAuthToken();
      const user = await prisma.user.findFirst({
        where: { cognitoSub: 'test-user-sub' },
      });

      const response = await request(app.getHttpServer())
        .get('/user/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body).toHaveProperty('user_id', user?.id);
      expect(response.body).toHaveProperty('state');
      expect(Object.values(UserState)).toContain(response.body.state);
      // Verify state matches DB
      expect(response.body.state).toBe(user?.state);
    });
  });

  describe('POST /user/onboarding', () => {
    const validOnboardingDto: OnboardingRequestDto = {
      preferred_name: 'Test User',
      age_band: AgeBand.AGE_18_24,
      country_or_region: 'US',
      occupation_category: OccupationCategory.STUDENT,
      client_timezone: 'America/New_York',
      proactive_messages_enabled: true,
      suppressed_topics: [TopicId.POLITICS, TopicId.RELIGION],
    };

    it('should return 400 ApiErrorDto with constraints on missing required field', async () => {
      const token = await getAuthToken('test-onboarding-sub');
      const invalidDto = { ...validOnboardingDto };
      delete (invalidDto as any).preferred_name;

      const response = await request(app.getHttpServer())
        .post('/user/onboarding')
        .set('Authorization', `Bearer ${token}`)
        .send(invalidDto)
        .expect(400);

      const errorBody: ApiErrorDto = response.body;
      expect(errorBody).toHaveProperty('statusCode', 400);
      expect(errorBody).toHaveProperty('message');
      expect(errorBody).toHaveProperty('error', 'Bad Request');
      expect(errorBody).toHaveProperty('constraints');
      expect(Array.isArray(errorBody.constraints)).toBe(true);
      expect(errorBody.constraints?.length).toBeGreaterThan(0);
    });

    it('should return OnboardingResponseDto on valid payload', async () => {
      const token = await getAuthToken('test-onboarding-sub');

      const response = await request(app.getHttpServer())
        .post('/user/onboarding')
        .set('Authorization', `Bearer ${token}`)
        .send(validOnboardingDto)
        .expect(200);

      const onboardingResponse: OnboardingResponseDto = response.body;
      expect(onboardingResponse).toHaveProperty('user_id');
      expect(onboardingResponse).toHaveProperty('state', UserState.ONBOARDING);
      expect(onboardingResponse).toHaveProperty('conversation_id');
      expect(onboardingResponse).toHaveProperty('updated_at');
      expect(typeof onboardingResponse.user_id).toBe('string');
      expect(typeof onboardingResponse.conversation_id).toBe('string');
      expect(onboardingResponse.user_id.length).toBeGreaterThan(0);
      expect(onboardingResponse.conversation_id.length).toBeGreaterThan(0);

      // Verify user state in DB is ONBOARDING (not ACTIVE)
      const user = await prisma.user.findFirst({
        where: { cognitoSub: 'test-onboarding-sub' },
      });
      expect(user?.state).toBe(UserState.ONBOARDING);
    });

    it('should be idempotent: second call while ONBOARDING returns same conversation_id or 400', async () => {
      const token = await getAuthToken('test-onboarding-sub');

      // First call
      const firstResponse = await request(app.getHttpServer())
        .post('/user/onboarding')
        .set('Authorization', `Bearer ${token}`)
        .send(validOnboardingDto)
        .expect(200);

      const firstConversationId = firstResponse.body.conversation_id;

      // Second call (should be idempotent)
      const secondResponse = await request(app.getHttpServer())
        .post('/user/onboarding')
        .set('Authorization', `Bearer ${token}`)
        .send(validOnboardingDto)
        .expect(200); // Should return existing result

      // Should return same conversation_id
      expect(secondResponse.body.conversation_id).toBe(firstConversationId);
      expect(secondResponse.body.state).toBe(UserState.ONBOARDING);

      // Verify no duplicate rows created
      const user = await prisma.user.findFirst({
        where: { cognitoSub: 'test-onboarding-sub' },
        include: {
          onboardingAnswers: true,
          controls: true,
          conversations: true,
        },
      });
      expect(user?.onboardingAnswers).toBeTruthy();
      expect(user?.controls).toBeTruthy();
      expect(user?.conversations.length).toBe(1);
    });

    it('should reject onboarding if user is already ACTIVE', async () => {
      const token = await getAuthToken('test-onboarding-sub');

      // First, complete onboarding
      await request(app.getHttpServer())
        .post('/user/onboarding')
        .set('Authorization', `Bearer ${token}`)
        .send(validOnboardingDto)
        .expect(200);

      // Manually set user to ACTIVE (simulating first /chat/send)
      const user = await prisma.user.findFirst({
        where: { cognitoSub: 'test-onboarding-sub' },
      });
      await prisma.user.update({
        where: { id: user!.id },
        data: { state: UserState.ACTIVE },
      });

      // Try onboarding again - should reject
      const response = await request(app.getHttpServer())
        .post('/user/onboarding')
        .set('Authorization', `Bearer ${token}`)
        .send(validOnboardingDto)
        .expect(400);

      const errorBody: ApiErrorDto = response.body;
      expect(errorBody).toHaveProperty('statusCode', 400);
      expect(errorBody.message).toContain('already active');
    });
  });

  describe('POST /user/device', () => {
    it('should register device and return SuccessResponseDto', async () => {
      const token = await getAuthToken();

      const deviceDto: RegisterDeviceDto = {
        push_token: 'test-push-token-123',
        platform: 'ios',
      };

      const response = await request(app.getHttpServer())
        .post('/user/device')
        .set('Authorization', `Bearer ${token}`)
        .send(deviceDto)
        .expect(200);

      const successResponse: SuccessResponseDto = response.body;
      expect(successResponse).toHaveProperty('success', true);

      // Verify push token was saved
      const user = await prisma.user.findFirst({
        where: { cognitoSub: 'test-user-sub' },
      });
      expect(user?.pushToken).toBe('test-push-token-123');
    });

    it('should return 400 with constraints on invalid platform', async () => {
      const token = await getAuthToken();

      const invalidDto = {
        push_token: 'test-token',
        platform: 'invalid',
      };

      const response = await request(app.getHttpServer())
        .post('/user/device')
        .set('Authorization', `Bearer ${token}`)
        .send(invalidDto)
        .expect(400);

      const errorBody: ApiErrorDto = response.body;
      expect(errorBody).toHaveProperty('statusCode', 400);
      expect(errorBody).toHaveProperty('constraints');
    });
  });

  describe('DELETE /user/me', () => {
    it('should hard delete user and all dependent rows', async () => {
      const token = await getAuthToken('test-delete-sub');

      // First, complete onboarding to create related rows
      const onboardingDto: OnboardingRequestDto = {
        preferred_name: 'Delete Test',
        age_band: AgeBand.AGE_25_34,
        country_or_region: 'KR',
        occupation_category: OccupationCategory.WORKING,
        client_timezone: 'Asia/Seoul',
        proactive_messages_enabled: false,
        suppressed_topics: [],
      };

      await request(app.getHttpServer())
        .post('/user/onboarding')
        .set('Authorization', `Bearer ${token}`)
        .send(onboardingDto)
        .expect(200);

      // Verify user exists with related data
      const userBefore = await prisma.user.findFirst({
        where: { cognitoSub: 'test-delete-sub' },
        include: {
          onboardingAnswers: true,
          controls: true,
          conversations: true,
        },
      });
      expect(userBefore).toBeTruthy();
      expect(userBefore?.onboardingAnswers).toBeTruthy();
      expect(userBefore?.controls).toBeTruthy();

      // Delete user
      await request(app.getHttpServer())
        .delete('/user/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Verify user is deleted
      const userAfter = await prisma.user.findFirst({
        where: { cognitoSub: 'test-delete-sub' },
      });
      expect(userAfter).toBeNull();

      // Verify related rows are deleted (CASCADE)
      const onboardingAfter = await prisma.userOnboardingAnswers.findFirst({
        where: { userId: userBefore!.id },
      });
      expect(onboardingAfter).toBeNull();

      const controlsAfter = await prisma.userControls.findFirst({
        where: { userId: userBefore!.id },
      });
      expect(controlsAfter).toBeNull();
    });

    it('should return 401 on subsequent GET /user/me after deletion', async () => {
      const token = await getAuthToken('test-delete-sub');

      // Delete user
      await request(app.getHttpServer())
        .delete('/user/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Subsequent GET should return 401 (user doesn't exist)
      await request(app.getHttpServer())
        .get('/user/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });
  });
});
