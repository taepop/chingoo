import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { UserProfileResponseDto, UserState } from '@chingoo/shared';

describe('UserController', () => {
  let controller: UserController;
  let service: UserService;

  const mockUserService = {
    getProfile: jest.fn(),
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
});
