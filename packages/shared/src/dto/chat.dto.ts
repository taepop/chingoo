// Chat DTOs (packages/shared/src/dto/chat.dto.ts)
// Endpoint: POST /chat/send
// Per API_CONTRACT.md §3

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
   * Storage rule (v0.1): Used only for telemetry/heuristics and is NOT persisted in Postgres in v0.1.
   * If provided, it may be logged in structured logs keyed by message_id.
   * Per SPEC_PATCH.md §[NEW – CLARIFICATION]
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
