import { Controller, Post, Get, Patch, Delete, Body, Query } from '@nestjs/common';

/**
 * User Controller
 * 
 * Per API_CONTRACT.md and SPEC_PATCH.md:
 * - POST /user/onboarding
 * - GET /user/me
 * - PATCH /user/timezone
 * - POST /user/device (SPEC_PATCH.md)
 * - DELETE /user/me (SPEC_PATCH.md)
 * 
 * TODO: Implement all endpoints
 */
@Controller('user')
export class UserController {
  @Post('onboarding')
  async onboarding(@Body() body: any) {
    // TODO: Implement OnboardingRequestDto validation and OnboardingResponseDto response
    return { message: 'Onboarding endpoint - not yet implemented' };
  }

  @Get('me')
  async getMe(@Query() query: any) {
    // TODO: Implement UserProfileResponseDto response
    return { message: 'Get user endpoint - not yet implemented' };
  }

  @Patch('timezone')
  async updateTimezone(@Body() body: any) {
    // TODO: Implement UpdateTimezoneDto validation and SuccessResponseDto response
    return { message: 'Update timezone endpoint - not yet implemented' };
  }

  @Post('device')
  async registerDevice(@Body() body: any) {
    // TODO: Implement RegisterDeviceDto validation (SPEC_PATCH.md)
    // Request DTO: RegisterDeviceDto { push_token: string; platform: 'ios' | 'android'; }
    return { message: 'Register device endpoint - not yet implemented' };
  }

  @Delete('me')
  async deleteMe() {
    // TODO: Implement hard delete of user and all data (SPEC_PATCH.md)
    // Returns 200 OK on success
    return { message: 'Delete user endpoint - not yet implemented' };
  }
}
