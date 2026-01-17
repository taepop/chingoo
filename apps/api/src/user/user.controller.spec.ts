import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import {
  UserProfileResponseDto,
  UserState,
  OnboardingRequestDto,
  OnboardingResponseDto,
  AgeBand,
  OccupationCategory,
} from '@chingoo/shared';

/**
 * UserController Unit Tests
 * 
 * Tests core API contract compliance for:
 * - GET /user/me per API_CONTRACT.md
 * - POST /user/onboarding per API_CONTRACT.md + AI_PIPELINE.md §3.1 (persona assignment)
 */
describe('UserController', () => {
  let controller: UserController;
  let service: UserService;

  const mockUserService = {
    getProfile: jest.fn(),
    completeOnboarding: jest.fn(),
    registerDevice: jest.fn(),
    deleteUser: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserController],
      providers: [
        {
          provide: UserService,
          useValue: mockUserService,
        },
      ],
    }).compile();

    controller = module.get<UserController>(UserController);
    service = module.get<UserService>(UserService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /user/me', () => {
    it('should return UserProfileResponseDto for authenticated user', async () => {
      const mockRequest = {
        user: {
          userId: 'user-id',
          cognitoSub: 'cognito-sub',
          state: UserState.ACTIVE,
        },
      };

      const expectedResponse: UserProfileResponseDto = {
        user_id: 'user-id',
        preferred_name: 'Test User',
        state: UserState.ACTIVE,
        conversation_id: 'conversation-id',
      };

      mockUserService.getProfile.mockResolvedValue(expectedResponse);

      const result = await controller.getMe(mockRequest);

      expect(result).toEqual(expectedResponse);
      expect(service.getProfile).toHaveBeenCalledWith('user-id');
    });
  });

  /**
   * POST /user/onboarding tests
   * 
   * Per AI_PIPELINE.md §3.1:
   * "During ONBOARDING, after required questions are answered, before first message is sent."
   * 
   * This verifies the controller correctly routes to the service which must:
   * - Assign persona (personaTemplateId, personaSeed, stableStyleParams)
   * - Create Relationship record
   * - Transition user state from CREATED to ONBOARDING
   */
  describe('POST /user/onboarding', () => {
    const mockRequest = {
      user: {
        userId: 'user-id',
        cognitoSub: 'cognito-sub',
        state: UserState.CREATED,
      },
    };

    const validOnboardingDto: OnboardingRequestDto = {
      preferred_name: 'Test User',
      age_band: AgeBand.AGE_18_24,
      country_or_region: 'US',
      occupation_category: OccupationCategory.STUDENT,
      client_timezone: 'America/New_York',
      proactive_messages_enabled: true,
      suppressed_topics: [],
    };

    it('should return OnboardingResponseDto with conversation_id on successful onboarding', async () => {
      const expectedResponse: OnboardingResponseDto = {
        user_id: 'user-id',
        state: UserState.ONBOARDING,
        conversation_id: 'conversation-id-123',
        updated_at: new Date().toISOString(),
      };

      mockUserService.completeOnboarding.mockResolvedValue(expectedResponse);

      const result = await controller.completeOnboarding(mockRequest, validOnboardingDto);

      expect(result).toEqual(expectedResponse);
      expect(service.completeOnboarding).toHaveBeenCalledWith('user-id', validOnboardingDto);
      expect(result.state).toBe(UserState.ONBOARDING);
      expect(result.conversation_id).toBeDefined();
    });

    it('should pass the full OnboardingRequestDto to service', async () => {
      const expectedResponse: OnboardingResponseDto = {
        user_id: 'user-id',
        state: UserState.ONBOARDING,
        conversation_id: 'conversation-id-123',
        updated_at: new Date().toISOString(),
      };

      mockUserService.completeOnboarding.mockResolvedValue(expectedResponse);

      await controller.completeOnboarding(mockRequest, validOnboardingDto);

      // Verify all DTO fields are passed through
      expect(service.completeOnboarding).toHaveBeenCalledWith(
        'user-id',
        expect.objectContaining({
          preferred_name: 'Test User',
          age_band: AgeBand.AGE_18_24,
          country_or_region: 'US',
          occupation_category: OccupationCategory.STUDENT,
          client_timezone: 'America/New_York',
          proactive_messages_enabled: true,
          suppressed_topics: [],
        }),
      );
    });
  });
});
