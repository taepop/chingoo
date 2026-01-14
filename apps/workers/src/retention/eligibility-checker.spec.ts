/**
 * Retention Eligibility Checker Tests
 *
 * TEST GATE #8 — Eligibility & Safety (MANDATORY)
 *
 * Required deterministic tests:
 * 1) Quiet hours exclusion: user is eligible by all other rules but within quiet hours → excluded.
 * 2) Proactive disabled OR muted exclusion: excluded regardless of other rules.
 * 3) Stage exclusion (or other explicit eligibility rule): excluded based on relationship stage gating.
 * 4) Determinism test: same DB state + same "now" time input → selected eligible set is identical.
 */

import { RelationshipStage } from '@prisma/client';
import {
  checkEligibility,
  checkEligibilityBatch,
  EligibilityInput,
  EligibilityResult,
  getLocalHour,
  isQuietHours,
  isWithinAttemptWindow,
  isInactiveEnough,
  isCapExceeded,
  QUIET_HOURS_START,
  QUIET_HOURS_END,
  ATTEMPT_WINDOW_START,
  ATTEMPT_WINDOW_END,
  INACTIVITY_THRESHOLDS_MS,
} from './eligibility-checker';

// ─────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────

/**
 * Create a base eligibility input for testing.
 * By default, all conditions pass (eligible user).
 */
function createBaseInput(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    userId: 'test-user-001',
    aiFriendId: 'test-friend-001',
    relationshipStage: 'FRIEND', // Eligible stage
    lastInteractionAt: new Date('2026-01-10T10:00:00Z'), // 5 days ago (inactive enough for FRIEND 24h)
    proactiveMessagesEnabled: true,
    muteUntil: null,
    backoffMultiplier: 1,
    userTimezone: 'Asia/Seoul', // UTC+9
    recentRetentionCount: 0, // Under cap
    oldestRecentRetentionAt: null,
    ...overrides,
  };
}

/**
 * Create a "now" timestamp for testing.
 * Default: 2026-01-15 15:00 UTC → 2026-01-16 00:00 Seoul (midnight = quiet hours)
 * Use explicit UTC times for deterministic testing.
 */
function createNow(isoString: string = '2026-01-15T06:00:00Z'): Date {
  return new Date(isoString);
}

// ─────────────────────────────────────────────────────────────
// Helper Function Tests
// ─────────────────────────────────────────────────────────────

describe('getLocalHour', () => {
  it('should return correct local hour for Asia/Seoul timezone', () => {
    // 15:00 UTC = 00:00 next day in Seoul (UTC+9)
    const now = new Date('2026-01-15T15:00:00Z');
    expect(getLocalHour(now, 'Asia/Seoul')).toBe(0);
  });

  it('should return correct local hour for America/New_York timezone', () => {
    // 15:00 UTC = 10:00 in New York (UTC-5, standard time in January)
    const now = new Date('2026-01-15T15:00:00Z');
    expect(getLocalHour(now, 'America/New_York')).toBe(10);
  });

  it('should return correct local hour for Europe/London timezone', () => {
    // 15:00 UTC = 15:00 in London (UTC+0 in winter)
    const now = new Date('2026-01-15T15:00:00Z');
    expect(getLocalHour(now, 'Europe/London')).toBe(15);
  });

  it('should fall back to UTC for invalid timezone', () => {
    const now = new Date('2026-01-15T15:00:00Z');
    expect(getLocalHour(now, 'Invalid/Timezone')).toBe(15);
  });
});

describe('isQuietHours', () => {
  it('should return true for hours 0-7 (quiet hours 00:00-08:00)', () => {
    expect(isQuietHours(0)).toBe(true);
    expect(isQuietHours(1)).toBe(true);
    expect(isQuietHours(7)).toBe(true);
  });

  it('should return false for hour 8 (end of quiet hours)', () => {
    expect(isQuietHours(8)).toBe(false);
  });

  it('should return false for hours outside quiet hours', () => {
    expect(isQuietHours(9)).toBe(false);
    expect(isQuietHours(15)).toBe(false);
    expect(isQuietHours(23)).toBe(false);
  });
});

