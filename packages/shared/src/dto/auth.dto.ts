// Auth DTOs (packages/shared/src/dto/auth.dto.ts)
// Endpoint: POST /auth/login (or Signup)
// Per API_CONTRACT.md §5

import { UserState } from '../enums';

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
