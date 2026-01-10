import { Controller, Post, Body } from '@nestjs/common';

/**
 * Auth Controller
 * Endpoint: POST /auth/login (or Signup)
 * 
 * Per API_CONTRACT.md §5: POST /auth/login (or Signup)
 * Per SPEC_PATCH.md: /auth/signup is NOT implemented as a separate endpoint in v0.1.
 * 
 * TODO: Implement authentication logic
 */
@Controller('auth')
export class AuthController {
  @Post('login')
  async login(@Body() body: any) {
    // TODO: Implement AuthRequestDto validation and AuthResponseDto response
    // Request DTO: AuthRequestDto { identity_token: string; email?: string; }
    // Response DTO: AuthResponseDto { access_token: string; user_id: string; state: UserState; }
    return { message: 'Auth endpoint - not yet implemented' };
  }
}