describe('isWithinAttemptWindow', () => {
  it('should return true for hours 10-20 (attempt window 10:00-21:00)', () => {
    expect(isWithinAttemptWindow(10)).toBe(true);
    expect(isWithinAttemptWindow(15)).toBe(true);
    expect(isWithinAttemptWindow(20)).toBe(true);
  });

  it('should return false for hour 21 (end of window)', () => {
    expect(isWithinAttemptWindow(21)).toBe(false);
  });

  it('should return false for hours outside attempt window', () => {
    expect(isWithinAttemptWindow(8)).toBe(false);
    expect(isWithinAttemptWindow(9)).toBe(false);
    expect(isWithinAttemptWindow(22)).toBe(false);
  });
});

describe('isInactiveEnough', () => {
  const now = new Date('2026-01-15T12:00:00Z');

  it('should return false for STRANGER (never eligible)', () => {
    const recentInteraction = new Date('2026-01-01T00:00:00Z');
    expect(isInactiveEnough(recentInteraction, now, 'STRANGER', 1)).toBe(false);
  });

  it('should return true for ACQUAINTANCE after 48h of inactivity', () => {
    const inactiveFor50h = new Date(now.getTime() - 50 * 60 * 60 * 1000);
    expect(isInactiveEnough(inactiveFor50h, now, 'ACQUAINTANCE', 1)).toBe(true);
  });

  it('should return false for ACQUAINTANCE within 48h of inactivity', () => {
    const inactiveFor24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    expect(isInactiveEnough(inactiveFor24h, now, 'ACQUAINTANCE', 1)).toBe(false);
  });

  it('should return true for FRIEND after 24h of inactivity', () => {
    const inactiveFor25h = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    expect(isInactiveEnough(inactiveFor25h, now, 'FRIEND', 1)).toBe(true);
  });

  it('should return false for FRIEND within 24h of inactivity', () => {
    const inactiveFor12h = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    expect(isInactiveEnough(inactiveFor12h, now, 'FRIEND', 1)).toBe(false);
  });

  it('should return true for CLOSE_FRIEND after 12h of inactivity', () => {
    const inactiveFor13h = new Date(now.getTime() - 13 * 60 * 60 * 1000);
    expect(isInactiveEnough(inactiveFor13h, now, 'CLOSE_FRIEND', 1)).toBe(true);
  });

  it('should apply backoff multiplier correctly', () => {
    // FRIEND base threshold = 24h
    // With backoff_multiplier = 2, effective threshold = 48h
    const inactiveFor30h = new Date(now.getTime() - 30 * 60 * 60 * 1000);
    expect(isInactiveEnough(inactiveFor30h, now, 'FRIEND', 1)).toBe(true); // 30h > 24h
    expect(isInactiveEnough(inactiveFor30h, now, 'FRIEND', 2)).toBe(false); // 30h < 48h
  });
});

