import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthRequestDto, AuthResponseDto, ApiErrorDto } from '@chingoo/shared';
import { Public } from '../common/decorators/public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * POST /auth/login
   * Per API_CONTRACT.md §5: Authenticates the user and returns the token required for all other calls.
   * Per SPEC_PATCH.md: /auth/signup is NOT implemented as a separate endpoint.
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() authRequest: AuthRequestDto): Promise<AuthResponseDto> {
    try {
      return await this.authService.login(authRequest);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        const errorResponse: ApiErrorDto = {
          statusCode: HttpStatus.UNAUTHORIZED,
          message: error.message || 'Invalid or missing Auth Token',
          error: 'Unauthorized',
        };
        throw new UnauthorizedException(errorResponse);
      }
      throw error;
    }
  }
}
