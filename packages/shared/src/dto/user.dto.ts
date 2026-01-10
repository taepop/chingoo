// User DTOs (packages/shared/src/dto/user.dto.ts)
// Endpoint: GET /user/me
// Per API_CONTRACT.md §5

import { UserState } from '../enums';

export interface UserProfileResponseDto {
  user_id: string;
  preferred_name: string;
  state: UserState; // CREATED | ONBOARDING | ACTIVE
  conversation_id?: string; // Null if not yet created
}
