import {
  Controller,
  Get,
  Post,
  Delete,
  UseGuards,
  Request,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { UserService } from './user.service';
import {
  UserProfileResponseDto,
  OnboardingRequestDto,
  OnboardingResponseDto,
  RegisterDeviceDto,
  SuccessResponseDto,
} from '@chingoo/shared';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('user')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  /**
   * GET /user/me
   * Per API_CONTRACT.md: Called on App Launch to check if the user is ONBOARDING or ACTIVE.
   * Returns the exact persisted user.state from the database.
   */
  @Get('me')
  async getMe(@Request() req: any): Promise<UserProfileResponseDto> {
    // req.user is set by JwtAuthGuard after JWT validation
    const userId = req.user.userId;
    return this.userService.getProfile(userId);
  }

  /**
   * POST /user/onboarding
   * Per API_CONTRACT.md §2: Complete user onboarding
   * Per SPEC_PATCH.md: Idempotent per user, CREATED → ONBOARDING only
   */
  @Post('onboarding')
  @HttpCode(HttpStatus.OK)
  async completeOnboarding(
    @Request() req: any,
    @Body() dto: OnboardingRequestDto,
  ): Promise<OnboardingResponseDto> {
    const userId = req.user.userId;
    return this.userService.completeOnboarding(userId, dto);
  }

  /**
   * POST /user/device
   * Per SPEC_PATCH.md: Register push notification device
   */
  @Post('device')
  @HttpCode(HttpStatus.OK)
  async registerDevice(
    @Request() req: any,
    @Body() dto: RegisterDeviceDto,
  ): Promise<SuccessResponseDto> {
    const userId = req.user.userId;
    return this.userService.registerDevice(userId, dto);
  }

  /**
   * DELETE /user/me
   * Per SPEC_PATCH.md: Hard delete of user and all data
   * Returns HTTP 200 OK on success
   */
  @Delete('me')
  @HttpCode(HttpStatus.OK)
  async deleteMe(@Request() req: any): Promise<void> {
    const userId = req.user.userId;
    await this.userService.deleteUser(userId);
  }
}
