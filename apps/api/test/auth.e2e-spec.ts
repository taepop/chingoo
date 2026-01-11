import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { UserState, ApiErrorDto, AuthResponseDto } from '@chingoo/shared';
import * as jwt from 'jsonwebtoken';

describe('Auth E2E', () => {
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
    process.env.DEV_USER_SUB = 'test-cognito-sub';
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
    // Clean up only test users (users with cognitoSub matching test patterns)
    await prisma.user.deleteMany({
      where: {
        cognitoSub: {
          in: ['test-cognito-sub', 'test-duplicate-sub'],
        },
      },
    });
  });

  describe('GET /user/me', () => {
    it('should return 401 without Authorization header and response body matches ApiErrorDto shape (no constraints for 401)', async () => {
      const response = await request(app.getHttpServer())
        .get('/user/me')
        .expect(401);

      // Verify ApiErrorDto shape
      const errorBody: ApiErrorDto = response.body;
      expect(errorBody).toHaveProperty('statusCode', 401);
      expect(errorBody).toHaveProperty('message');
      expect(errorBody).toHaveProperty('error', 'Unauthorized');
      expect(typeof errorBody.statusCode).toBe('number');
      expect(typeof errorBody.message).toBe('string');
      expect(typeof errorBody.error).toBe('string');
      
      // For 401 errors, constraints should NOT be present (only for 400 validation errors)
      expect(errorBody).not.toHaveProperty('constraints');
    });
  });

  describe('POST /auth/login', () => {
    it('should return response matching AuthResponseDto shape under DEV_BYPASS_AUTH=true with DEV_USER_SUB set', async () => {
      // Ensure DEV_BYPASS_AUTH is true (set in beforeAll)
      expect(process.env.DEV_BYPASS_AUTH).toBe('true');
      expect(process.env.DEV_USER_SUB).toBe('test-cognito-sub');

      const mockToken = jwt.sign(
        { sub: 'ignored-in-dev-bypass', email: 'test@example.com' },
        'any-secret-for-dev-bypass',
      );

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          identity_token: mockToken,
        })
        .expect(200);

      // Verify AuthResponseDto shape
      const authResponse: AuthResponseDto = loginResponse.body;
      expect(authResponse).toHaveProperty('access_token');
      expect(authResponse).toHaveProperty('user_id');
      expect(authResponse).toHaveProperty('state');
      
      expect(typeof authResponse.access_token).toBe('string');
      expect(typeof authResponse.user_id).toBe('string');
      expect(Object.values(UserState)).toContain(authResponse.state);
      
      // Verify access_token is not empty
      expect(authResponse.access_token.length).toBeGreaterThan(0);
      // Verify user_id is not empty
      expect(authResponse.user_id.length).toBeGreaterThan(0);
    });

    it('should not create duplicate user rows when called twice with the same DEV_USER_SUB and return the same user_id', async () => {
      // Use a specific test cognitoSub for this test
      const testCognitoSub = 'test-duplicate-sub';
      process.env.DEV_USER_SUB = testCognitoSub;

      const mockToken = jwt.sign(
        { sub: 'ignored-in-dev-bypass', email: 'duplicate@example.com' },
        'any-secret-for-dev-bypass',
      );

      // First login call
      const firstLoginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          identity_token: mockToken,
        })
        .expect(200);

      const firstUserId = firstLoginResponse.body.user_id;
      expect(firstUserId).toBeTruthy();

      // Verify user was created
      const userCountAfterFirst = await prisma.user.count({
        where: { cognitoSub: testCognitoSub },
      });
      expect(userCountAfterFirst).toBe(1);

      // Second login call with the same DEV_USER_SUB
      const secondLoginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          identity_token: mockToken,
        })
        .expect(200);

      const secondUserId = secondLoginResponse.body.user_id;
      
      // Verify same user_id is returned
      expect(secondUserId).toBe(firstUserId);

      // Verify DB count for that cognitoSub remains 1 (no duplicate created)
      const userCountAfterSecond = await prisma.user.count({
        where: { cognitoSub: testCognitoSub },
      });
      expect(userCountAfterSecond).toBe(1);

      // Restore original DEV_USER_SUB
      process.env.DEV_USER_SUB = 'test-cognito-sub';
    });
  });
});
