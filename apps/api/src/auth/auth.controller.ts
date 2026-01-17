import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  AuthRequestDto,
  AuthResponseDto,
  SignupRequestDto,
  ApiErrorDto,
} from '@chingoo/shared';
import { Public } from '../common/decorators/public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * POST /auth/signup
   * Creates a new user account with email and password.
   * 
   * Request: SignupRequestDto { email, password, confirm_password }
   * Response: AuthResponseDto { access_token, user_id, email, state }
   * 
   * Errors:
   * - 400: Invalid email format, password too weak, passwords don't match
   * - 409: Email already exists
   */
  @Public()
  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  async signup(@Body() signupRequest: SignupRequestDto): Promise<AuthResponseDto> {
    return this.authService.signup(signupRequest);
  }

  /**
   * POST /auth/login
   * Authenticates user with email/password or Cognito token.
   * 
   * Request: AuthRequestDto { email?, password?, identity_token? }
   * Response: AuthResponseDto { access_token, user_id, email?, state }
   * 
   * Modes:
   * - Email/Password: Provide email + password
   * - Cognito Token: Provide identity_token (legacy/alternative)
   * 
   * Errors:
   * - 400: Missing required fields
   * - 401: Invalid credentials
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() authRequest: AuthRequestDto): Promise<AuthResponseDto> {
    return this.authService.login(authRequest);
  }
}
