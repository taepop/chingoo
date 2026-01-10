// Settings DTOs (packages/shared/src/dto/settings.dto.ts)
// Endpoint: PATCH /user/timezone
// Per API_CONTRACT.md §4

export interface UpdateTimezoneDto {
  /**
   * IANA Timezone string.
   */
  timezone: string;
}

export interface SuccessResponseDto {
  success: boolean;
}

// Device Registration DTO (SPEC_PATCH.md addition)
// Endpoint: POST /user/device
// Per SPEC_PATCH.md §[NEW – REQUIRED ADDITION] Device Registration Endpoint

export interface RegisterDeviceDto {
  /**
   * Push notification token
   */
  push_token: string;
  platform: 'ios' | 'android';
}
