/**
 * Retention Eligibility Checker
 *
 * Implements AI_PIPELINE.md §14.0 + §14.1:
 * - Quiet hours: local time NOT within 00:00–08:00
 * - Attempt window: local time within 10:00–21:00
 * - proactive_messages_enabled = true
 * - mute_until is null or now > mute_until
 * - Stage-based caps: STRANGER=0, ACQUAINTANCE=1/3days, FRIEND=1/day, CLOSE_FRIEND=2/day
 * - Minimum inactivity: ACQUAINTANCE=48h, FRIEND=24h, CLOSE_FRIEND=12h × backoff_multiplier
 */

import { RelationshipStage, RetentionStatus } from '@prisma/client';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface EligibilityInput {
  userId: string;
  aiFriendId: string;
  relationshipStage: RelationshipStage;
  lastInteractionAt: Date;
  proactiveMessagesEnabled: boolean;
  muteUntil: Date | null;
  backoffMultiplier: number;
  /** User's IANA timezone string (e.g., "Asia/Seoul") */
  userTimezone: string;
  /** Number of DELIVERED retention attempts in the relevant cap period */
  recentRetentionCount: number;
  /** Timestamp of oldest retention in cap period (for 3-day ACQUAINTANCE cap) */
  oldestRecentRetentionAt: Date | null;
}

export interface EligibilityResult {
  userId: string;
  aiFriendId: string;
  isEligible: boolean;
  blockReason: BlockReason | null;
  nextAllowedAt: Date | null;
}

export type BlockReason =
  | 'proactive_disabled'
  | 'muted'
  | 'quiet_hours'
  | 'outside_attempt_window'
  | 'cap_exceeded'
  | 'recently_active'
  | 'stranger';

// ─────────────────────────────────────────────────────────────
// Constants (from AI_PIPELINE.md §14.1 + §15)
// ─────────────────────────────────────────────────────────────

/** Quiet hours: 00:00–08:00 local (hard block) */
export const QUIET_HOURS_START = 0;
export const QUIET_HOURS_END = 8;

/** Attempt window: 10:00–21:00 local */
export const ATTEMPT_WINDOW_START = 10;
export const ATTEMPT_WINDOW_END = 21;

/** Minimum inactivity thresholds in milliseconds (per stage) */
export const INACTIVITY_THRESHOLDS_MS: Record<RelationshipStage, number> = {
  STRANGER: Infinity, // Never eligible
  ACQUAINTANCE: 48 * 60 * 60 * 1000, // 48 hours
  FRIEND: 24 * 60 * 60 * 1000, // 24 hours
  CLOSE_FRIEND: 12 * 60 * 60 * 1000, // 12 hours
};

/** Stage-based caps */
export const STAGE_CAPS: Record<RelationshipStage, { count: number; periodDays: number }> = {
  STRANGER: { count: 0, periodDays: 1 },
  ACQUAINTANCE: { count: 1, periodDays: 3 },
  FRIEND: { count: 1, periodDays: 1 },
  CLOSE_FRIEND: { count: 2, periodDays: 1 },
};

// ─────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────

/**
 * Get the current hour in the user's timezone.
 * Uses IANA timezone for accurate local time calculation.
 *
 * @param now - The current UTC timestamp
 * @param timezone - IANA timezone string (e.g., "Asia/Seoul")
 * @returns The local hour (0-23)
 */
export function getLocalHour(now: Date, timezone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hourPart = parts.find((p) => p.type === 'hour');
    const hour = hourPart ? parseInt(hourPart.value, 10) : 0;
    // Intl.DateTimeFormat can return 24 for midnight, normalize to 0
    return hour === 24 ? 0 : hour;
  } catch {
    // Fallback to UTC if timezone is invalid
    return now.getUTCHours();
  }
}

/**
 * Check if the given hour is within quiet hours (00:00–08:00).
 * Per AI_PIPELINE.md §14.1: "local time NOT within 00:00–08:00"
 */
export function isQuietHours(localHour: number): boolean {
  return localHour >= QUIET_HOURS_START && localHour < QUIET_HOURS_END;
}

/**
 * Check if the given hour is within the attempt window (10:00–21:00).
 * Per AI_PIPELINE.md §14.0: "Only attempt if local time is within 10:00–21:00"
 */
export function isWithinAttemptWindow(localHour: number): boolean {
  return localHour >= ATTEMPT_WINDOW_START && localHour < ATTEMPT_WINDOW_END;
}

/**
 * Calculate the effective inactivity threshold with backoff.
 * Per AI_PIPELINE.md §14.0: "multiply the minimum inactivity threshold by the existing backoff multiplier"
 */
export function getEffectiveInactivityThreshold(
  stage: RelationshipStage,
  backoffMultiplier: number
): number {
  const baseThreshold = INACTIVITY_THRESHOLDS_MS[stage];
  return baseThreshold * backoffMultiplier;
}

