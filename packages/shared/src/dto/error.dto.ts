// Error DTOs (packages/shared/src/dto/error.dto.ts)
// Per SPEC_PATCH.md §[NEW – ADDITION] Standard Error DTOs

export interface ApiErrorDto {
  statusCode: number;
  message: string;
  error: string;
  /**
   * Included only for validation errors (400)
   */
  constraints?: string[];
}

/**
 * Explicit Status Codes (per SPEC_PATCH.md):
 * - 400 Bad Request: Validation failed (e.g., missing fields in Onboarding)
 * - 401 Unauthorized: Invalid or missing Auth Token
 * - 403 Forbidden: User state is CREATED (accessing chat) or Safety Ban
 * - 409 Conflict: Idempotency key collision (if handled as error) or unique constraint violation
 */
