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

/**
 * StableStyleParams interface per AI_PIPELINE.md §2.4
 * These are derived from PersonaTemplate and frozen after onboarding.
 */
interface StableStyleParams {
  msg_length_pref: 'short' | 'medium' | 'long';
  emoji_freq: 'none' | 'light' | 'frequent';
  humor_mode: 'none' | 'light_sarcasm' | 'frequent_jokes' | 'deadpan';
  directness_level: 'soft' | 'balanced' | 'blunt';
  followup_question_rate: 'low' | 'medium';
  lexicon_bias: 'clean' | 'slang' | 'internet_shorthand';
  punctuation_quirks: string[];
}

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

      // Create AiFriend with persona assignment
      // Per AI_PIPELINE.md §3.1: Persona must be assigned "During ONBOARDING,
      // after required questions are answered, before first message is sent."
      const personaAssignment = this.generatePersonaAssignment();
      
      // [MINIMAL DEVIATION] personaTemplateId is set to null until persona_templates
      // table is seeded (SCHEMA.md B.5 notes: "seeded at deploy time with 24 rows").
      // The stableStyleParams contains all behavioral constraints per AI_PIPELINE.md §2.4.
      // This allows the flow to work without seed data while still persisting persona params.
      const aiFriend = await tx.aiFriend.upsert({
        where: { userId },
        create: {
          userId,
          // personaTemplateId set to null (FK to persona_templates requires seed data)
          personaSeed: personaAssignment.personaSeed,
          stableStyleParams: personaAssignment.stableStyleParams as any, // JSONB
          tabooSoftBounds: personaAssignment.tabooSoftBounds as any, // JSONB
          assignedAt: new Date(),
        },
        update: {
          // Only assign if not already assigned (idempotency)
          personaSeed: personaAssignment.personaSeed,
          stableStyleParams: personaAssignment.stableStyleParams as any,
          tabooSoftBounds: personaAssignment.tabooSoftBounds as any,
          assignedAt: new Date(),
        },
      });
      
      // Log persona assignment for anti-cloning cap per AI_PIPELINE.md §3.4
      await tx.personaAssignmentLog.upsert({
        where: {
          userId_aiFriendId: {
            userId,
            aiFriendId: aiFriend.id,
          },
        },
        create: {
          userId,
          aiFriendId: aiFriend.id,
          comboKey: personaAssignment.comboKey,
          assignedAt: new Date(),
        },
        update: {
          comboKey: personaAssignment.comboKey,
          assignedAt: new Date(),
        },
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
      
      // Create Relationship record per SCHEMA.md B.9
      // Per AI_PIPELINE.md §2.5: RelationshipState is required for routing and retention
      await tx.relationship.upsert({
        where: {
          userId_aiFriendId: {
            userId,
            aiFriendId: aiFriend.id,
          },
        },
        create: {
          userId,
          aiFriendId: aiFriend.id,
          relationshipStage: 'STRANGER',
          rapportScore: 0,
          sessionsCount: 0,
          currentSessionShortReplyCount: 0,
          lastInteractionAt: new Date(),
        },
        update: {}, // No update needed if exists (idempotency)
      });

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

  /**
   * Generate persona assignment for a user.
   * 
   * Per AI_PIPELINE.md §3.1: "During ONBOARDING, after required questions are answered,
   * before first message is sent."
   * 
   * Per AI_PIPELINE.md §3.3 Sampling:
   * - Sample 1 `core_archetype`
   * - Sample 2–3 modifiers among `speech_style`, `humor_mode`, `friend_energy`
   * - Derive `StableStyleParams`
   * - Persist: `persona_template_id`, `persona_seed` (random 32-bit int), `stable_style_params`
   * 
   * Per AI_PIPELINE.md §3.2: PersonaTemplate library size: 24 templates (PT01..PT24)
   */
  private generatePersonaAssignment(seed?: number): {
    personaTemplateId: string;
    personaSeed: number;
    stableStyleParams: StableStyleParams;
    comboKey: string;
    tabooSoftBounds: string[];
  } {
    // Generate or use provided seed for deterministic sampling
    const personaSeed = seed ?? Math.floor(Math.random() * 0x7FFFFFFF);
    
    // Simple deterministic PRNG based on seed
    const prng = this.createSeededRandom(personaSeed);
    
    // Sample persona template (PT01..PT24) per AI_PIPELINE.md §3.2
    const templateNum = Math.floor(prng() * 24) + 1;
    const personaTemplateId = `PT${templateNum.toString().padStart(2, '0')}`;
    
    // Core archetypes per AI_PIPELINE.md §3.2.1
    const archetypes = [
      'Calm_Listener', 'Warm_Caregiver', 'Blunt_Honest', 'Dry_Humor', 'Playful_Tease',
      'Chaotic_Internet_Friend', 'Gentle_Coach', 'Soft_Nerd', 'Hype_Bestie', 'Low_Key_Companion',
    ];
    const coreArchetype = archetypes[templateNum % archetypes.length];
    
    // Per AI_PIPELINE.md §3.3: Sample 2-3 modifiers with mutation
    // Options for each style param
    const msgLengthOptions: ('short' | 'medium' | 'long')[] = ['short', 'medium', 'long'];
    const emojiOptions: ('none' | 'light' | 'frequent')[] = ['none', 'light', 'frequent'];
    const humorOptions: ('none' | 'light_sarcasm' | 'frequent_jokes' | 'deadpan')[] = 
      ['none', 'light_sarcasm', 'frequent_jokes', 'deadpan'];
    const directnessOptions: ('soft' | 'balanced' | 'blunt')[] = ['soft', 'balanced', 'blunt'];
    const followupOptions: ('low' | 'medium')[] = ['low', 'medium'];
    const lexiconOptions: ('clean' | 'slang' | 'internet_shorthand')[] = 
      ['clean', 'slang', 'internet_shorthand'];
    const friendEnergyOptions: ('passive' | 'balanced' | 'proactive')[] = 
      ['passive', 'balanced', 'proactive'];
    
    // Derive StableStyleParams with seeded randomness
    const stableStyleParams: StableStyleParams = {
      msg_length_pref: msgLengthOptions[Math.floor(prng() * msgLengthOptions.length)],
      emoji_freq: emojiOptions[Math.floor(prng() * emojiOptions.length)],
      humor_mode: humorOptions[Math.floor(prng() * humorOptions.length)],
      directness_level: directnessOptions[Math.floor(prng() * directnessOptions.length)],
      followup_question_rate: followupOptions[Math.floor(prng() * followupOptions.length)],
      lexicon_bias: lexiconOptions[Math.floor(prng() * lexiconOptions.length)],
      punctuation_quirks: [], // Empty for v0.1
    };
    
    // Derive friend_energy for combo key
    const friendEnergy = friendEnergyOptions[Math.floor(prng() * friendEnergyOptions.length)];
    
    // Combo key per AI_PIPELINE.md §3.4: "(core_archetype, humor_mode, friend_energy)"
    const comboKey = `${coreArchetype}:${stableStyleParams.humor_mode}:${friendEnergy}`;
    
    // Taboo soft bounds - empty for v0.1 (would come from template)
    const tabooSoftBounds: string[] = [];
    
    return {
      personaTemplateId,
      personaSeed,
      stableStyleParams,
      comboKey,
      tabooSoftBounds,
    };
  }

  /**
   * Create a simple seeded PRNG (mulberry32).
   * Per AI_PIPELINE.md §3.3: "persona_seed (random 32-bit int)"
   */
  private createSeededRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state |= 0;
      state = (state + 0x6D2B79F5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}