/**
 * Check if the user has been inactive long enough to receive retention.
 */
export function isInactiveEnough(
  lastInteractionAt: Date,
  now: Date,
  stage: RelationshipStage,
  backoffMultiplier: number
): boolean {
  const threshold = getEffectiveInactivityThreshold(stage, backoffMultiplier);
  if (threshold === Infinity) return false;

  const elapsed = now.getTime() - lastInteractionAt.getTime();
  return elapsed >= threshold;
}

/**
 * Check if the stage-based cap allows another retention message.
 * Per AI_PIPELINE.md §14.1:
 * - STRANGER: 0/day
 * - ACQUAINTANCE: max 1 per 3 days
 * - FRIEND: max 1/day
 * - CLOSE_FRIEND: max 2/day
 */
export function isCapExceeded(
  stage: RelationshipStage,
  recentRetentionCount: number
): boolean {
  const cap = STAGE_CAPS[stage];
  return recentRetentionCount >= cap.count;
}

// ─────────────────────────────────────────────────────────────
// Main Eligibility Check
// ─────────────────────────────────────────────────────────────

/**
 * Check retention eligibility for a single user.
 * Deterministic: same input + same "now" = same output.
 *
 * Per AI_PIPELINE.md §14.0 + §14.1:
 * 1. Check proactive_messages_enabled
 * 2. Check mute_until
 * 3. Check quiet hours (00:00–08:00 hard block)
 * 4. Check attempt window (10:00–21:00)
 * 5. Check stage (STRANGER blocked)
 * 6. Check stage-based cap
 * 7. Check minimum inactivity with backoff
 */
export function checkEligibility(input: EligibilityInput, now: Date): EligibilityResult {
  const { userId, aiFriendId } = input;

  // 1. Check proactive_messages_enabled
  if (!input.proactiveMessagesEnabled) {
    return {
      userId,
      aiFriendId,
      isEligible: false,
      blockReason: 'proactive_disabled',
      nextAllowedAt: null,
    };
  }

  // 2. Check mute_until
  if (input.muteUntil && now.getTime() <= input.muteUntil.getTime()) {
    return {
      userId,
      aiFriendId,
      isEligible: false,
      blockReason: 'muted',
      nextAllowedAt: input.muteUntil,
    };
  }

  // Get local hour for timezone-based checks
  const localHour = getLocalHour(now, input.userTimezone);

  // 3. Check quiet hours (hard block 00:00–08:00)
  if (isQuietHours(localHour)) {
    return {
      userId,
      aiFriendId,
      isEligible: false,
      blockReason: 'quiet_hours',
      nextAllowedAt: null, // Next allowed at 08:00 local
    };
  }

  // 4. Check attempt window (10:00–21:00)
  if (!isWithinAttemptWindow(localHour)) {
    return {
      userId,
      aiFriendId,
      isEligible: false,
      blockReason: 'outside_attempt_window',
      nextAllowedAt: null, // Next allowed at 10:00 local
    };
  }

  // 5. Check stage (STRANGER can never receive retention)
  if (input.relationshipStage === 'STRANGER') {
    return {
      userId,
      aiFriendId,
      isEligible: false,
      blockReason: 'stranger',
      nextAllowedAt: null,
    };
  }

  // 6. Check stage-based cap
  if (isCapExceeded(input.relationshipStage, input.recentRetentionCount)) {
    return {
      userId,
      aiFriendId,
      isEligible: false,
      blockReason: 'cap_exceeded',
      nextAllowedAt: null,
    };
  }

  // 7. Check minimum inactivity with backoff
  if (!isInactiveEnough(input.lastInteractionAt, now, input.relationshipStage, input.backoffMultiplier)) {
    return {
      userId,
      aiFriendId,
      isEligible: false,
      blockReason: 'recently_active',
      nextAllowedAt: null,
    };
  }

  // All checks passed
  return {
    userId,
    aiFriendId,
    isEligible: true,
    blockReason: null,
    nextAllowedAt: null,
  };
}

/**
 * Batch check eligibility for multiple users.
 * Returns results in deterministic order (sorted by lastInteractionAt ASC, then userId ASC).
 *
 * This ensures: same DB state + same "now" = identical selected eligible set.
 */
export function checkEligibilityBatch(
  inputs: EligibilityInput[],
  now: Date
): EligibilityResult[] {
  // Deterministic ordering: sort by lastInteractionAt ASC, then userId ASC
  const sortedInputs = [...inputs].sort((a, b) => {
    const timeDiff = a.lastInteractionAt.getTime() - b.lastInteractionAt.getTime();
    if (timeDiff !== 0) return timeDiff;
    return a.userId.localeCompare(b.userId);
  });

  return sortedInputs.map((input) => checkEligibility(input, now));
}
