/**
 * API Client
 * Per API_CONTRACT.md: All endpoints use DTOs from @chingoo/shared
 */

import {
  AuthRequestDto,
  AuthResponseDto,
  UserProfileResponseDto,
} from '@chingoo/shared';

const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';

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
   */
  async getMe(token: string): Promise<UserProfileResponseDto> {
    return fetchWithAuth<UserProfileResponseDto>('/user/me', {
      method: 'GET',
    }, token);
  },
};

export { ApiError };
