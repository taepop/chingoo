import {
  Injectable,
  NotFoundException,
  BadRequestException,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  UserProfileResponseDto,
  UserState,
  OnboardingRequestDto,
  OnboardingResponseDto,
  RegisterDeviceDto,
  SuccessResponseDto,
  ApiErrorDto,
  AgeBand,
  OccupationCategory,
} from '@chingoo/shared';
import { AgeBand as PrismaAgeBand, OccupationCategory as PrismaOccupationCategory } from '@prisma/client';

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

  /**
   * Get user profile
   * Per API_CONTRACT.md: GET /user/me
   * Returns the exact persisted user.state from the database.
   */
  async getProfile(userId: string): Promise<UserProfileResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        onboardingAnswers: true,
        conversations: {
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      user_id: user.id,
      preferred_name: user.onboardingAnswers?.preferredName || '',
      state: user.state as UserState, // Exact persisted state
      conversation_id: user.conversations[0]?.id,
    };
  }

  /**
   * Complete onboarding
   * Per API_CONTRACT.md: POST /user/onboarding
   * Per SPEC_PATCH.md: Idempotent per user, CREATED → ONBOARDING only
   */
  async completeOnboarding(
    userId: string,
    dto: OnboardingRequestDto,
  ): Promise<OnboardingResponseDto> {
    // Validate required fields manually (since DTOs are interfaces)
    const validationErrors = this.validateOnboardingDto(dto);
    if (validationErrors.length > 0) {
      const errorResponse: ApiErrorDto = {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Validation failed',
        error: 'Bad Request',
        constraints: validationErrors,
      };
      throw new BadRequestException(errorResponse);
    }

    // Check user exists and get current state
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        onboardingAnswers: true,
        conversations: {
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Idempotency: If already ONBOARDING, return existing result
    if (user.state === UserState.ONBOARDING) {
      if (!user.conversations[0]) {
        // Edge case: ONBOARDING state but no conversation - should not happen, but handle gracefully
        throw new BadRequestException({
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Onboarding incomplete: conversation not found',
          error: 'Bad Request',
        } as ApiErrorDto);
      }
      return {
        user_id: user.id,
        state: user.state as UserState,
        conversation_id: user.conversations[0].id,
        updated_at: user.updatedAt.toISOString(),
      };
    }

    // Reject if already ACTIVE
    if (user.state === UserState.ACTIVE) {
      const errorResponse: ApiErrorDto = {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'User is already active. Onboarding cannot be completed again.',
        error: 'Bad Request',
      };
      throw new BadRequestException(errorResponse);
    }

    // Only allow CREATED → ONBOARDING transition
    if (user.state !== UserState.CREATED) {
      const errorResponse: ApiErrorDto = {
        statusCode: HttpStatus.BAD_REQUEST,
        message: `Invalid user state: ${user.state}. Onboarding can only be completed from CREATED state.`,
        error: 'Bad Request',
      };
      throw new BadRequestException(errorResponse);
    }

    // All writes in a single transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // Convert shared enum string values to Prisma enum keys
      // AgeBand: "13-17" -> AGE_13_17, etc.
      const ageBandMap: Record<string, PrismaAgeBand> = {
        [AgeBand.AGE_13_17]: PrismaAgeBand.AGE_13_17,
        [AgeBand.AGE_18_24]: PrismaAgeBand.AGE_18_24,
        [AgeBand.AGE_25_34]: PrismaAgeBand.AGE_25_34,
        [AgeBand.AGE_35_44]: PrismaAgeBand.AGE_35_44,
        [AgeBand.AGE_45_PLUS]: PrismaAgeBand.AGE_45_PLUS,
      };

      // OccupationCategory: "student" -> student, etc. (same values)
      const occupationMap: Record<string, PrismaOccupationCategory> = {
        [OccupationCategory.STUDENT]: PrismaOccupationCategory.student,
        [OccupationCategory.WORKING]: PrismaOccupationCategory.working,
        [OccupationCategory.BETWEEN_JOBS]: PrismaOccupationCategory.between_jobs,
        [OccupationCategory.OTHER]: PrismaOccupationCategory.other,
      };

      const prismaAgeBand = ageBandMap[dto.age_band];
      const prismaOccupation = occupationMap[dto.occupation_category];

      if (!prismaAgeBand || !prismaOccupation) {
        throw new BadRequestException({
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Invalid enum value',
          error: 'Bad Request',
        } as ApiErrorDto);
      }

      // Create UserOnboardingAnswers
      const onboardingAnswers = await tx.userOnboardingAnswers.upsert({
        where: { userId },
        create: {
          userId,
          preferredName: dto.preferred_name,
          ageBand: prismaAgeBand,
          countryOrRegion: dto.country_or_region,
          occupationCategory: prismaOccupation,
          clientTimezone: dto.client_timezone,
        },
        update: {
          preferredName: dto.preferred_name,
          ageBand: prismaAgeBand,
          countryOrRegion: dto.country_or_region,
          occupationCategory: prismaOccupation,
          clientTimezone: dto.client_timezone,
        },
      });

      // Create UserControls
      await tx.userControls.upsert({
        where: { userId },
        create: {
          userId,
          proactiveMessagesEnabled: dto.proactive_messages_enabled,
          suppressedTopics: dto.suppressed_topics as any, // JSONB
        },
        update: {
          proactiveMessagesEnabled: dto.proactive_messages_enabled,
          suppressedTopics: dto.suppressed_topics as any,
        },
      });

      // Create AiFriend (required for Conversation)
      // For v0.1, create without personaTemplateId (assignment happens later)
      const aiFriend = await tx.aiFriend.upsert({
        where: { userId },
        create: {
          userId,
          // personaTemplateId and personaSeed will be assigned later
        },
        update: {},
      });

      // Create Conversation (check if exists first for idempotency)
      let conversation = await tx.conversation.findFirst({
        where: {
          userId,
          aiFriendId: aiFriend.id,
        },
      });

      if (!conversation) {
        conversation = await tx.conversation.create({
          data: {
            userId,
            aiFriendId: aiFriend.id,
          },
        });
      }

      // Update user state to ONBOARDING (NOT ACTIVE)
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          state: UserState.ONBOARDING,
        },
      });

      return {
        user: updatedUser,
        conversation,
      };
    });

    return {
      user_id: result.user.id,
      state: result.user.state as UserState,
      conversation_id: result.conversation.id,
      updated_at: result.user.updatedAt.toISOString(),
    };
  }

  /**
   * Register device for push notifications
   * Per SPEC_PATCH.md: POST /user/device
   */
  async registerDevice(
    userId: string,
    dto: RegisterDeviceDto,
  ): Promise<SuccessResponseDto> {
    // Validate
    if (!dto.push_token || typeof dto.push_token !== 'string') {
      const errorResponse: ApiErrorDto = {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'push_token is required and must be a string',
        error: 'Bad Request',
        constraints: ['push_token must be a non-empty string'],
      };
      throw new BadRequestException(errorResponse);
    }

    if (!dto.platform || !['ios', 'android'].includes(dto.platform)) {
      const errorResponse: ApiErrorDto = {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'platform must be "ios" or "android"',
        error: 'Bad Request',
        constraints: ['platform must be one of: ios, android'],
      };
      throw new BadRequestException(errorResponse);
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        pushToken: dto.push_token,
      },
    });

    return { success: true };
  }

  /**
   * Delete user account (hard delete)
   * Per SPEC_PATCH.md: DELETE /user/me
   * Hard delete: removes user and all dependent rows via CASCADE
   */
  async deleteUser(userId: string): Promise<void> {
    // Prisma CASCADE will handle deletion of:
    // - UserOnboardingAnswers
    // - UserControls
    // - AiFriend
    // - Conversation
    // - Messages
    // - Memories
    // - Relationships
    // - etc.
    await this.prisma.user.delete({
      where: { id: userId },
    });
  }

  /**
   * Validate OnboardingRequestDto
   * Returns array of constraint messages for ApiErrorDto
   */
  private validateOnboardingDto(dto: OnboardingRequestDto): string[] {
    const errors: string[] = [];

    if (!dto.preferred_name || typeof dto.preferred_name !== 'string') {
      errors.push('preferred_name is required and must be a string');
    } else if (dto.preferred_name.length < 1 || dto.preferred_name.length > 64) {
      errors.push('preferred_name must be between 1 and 64 characters');
    }

    if (!dto.age_band) {
      errors.push('age_band is required');
    }

    if (!dto.country_or_region || typeof dto.country_or_region !== 'string') {
      errors.push('country_or_region is required and must be a string');
    } else if (dto.country_or_region.length !== 2) {
      errors.push('country_or_region must be a valid ISO 3166-1 alpha-2 code (2 characters)');
    }

    if (!dto.occupation_category) {
      errors.push('occupation_category is required');
    }

    if (!dto.client_timezone || typeof dto.client_timezone !== 'string') {
      errors.push('client_timezone is required and must be a string');
    }

    if (typeof dto.proactive_messages_enabled !== 'boolean') {
      errors.push('proactive_messages_enabled is required and must be a boolean');
    }

    if (!Array.isArray(dto.suppressed_topics)) {
      errors.push('suppressed_topics is required and must be an array');
    }

    return errors;
  }
}
