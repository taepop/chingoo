import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRequestDto, AuthResponseDto, UserState } from '@chingoo/shared';

describe('AuthController', () => {
  let controller: AuthController;
  let service: AuthService;

  const mockAuthService = {
    login: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: mockAuthService,
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /auth/login', () => {
    it('should return AuthResponseDto on successful login', async () => {
      const authRequest: AuthRequestDto = {
        identity_token: 'test-token',
      };

      const expectedResponse: AuthResponseDto = {
        access_token: 'jwt-token',
        user_id: 'user-id',
        state: UserState.CREATED,
      };

      mockAuthService.login.mockResolvedValue(expectedResponse);

      const result = await controller.login(authRequest);

      expect(result).toEqual(expectedResponse);
      expect(service.login).toHaveBeenCalledWith(authRequest);
    });

    it('should throw UnauthorizedException with ApiErrorDto format on invalid token', async () => {
      const authRequest: AuthRequestDto = {
        identity_token: 'invalid-token',
      };

      mockAuthService.login.mockRejectedValue(
        new UnauthorizedException('Invalid token'),
      );

      await expect(controller.login(authRequest)).rejects.toThrow(
        UnauthorizedException,
      );

      try {
        await controller.login(authRequest);
        fail('Should have thrown UnauthorizedException');
      } catch (error) {
        expect(error).toBeInstanceOf(UnauthorizedException);
        if (error instanceof UnauthorizedException) {
          const response = error.getResponse();
          expect(response).toHaveProperty('statusCode');
          expect(response).toHaveProperty('message');
          expect(response).toHaveProperty('error');
        }
      }
    });
  });
});
