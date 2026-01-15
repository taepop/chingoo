/**
 * API Client
 * Per API_CONTRACT.md: All endpoints use DTOs from @chingoo/shared
 */

import {
  AuthRequestDto,
  AuthResponseDto,
  UserProfileResponseDto,
  OnboardingRequestDto,
  OnboardingResponseDto,
  ChatRequestDto,
  ChatResponseDto,
} from '@chingoo/shared';

/**
 * Base URL for API requests.
 * - Uses EXPO_PUBLIC_API_URL env var if set
 * - Defaults to 10.0.2.2:3000 for Android emulator compatibility
 *   (10.0.2.2 is the special alias to host loopback in Android emulator)
 */
const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL || 'http://10.0.2.2:3000';

class ApiError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public error: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchWithAuth<T>(
  endpoint: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new ApiError(
      errorData.statusCode || response.status,
      errorData.message || response.statusText,
      errorData.error || 'Unknown error',
    );
  }

  return response.json();
}

export const api = {
  /**
   * POST /auth/login
   * Per API_CONTRACT.md: Authenticates the user and returns the token required for all other calls.
   * Request: AuthRequestDto { identity_token, email? }
   * Response: AuthResponseDto { access_token, user_id, state }
   */
  async login(
    identityToken: string,
    email?: string,
  ): Promise<AuthResponseDto> {
    const request: AuthRequestDto = {
      identity_token: identityToken,
      email,
    };
    return fetchWithAuth<AuthResponseDto>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  /**
   * GET /user/me
   * Per API_CONTRACT.md: Called on App Launch to check if the user is ONBOARDING or ACTIVE.
   * Response: UserProfileResponseDto { user_id, preferred_name, state, conversation_id? }
   */
  async getMe(token: string): Promise<UserProfileResponseDto> {
    return fetchWithAuth<UserProfileResponseDto>(
      '/user/me',
      { method: 'GET' },
      token,
    );
  },

  /**
   * POST /user/onboarding
   * Per API_CONTRACT.md: Submits onboarding data and creates conversation.
   * Request: OnboardingRequestDto {
   *   preferred_name, age_band, country_or_region, occupation_category,
   *   client_timezone, proactive_messages_enabled, suppressed_topics
   * }
   * Response: OnboardingResponseDto { user_id, state, conversation_id, updated_at }
   */
  async onboarding(
    token: string,
    request: OnboardingRequestDto,
  ): Promise<OnboardingResponseDto> {
    return fetchWithAuth<OnboardingResponseDto>(
      '/user/onboarding',
      {
        method: 'POST',
        body: JSON.stringify(request),
      },
      token,
    );
  },

  /**
   * POST /chat/send
   * Per API_CONTRACT.md: Sends a user message and receives AI response.
   * Request: ChatRequestDto {
   *   message_id, conversation_id, user_message, local_timestamp, user_timezone
   * }
   * Response: ChatResponseDto { message_id, user_state, assistant_message }
   */
  async sendMessage(
    token: string,
    request: ChatRequestDto,
  ): Promise<ChatResponseDto> {
    return fetchWithAuth<ChatResponseDto>(
      '/chat/send',
      {
        method: 'POST',
        body: JSON.stringify(request),
      },
      token,
    );
  },
};

export { ApiError };