describe('isCapExceeded', () => {
  it('should return true for STRANGER with any retention count (cap is 0)', () => {
    expect(isCapExceeded('STRANGER', 0)).toBe(true);
  });

  it('should return true for ACQUAINTANCE at cap (1 per 3 days)', () => {
    expect(isCapExceeded('ACQUAINTANCE', 1)).toBe(true);
  });

  it('should return false for ACQUAINTANCE under cap', () => {
    expect(isCapExceeded('ACQUAINTANCE', 0)).toBe(false);
  });

  it('should return true for FRIEND at cap (1 per day)', () => {
    expect(isCapExceeded('FRIEND', 1)).toBe(true);
  });

  it('should return false for FRIEND under cap', () => {
    expect(isCapExceeded('FRIEND', 0)).toBe(false);
  });

  it('should return true for CLOSE_FRIEND at cap (2 per day)', () => {
    expect(isCapExceeded('CLOSE_FRIEND', 2)).toBe(true);
  });

  it('should return false for CLOSE_FRIEND under cap', () => {
    expect(isCapExceeded('CLOSE_FRIEND', 0)).toBe(false);
    expect(isCapExceeded('CLOSE_FRIEND', 1)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// TEST GATE #8: Required Tests
// ─────────────────────────────────────────────────────────────

describe('checkEligibility', () => {
  /**
   * TEST #1: Quiet hours exclusion
   * User is eligible by all other rules but within quiet hours → excluded.
   */
  describe('TEST #1: Quiet hours exclusion', () => {
    it('should exclude user within quiet hours (00:00-08:00 local time)', () => {
      // 15:00 UTC = 00:00 Seoul (midnight = quiet hours)
      const now = new Date('2026-01-15T15:00:00Z');
      const input = createBaseInput({
        userTimezone: 'Asia/Seoul',
        // All other conditions pass
        proactiveMessagesEnabled: true,
        muteUntil: null,
        relationshipStage: 'FRIEND',
        recentRetentionCount: 0,
        lastInteractionAt: new Date('2026-01-10T00:00:00Z'), // 5+ days ago
      });

      const result = checkEligibility(input, now);

      expect(result.isEligible).toBe(false);
      expect(result.blockReason).toBe('quiet_hours');
    });

    it('should exclude user at 3AM local time (middle of quiet hours)', () => {
      // 18:00 UTC = 03:00 Seoul
      const now = new Date('2026-01-15T18:00:00Z');
      const input = createBaseInput({ userTimezone: 'Asia/Seoul' });

      const result = checkEligibility(input, now);

      expect(result.isEligible).toBe(false);
      expect(result.blockReason).toBe('quiet_hours');
    });

    it('should exclude user at 7AM local time (still quiet hours)', () => {
      // 22:00 UTC = 07:00 Seoul
      const now = new Date('2026-01-15T22:00:00Z');
      const input = createBaseInput({ userTimezone: 'Asia/Seoul' });

      const result = checkEligibility(input, now);

      expect(result.isEligible).toBe(false);
      expect(result.blockReason).toBe('quiet_hours');
    });
  });

  /**
   * TEST #2: Proactive disabled OR muted exclusion
   * Excluded regardless of other rules.
   */
  describe('TEST #2: Proactive disabled OR muted exclusion', () => {
    it('should exclude user when proactive_messages_enabled is false', () => {
      // 01:00 UTC = 10:00 Seoul (within attempt window)
      const now = new Date('2026-01-15T01:00:00Z');
      const input = createBaseInput({
        userTimezone: 'Asia/Seoul',
        proactiveMessagesEnabled: false,
        // All other conditions would pass
        relationshipStage: 'CLOSE_FRIEND',
        lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
      });

      const result = checkEligibility(input, now);

      expect(result.isEligible).toBe(false);
      expect(result.blockReason).toBe('proactive_disabled');
    });

    it('should exclude user when muted (mute_until > now)', () => {
      // 01:00 UTC = 10:00 Seoul (within attempt window)
      const now = new Date('2026-01-15T01:00:00Z');
      const muteUntil = new Date('2026-01-20T00:00:00Z'); // Muted until Jan 20

      const input = createBaseInput({
        userTimezone: 'Asia/Seoul',
        muteUntil,
        proactiveMessagesEnabled: true,
      });

      const result = checkEligibility(input, now);

      expect(result.isEligible).toBe(false);
      expect(result.blockReason).toBe('muted');
      expect(result.nextAllowedAt).toEqual(muteUntil);
    });

    it('should allow user when mute has expired (mute_until < now)', () => {
      // 01:00 UTC = 10:00 Seoul (within attempt window)
      const now = new Date('2026-01-15T01:00:00Z');
      const muteUntil = new Date('2026-01-10T00:00:00Z'); // Mute expired Jan 10

      const input = createBaseInput({
        userTimezone: 'Asia/Seoul',
        muteUntil,
        proactiveMessagesEnabled: true,
        lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
      });

      const result = checkEligibility(input, now);

      // Should not be blocked by mute (may be blocked by other reasons)
      expect(result.blockReason).not.toBe('muted');
    });
  });

  /**
   * TEST #3: Stage exclusion
   * Excluded based on relationship stage gating.
   */
  describe('TEST #3: Stage exclusion', () => {
    it('should exclude STRANGER stage (cap is 0/day)', () => {
      // 01:00 UTC = 10:00 Seoul (within attempt window)
      const now = new Date('2026-01-15T01:00:00Z');
      const input = createBaseInput({
        userTimezone: 'Asia/Seoul',
        relationshipStage: 'STRANGER',
        recentRetentionCount: 0,
      });

      const result = checkEligibility(input, now);

      expect(result.isEligible).toBe(false);
      expect(result.blockReason).toBe('stranger');
    });

    it('should allow ACQUAINTANCE stage when under cap', () => {
      // 01:00 UTC = 10:00 Seoul (within attempt window)
      const now = new Date('2026-01-15T01:00:00Z');
      const input = createBaseInput({
        userTimezone: 'Asia/Seoul',
        relationshipStage: 'ACQUAINTANCE',
        recentRetentionCount: 0,
        // Must be inactive for 48h for ACQUAINTANCE
        lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
      });

      const result = checkEligibility(input, now);

      expect(result.isEligible).toBe(true);
      expect(result.blockReason).toBeNull();
    });

    it('should exclude ACQUAINTANCE when cap exceeded (1 per 3 days)', () => {
      // 01:00 UTC = 10:00 Seoul (within attempt window)
      const now = new Date('2026-01-15T01:00:00Z');
      const input = createBaseInput({
        userTimezone: 'Asia/Seoul',
        relationshipStage: 'ACQUAINTANCE',
        recentRetentionCount: 1, // Already sent 1 in last 3 days
        lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
      });

      const result = checkEligibility(input, now);

      expect(result.isEligible).toBe(false);
      expect(result.blockReason).toBe('cap_exceeded');
    });

    it('should exclude when recently active (minimum inactivity not met)', () => {
      // 01:00 UTC = 10:00 Seoul (within attempt window)
      const now = new Date('2026-01-15T01:00:00Z');
      const input = createBaseInput({
        userTimezone: 'Asia/Seoul',
        relationshipStage: 'FRIEND',
        recentRetentionCount: 0,
        // FRIEND needs 24h inactivity, but user was active 12h ago
        lastInteractionAt: new Date('2026-01-14T13:00:00Z'),
      });

      const result = checkEligibility(input, now);

      expect(result.isEligible).toBe(false);
      expect(result.blockReason).toBe('recently_active');
    });
  });

  /**
   * TEST #4: Determinism test
   * Same DB state + same "now" time input → selected eligible set is identical.
   */
  describe('TEST #4: Determinism test', () => {
    it('should return identical results for identical inputs', () => {
      const now = new Date('2026-01-15T01:00:00Z'); // 10:00 Seoul
      const input = createBaseInput({
        userTimezone: 'Asia/Seoul',
        relationshipStage: 'FRIEND',
        lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
      });

      // Run the same check multiple times
      const result1 = checkEligibility(input, now);
      const result2 = checkEligibility(input, now);
      const result3 = checkEligibility(input, now);

      expect(result1).toEqual(result2);
      expect(result2).toEqual(result3);
    });

    it('should return consistent results across batch processing', () => {
      const now = new Date('2026-01-15T01:00:00Z'); // 10:00 Seoul

      const inputs: EligibilityInput[] = [
        createBaseInput({
          userId: 'user-001',
          userTimezone: 'Asia/Seoul',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
        }),
        createBaseInput({
          userId: 'user-002',
          userTimezone: 'Asia/Seoul',
          lastInteractionAt: new Date('2026-01-09T00:00:00Z'), // Older interaction
        }),
        createBaseInput({
          userId: 'user-003',
          userTimezone: 'Asia/Seoul',
          lastInteractionAt: new Date('2026-01-11T00:00:00Z'), // More recent interaction
        }),
      ];

      // Run batch multiple times
      const batch1 = checkEligibilityBatch(inputs, now);
      const batch2 = checkEligibilityBatch(inputs, now);
      const batch3 = checkEligibilityBatch(inputs, now);

      expect(batch1).toEqual(batch2);
      expect(batch2).toEqual(batch3);
    });

    it('should maintain deterministic order (sorted by lastInteractionAt then userId)', () => {
      const now = new Date('2026-01-15T01:00:00Z');

      // Inputs in random order
      const inputs: EligibilityInput[] = [
        createBaseInput({
          userId: 'user-003',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
        }),
        createBaseInput({
          userId: 'user-001',
          lastInteractionAt: new Date('2026-01-09T00:00:00Z'),
        }),
        createBaseInput({
          userId: 'user-002',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'), // Same time as user-003
        }),
      ];

      const results = checkEligibilityBatch(inputs, now);

      // Should be sorted: user-001 (earliest), user-002 (Jan 10, alphabetically first), user-003
      expect(results[0].userId).toBe('user-001'); // Jan 9 (earliest)
      expect(results[1].userId).toBe('user-002'); // Jan 10, "user-002" < "user-003"
      expect(results[2].userId).toBe('user-003'); // Jan 10, "user-003"
    });

    it('should produce identical eligible set for same DB state', () => {
      const now = new Date('2026-01-15T01:00:00Z');

      // Mix of eligible and ineligible users
      const inputs: EligibilityInput[] = [
        createBaseInput({
          userId: 'eligible-001',
          userTimezone: 'Asia/Seoul',
          relationshipStage: 'FRIEND',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
        }),
        createBaseInput({
          userId: 'ineligible-muted',
          userTimezone: 'Asia/Seoul',
          muteUntil: new Date('2026-01-20T00:00:00Z'),
        }),
        createBaseInput({
          userId: 'eligible-002',
          userTimezone: 'Asia/Seoul',
          relationshipStage: 'CLOSE_FRIEND',
          lastInteractionAt: new Date('2026-01-14T00:00:00Z'), // 13h inactive (enough for CLOSE_FRIEND)
        }),
        createBaseInput({
          userId: 'ineligible-stranger',
          userTimezone: 'Asia/Seoul',
          relationshipStage: 'STRANGER',
        }),
      ];

      // Run multiple times and verify eligible sets match
      const run1 = checkEligibilityBatch(inputs, now);
      const run2 = checkEligibilityBatch(inputs, now);

      const eligible1 = run1.filter((r) => r.isEligible).map((r) => r.userId).sort();
      const eligible2 = run2.filter((r) => r.isEligible).map((r) => r.userId).sort();

      expect(eligible1).toEqual(eligible2);
      expect(eligible1).toContain('eligible-001');
      expect(eligible1).toContain('eligible-002');
      expect(eligible1).not.toContain('ineligible-muted');
      expect(eligible1).not.toContain('ineligible-stranger');
    });
  });

  /**
   * Additional edge case tests
   */
  describe('Edge cases', () => {
    it('should exclude user outside attempt window (08:00-10:00 local)', () => {
      // 23:00 UTC = 08:00 Seoul (after quiet hours but before attempt window)
      const now = new Date('2026-01-15T23:00:00Z');
      const input = createBaseInput({
        userTimezone: 'Asia/Seoul',
        proactiveMessagesEnabled: true,
        relationshipStage: 'FRIEND',
      });

      const result = checkEligibility(input, now);

      expect(result.isEligible).toBe(false);
      expect(result.blockReason).toBe('outside_attempt_window');
    });

    it('should allow user at start of attempt window (10:00 local)', () => {
      // 01:00 UTC = 10:00 Seoul (start of attempt window)
      const now = new Date('2026-01-15T01:00:00Z');
      const input = createBaseInput({
        userTimezone: 'Asia/Seoul',
        lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
      });

      const result = checkEligibility(input, now);

      expect(result.isEligible).toBe(true);
    });

    it('should exclude user at end of attempt window (21:00 local)', () => {
      // 12:00 UTC = 21:00 Seoul (end of attempt window)
      const now = new Date('2026-01-15T12:00:00Z');
      const input = createBaseInput({
        userTimezone: 'Asia/Seoul',
      });

      const result = checkEligibility(input, now);

      expect(result.isEligible).toBe(false);
      expect(result.blockReason).toBe('outside_attempt_window');
    });

    it('should apply backoff multiplier to inactivity threshold', () => {
      // 01:00 UTC = 10:00 Seoul (within attempt window)
      const now = new Date('2026-01-15T01:00:00Z');

      // User with 30h inactivity, FRIEND stage (24h base threshold)
      const inactiveFor30h = new Date(now.getTime() - 30 * 60 * 60 * 1000);

      // Without backoff (multiplier = 1): 30h > 24h → eligible
      const input1 = createBaseInput({
        userTimezone: 'Asia/Seoul',
        lastInteractionAt: inactiveFor30h,
        backoffMultiplier: 1,
      });
      expect(checkEligibility(input1, now).isEligible).toBe(true);

      // With backoff (multiplier = 2): 30h < 48h → not eligible
      const input2 = createBaseInput({
        userTimezone: 'Asia/Seoul',
        lastInteractionAt: inactiveFor30h,
        backoffMultiplier: 2,
      });
      const result2 = checkEligibility(input2, now);
      expect(result2.isEligible).toBe(false);
      expect(result2.blockReason).toBe('recently_active');
    });
  });

  /**
   * TIMEZONE BOUNDARY VERIFICATION
   * Tests exact window boundaries with different IANA timezones to catch:
   * - Off-by-one-hour bugs
   * - DST issues
   * - Boundary condition errors
   */
  describe('Timezone Boundary Verification', () => {
    describe('Quiet Hours Boundaries (00:00-08:00)', () => {
      it('should block at exactly 00:00 local (start of quiet hours)', () => {
        // 15:00 UTC = 00:00 Seoul (midnight)
        const now = new Date('2026-01-15T15:00:00Z');
        const input = createBaseInput({
          userTimezone: 'Asia/Seoul',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
        });

        const result = checkEligibility(input, now);
        expect(result.isEligible).toBe(false);
        expect(result.blockReason).toBe('quiet_hours');
        expect(getLocalHour(now, 'Asia/Seoul')).toBe(0);
      });

      it('should allow at exactly 08:00 local (end of quiet hours)', () => {
        // 23:00 UTC = 08:00 Seoul
        const now = new Date('2026-01-15T23:00:00Z');
        const input = createBaseInput({
          userTimezone: 'Asia/Seoul',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
        });

        const result = checkEligibility(input, now);
        // 08:00 is outside quiet hours but before attempt window (10:00)
        expect(result.isEligible).toBe(false);
        expect(result.blockReason).toBe('outside_attempt_window');
        expect(getLocalHour(now, 'Asia/Seoul')).toBe(8);
      });

      it('should block at 07:59 local (still in quiet hours)', () => {
        // 22:59 UTC = 07:59 Seoul
        const now = new Date('2026-01-15T22:59:00Z');
        const input = createBaseInput({
          userTimezone: 'Asia/Seoul',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
        });

        const result = checkEligibility(input, now);
        expect(result.isEligible).toBe(false);
        expect(result.blockReason).toBe('quiet_hours');
      });
    });

    describe('Attempt Window Boundaries (10:00-21:00)', () => {
      it('should allow at exactly 10:00 local (start of attempt window)', () => {
        // 01:00 UTC = 10:00 Seoul
        const now = new Date('2026-01-15T01:00:00Z');
        const input = createBaseInput({
          userTimezone: 'Asia/Seoul',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
        });

        const result = checkEligibility(input, now);
        expect(result.isEligible).toBe(true);
        expect(getLocalHour(now, 'Asia/Seoul')).toBe(10);
      });

      it('should allow at exactly 20:59 local (within attempt window)', () => {
        // 11:59 UTC = 20:59 Seoul
        const now = new Date('2026-01-15T11:59:00Z');
        const input = createBaseInput({
          userTimezone: 'Asia/Seoul',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
        });

        const result = checkEligibility(input, now);
        expect(result.isEligible).toBe(true);
      });

      it('should block at exactly 21:00 local (end of attempt window)', () => {
        // 12:00 UTC = 21:00 Seoul
        const now = new Date('2026-01-15T12:00:00Z');
        const input = createBaseInput({
          userTimezone: 'Asia/Seoul',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
        });

        const result = checkEligibility(input, now);
        expect(result.isEligible).toBe(false);
        expect(result.blockReason).toBe('outside_attempt_window');
        expect(getLocalHour(now, 'Asia/Seoul')).toBe(21);
      });
    });

    describe('Different Timezones', () => {
      it('should correctly handle America/Los_Angeles timezone (UTC-8 in January)', () => {
        // 18:00 UTC = 10:00 PST (Los Angeles, UTC-8 in January)
        const now = new Date('2026-01-15T18:00:00Z');
        const input = createBaseInput({
          userTimezone: 'America/Los_Angeles',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
        });

        const result = checkEligibility(input, now);
        expect(result.isEligible).toBe(true);
        expect(getLocalHour(now, 'America/Los_Angeles')).toBe(10);
      });

      it('should correctly handle Europe/London timezone (UTC+0 in January)', () => {
        // 10:00 UTC = 10:00 GMT (London, UTC+0 in January)
        const now = new Date('2026-01-15T10:00:00Z');
        const input = createBaseInput({
          userTimezone: 'Europe/London',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
        });

        const result = checkEligibility(input, now);
        expect(result.isEligible).toBe(true);
        expect(getLocalHour(now, 'Europe/London')).toBe(10);
      });

      it('should correctly handle quiet hours in America/Los_Angeles', () => {
        // 08:00 UTC = 00:00 PST (midnight in Los Angeles)
        const now = new Date('2026-01-15T08:00:00Z');
        const input = createBaseInput({
          userTimezone: 'America/Los_Angeles',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
        });

        const result = checkEligibility(input, now);
        expect(result.isEligible).toBe(false);
        expect(result.blockReason).toBe('quiet_hours');
        expect(getLocalHour(now, 'America/Los_Angeles')).toBe(0);
      });

      it('should correctly handle attempt window in Europe/London', () => {
        // 21:00 UTC = 21:00 GMT (end of attempt window in London)
        const now = new Date('2026-01-15T21:00:00Z');
        const input = createBaseInput({
          userTimezone: 'Europe/London',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
        });

        const result = checkEligibility(input, now);
        expect(result.isEligible).toBe(false);
        expect(result.blockReason).toBe('outside_attempt_window');
        expect(getLocalHour(now, 'Europe/London')).toBe(21);
      });
    });

    describe('Boundary Transition Points', () => {
      it('should transition from quiet_hours to outside_attempt_window at 08:00', () => {
        // 22:59 UTC = 07:59 Seoul (quiet hours)
        const now1 = new Date('2026-01-15T22:59:00Z');
        const input = createBaseInput({
          userTimezone: 'Asia/Seoul',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
        });

        expect(checkEligibility(input, now1).blockReason).toBe('quiet_hours');

        // 23:00 UTC = 08:00 Seoul (outside attempt window)
        const now2 = new Date('2026-01-15T23:00:00Z');
        expect(checkEligibility(input, now2).blockReason).toBe('outside_attempt_window');
      });

      it('should transition from outside_attempt_window to eligible at 10:00', () => {
        // 00:59 UTC = 09:59 Seoul (outside attempt window)
        const now1 = new Date('2026-01-15T00:59:00Z');
        const input = createBaseInput({
          userTimezone: 'Asia/Seoul',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
        });

        expect(checkEligibility(input, now1).blockReason).toBe('outside_attempt_window');

        // 01:00 UTC = 10:00 Seoul (eligible)
        const now2 = new Date('2026-01-15T01:00:00Z');
        expect(checkEligibility(input, now2).isEligible).toBe(true);
      });

      it('should transition from eligible to outside_attempt_window at 21:00', () => {
        // 11:59 UTC = 20:59 Seoul (eligible)
        const now1 = new Date('2026-01-15T11:59:00Z');
        const input = createBaseInput({
          userTimezone: 'Asia/Seoul',
          lastInteractionAt: new Date('2026-01-10T00:00:00Z'),
        });

        expect(checkEligibility(input, now1).isEligible).toBe(true);

        // 12:00 UTC = 21:00 Seoul (outside attempt window)
        const now2 = new Date('2026-01-15T12:00:00Z');
        expect(checkEligibility(input, now2).blockReason).toBe('outside_attempt_window');
      });
    });
  });
});
