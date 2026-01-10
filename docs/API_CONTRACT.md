API_CONTRACT.md
CRITICAL INSTRUCTION FOR AI AGENTS: This file is the Single Source of Truth for the API interface.

Location: packages/shared/src/

Usage: Imported by apps/mobile (Frontend) and apps/api (Backend).

Strictness: Do not deviate from these field names or types.

1. Shared Enums (packages/shared/src/enums.ts)
export enum UserState {
  CREATED = "CREATED",
  ONBOARDING = "ONBOARDING",
  ACTIVE = "ACTIVE"
}

export enum AgeBand {
  AGE_13_17 = "13-17",
  AGE_18_24 = "18-24",
  AGE_25_34 = "25-34",
  AGE_35_44 = "35-44",
  AGE_45_PLUS = "45+"
}

export enum OccupationCategory {
  STUDENT = "student",
  WORKING = "working",
  BETWEEN_JOBS = "between_jobs",
  OTHER = "other"
}

export enum TopicId {
  POLITICS = "POLITICS",
  RELIGION = "RELIGION",
  SEXUAL_CONTENT = "SEXUAL_CONTENT",
  SEXUAL_JOKES = "SEXUAL_JOKES",
  MENTAL_HEALTH = "MENTAL_HEALTH",
  SELF_HARM = "SELF_HARM",
  SUBSTANCES = "SUBSTANCES",
  GAMBLING = "GAMBLING",
  VIOLENCE = "VIOLENCE",
  ILLEGAL_ACTIVITY = "ILLEGAL_ACTIVITY",
  HATE_HARASSMENT = "HATE_HARASSMENT",
  MEDICAL_HEALTH = "MEDICAL_HEALTH",
  PERSONAL_FINANCE = "PERSONAL_FINANCE",
  RELATIONSHIPS = "RELATIONSHIPS",
  FAMILY = "FAMILY",
  WORK_SCHOOL = "WORK_SCHOOL",
  TRAVEL = "TRAVEL",
  ENTERTAINMENT = "ENTERTAINMENT",
  TECH_GAMING = "TECH_GAMING"
}

2. Onboarding DTOs (packages/shared/src/dto/onboarding.dto.ts)
Endpoint: POST /user/onboarding
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

3. Chat DTOs (packages/shared/src/dto/chat.dto.ts)
Endpoint: POST /chat/send
import { UserState } from '../enums';

export interface ChatRequestDto {
  /**
   * Client-generated UUID v4 for idempotency.
   */
  message_id: string;

  /**
   * The conversation ID (returned from Onboarding or /user/me).
   */
  conversation_id: string;

  /**
   * Raw user text. Max 4000 chars.
   */
  user_message: string;

  /**
   * ISO 8601 timestamp of send time.
   */
  local_timestamp: string;

  /**
   * Current device timezone (for context-aware replies).
   */
  user_timezone: string;
}

export interface ChatResponseDto {
  /**
   * Echo request message_id.
   */
  message_id: string;

  /**
   * The new state of the user.
   * Frontend must check this. If it changes from ONBOARDING -> ACTIVE,
   * the UI should unlock full chat features.
   */
  user_state: UserState;

  assistant_message: {
    id: string;
    content: string;
    created_at: string;
  };
}

4. Settings DTOs (packages/shared/src/dto/settings.dto.ts)
Endpoint: PATCH /user/timezone
export interface UpdateTimezoneDto {
  /**
   * IANA Timezone string.
   */
  timezone: string;
}

export interface SuccessResponseDto {
  success: boolean;
}

5. Standard Plumbing Endpoints (Missing & Required)
Endpoint: POST /auth/login (or Signup) Purpose: Authenticates the user and returns the token required for all other calls.
// packages/shared/src/dto/auth.dto.ts

export interface AuthRequestDto {
  /**
   * The ID token from AWS Cognito (client-side auth).
   */
  identity_token: string;
  email?: string;
}

export interface AuthResponseDto {
  access_token: string;
  user_id: string;
  /**
   * Critical for routing the user to Onboarding vs Chat on login.
   */
  state: UserState; 
}

Endpoint: GET /user/me Purpose: Called on App Launch to check if the user is ONBOARDING or ACTIVE.
// packages/shared/src/dto/user.dto.ts

export interface UserProfileResponseDto {
  user_id: string;
  preferred_name: string;
  state: UserState; // CREATED | ONBOARDING | ACTIVE
  conversation_id?: string; // Null if not yet created
}

Endpoint: GET /chat/history Purpose: Loads previous messages when the user opens the chat screen.
// packages/shared/src/dto/history.dto.ts

export interface GetHistoryRequestDto {
  conversation_id: string;
  /**
   * Pagination: fetch messages older than this date.
   */
  before_timestamp?: string; 
  limit?: number; // Default 20
}

export interface HistoryResponseDto {
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    created_at: string;
  }>;
}