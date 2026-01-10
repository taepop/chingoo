// Onboarding DTOs (packages/shared/src/dto/onboarding.dto.ts)
// Endpoint: POST /user/onboarding
// Per API_CONTRACT.md §2

import { AgeBand, OccupationCategory, TopicId, UserState } from '../enums';

export interface OnboardingRequestDto {
  /**
   * The name the AI should use to address the user.
   * Validation: Min 1, Max 64 chars.
   */
  preferred_name: string;

  /**
   * Required for safety gating.
   */
  age_band: AgeBand;

  /**
   * ISO 3166-1 alpha-2 country code (e.g., "US", "KR").
   */
  country_or_region: string;

  /**
   * General categorization for persona context.
   */
  occupation_category: OccupationCategory;

  /**
   * IANA Timezone string (e.g., "Asia/Seoul").
   */
  client_timezone: string;

  /**
   * Default: true.
   */
  proactive_messages_enabled: boolean;

  /**
   * List of topics the user wants to avoid.
   */
  suppressed_topics: TopicId[];
}

export interface OnboardingResponseDto {
  user_id: string;

  /**
   * Will be ONBOARDING until the first message is sent.
   */
  state: UserState;

  /**
   * Critical: The conversation ID created for the user and their new AI friend.
   * The client must use this ID to send the first message.
   */
  conversation_id: string;

  updated_at: string;
}
