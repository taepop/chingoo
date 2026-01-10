import { Controller, Get, UseGuards, Request } from '@nestjs/common';
import { UserService } from './user.service';
import { UserProfileResponseDto } from '@chingoo/shared';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  /**
   * GET /user/me
   * Per API_CONTRACT.md: Called on App Launch to check if the user is ONBOARDING or ACTIVE.
   */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getMe(@Request() req: any): Promise<UserProfileResponseDto> {
    // req.user is set by JwtAuthGuard after JWT validation
    const userId = req.user.userId;
    return this.userService.getProfile(userId);
  }
}
