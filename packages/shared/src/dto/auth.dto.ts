// Auth DTOs (packages/shared/src/dto/auth.dto.ts)
// Endpoints: POST /auth/login, POST /auth/signup
// Per API_CONTRACT.md §5

import { UserState } from '../enums';

/**
 * Login request - supports both email/password and Cognito token auth
 */
export interface AuthRequestDto {
  /**
   * Email address for email/password authentication.
   * Required when using email/password auth.
   */
  email?: string;

  /**
   * Password for email/password authentication.
   * Required when using email/password auth.
   */
  password?: string;

  /**
   * The ID token from AWS Cognito (client-side auth).
   * Required when using Cognito auth (legacy/alternative).
   */
  identity_token?: string;
}

/**
 * Signup request - creates a new user with email/password
 */
export interface SignupRequestDto {
  /**
   * User's email address (must be unique).
   */
  email: string;

  /**
   * User's password (min 8 chars, must contain letter + number).
   */
  password: string;

  /**
   * Password confirmation (must match password).
   */
  confirm_password: string;
}

/**
 * Auth response - returned on successful login or signup
 */
export interface AuthResponseDto {
  access_token: string;
  user_id: string;
  email?: string;
  /**
   * Critical for routing the user to Onboarding vs Chat on login.
   */
  state: UserState;
}
