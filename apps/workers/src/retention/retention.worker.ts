/**
 * Retention Worker
 *
 * BullMQ processor that runs hourly (cron) per ARCHITECTURE.md A.2.3:
 * 1. Cron job runs hourly
 * 2. For each user in ACTIVE state:
 *    a. Check local time in [10:00, 21:00]
 *    b. Check proactive_messages_enabled=true, mute_until=null or passed
 *    c. Check stage-based caps (see §14.1)
 *    d. Check minimum inactivity (48h/24h/12h × backoff_multiplier)
 *    e. If all pass → enqueue retention turn
 *
 * Queue name: "retention" (per AI_PIPELINE.md line 9)
 */

import { Worker, Queue, Job } from 'bullmq';
import { PrismaClient, RelationshipStage, RetentionStatus, UserState } from '@prisma/client';
import {
  checkEligibilityBatch,
  EligibilityInput,
  EligibilityResult,
  STAGE_CAPS,
} from './eligibility-checker';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface RetentionTickJobData {
  /** Timestamp when the tick was scheduled (for determinism) */
  scheduledAt: string;
}

export interface RetentionAttemptJobData {
  userId: string;
  aiFriendId: string;
  conversationId: string;
  scheduledAt: string;
}

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

/** Queue names */
export const RETENTION_TICK_QUEUE = 'retention-tick';
export const RETENTION_ATTEMPT_QUEUE = 'retention-attempt';

// ─────────────────────────────────────────────────────────────
// Retention Service (Database Operations)
// ─────────────────────────────────────────────────────────────

export class RetentionService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Get all ACTIVE users with their eligibility data.
   * Query is deterministic: ordered by lastInteractionAt ASC, then userId ASC.
   */
  async getActiveUsersWithEligibilityData(now: Date): Promise<EligibilityInput[]> {
    // Query relationships with all required data for eligibility check
    const relationships = await this.prisma.relationship.findMany({
      where: {
        user: {
          state: UserState.ACTIVE,
        },
      },
      include: {
        user: {
          include: {
            controls: true,
            onboardingAnswers: true,
          },
        },
        aiFriend: {
          include: {
            retentionBackoff: {
              where: {
                // Get backoff for this specific user-aiFriend pair
              },
            },
          },
        },
      },
      orderBy: [
        { lastInteractionAt: 'asc' },
        { userId: 'asc' },
      ],
    });

    const result: EligibilityInput[] = [];

    for (const rel of relationships) {
      // Skip if no controls or onboarding answers
      if (!rel.user.controls || !rel.user.onboardingAnswers) continue;

      // Get backoff multiplier (default 1)
      const backoff = await this.prisma.retentionBackoff.findUnique({
        where: {
          userId_aiFriendId: {
            userId: rel.userId,
            aiFriendId: rel.aiFriendId,
          },
        },
      });

      // Get recent retention count for cap check
      const cap = STAGE_CAPS[rel.relationshipStage as RelationshipStage];
      const periodStart = new Date(now.getTime() - cap.periodDays * 24 * 60 * 60 * 1000);

      const recentRetentions = await this.prisma.retentionAttempt.count({
        where: {
          userId: rel.userId,
          aiFriendId: rel.aiFriendId,
          status: { in: [RetentionStatus.DELIVERED, RetentionStatus.ACKNOWLEDGED] },
          deliveredAt: { gte: periodStart },
        },
      });

      result.push({
        userId: rel.userId,
        aiFriendId: rel.aiFriendId,
        relationshipStage: rel.relationshipStage,
        lastInteractionAt: rel.lastInteractionAt,
        proactiveMessagesEnabled: rel.user.controls.proactiveMessagesEnabled,
        muteUntil: rel.user.controls.muteUntil,
        backoffMultiplier: backoff?.backoffMultiplier ?? 1,
        userTimezone: rel.user.onboardingAnswers.clientTimezone,
        recentRetentionCount: recentRetentions,
        oldestRecentRetentionAt: null, // Not needed for current logic
      });
    }

    return result;
  }

  /**
   * Get conversation ID for a user-aiFriend pair.
   */
  async getConversationId(userId: string, aiFriendId: string): Promise<string | null> {
    const conversation = await this.prisma.conversation.findUnique({
      where: {
        userId_aiFriendId: {
          userId,
          aiFriendId,
        },
      },
      select: { id: true },
    });
    return conversation?.id ?? null;
  }

  /**
   * Record a retention attempt.
   * MVP: Records attempt as SCHEDULED (stub behavior - no LLM message generation yet).
   *
   * [MVP STUB] For MVP, this records the attempt but does not generate an LLM message.
   * Full implementation will generate message content via the retention content selector.
   */
  async recordRetentionAttempt(
    userId: string,
    aiFriendId: string,
    skipReason: string | null = null
  ): Promise<string> {
    const attempt = await this.prisma.retentionAttempt.create({
      data: {
        userId,
        aiFriendId,
        status: skipReason ? RetentionStatus.SKIPPED : RetentionStatus.SCHEDULED,
        skipReason: skipReason ?? undefined,
      },
    });
    return attempt.id;
  }
}

// ─────────────────────────────────────────────────────────────
// Retention Worker Processor
// ─────────────────────────────────────────────────────────────

/**
 * Create the retention tick worker.
 *
 * Processes hourly tick jobs that:
 * 1. Query all ACTIVE users with eligibility data
 * 2. Check eligibility for each user (deterministic)
 * 3. For eligible users, record retention attempts
 *
 * [MVP STUB] Currently records attempts as SCHEDULED without generating LLM messages.
 */
export function createRetentionTickWorker(
  prisma: PrismaClient,
  redisConnection: { host: string; port: number }
): Worker<RetentionTickJobData> {
  const retentionService = new RetentionService(prisma);

  const worker = new Worker<RetentionTickJobData>(
    RETENTION_TICK_QUEUE,
    async (job: Job<RetentionTickJobData>) => {
      const scheduledAt = new Date(job.data.scheduledAt);
      const now = new Date();

      console.log(`[retention-tick] Processing tick scheduled at ${scheduledAt.toISOString()}`);

      // 1. Get all active users with eligibility data (deterministic query)
      const eligibilityInputs = await retentionService.getActiveUsersWithEligibilityData(now);

      console.log(`[retention-tick] Found ${eligibilityInputs.length} active users to check`);

      // 2. Check eligibility (deterministic batch processing)
      const results = checkEligibilityBatch(eligibilityInputs, now);

      // 3. Record attempts for eligible users
      const eligibleResults = results.filter((r) => r.isEligible);
      const skippedResults = results.filter((r) => !r.isEligible);

      console.log(`[retention-tick] Eligible: ${eligibleResults.length}, Skipped: ${skippedResults.length}`);

      // Record skipped attempts with reasons
      for (const result of skippedResults) {
        await retentionService.recordRetentionAttempt(
          result.userId,
          result.aiFriendId,
          result.blockReason
        );
      }

      // [MVP STUB] Record eligible attempts as SCHEDULED
      // Full implementation: generate LLM message, deliver push notification
      for (const result of eligibleResults) {
        const attemptId = await retentionService.recordRetentionAttempt(
          result.userId,
          result.aiFriendId,
          null
        );
        console.log(`[retention-tick] Created retention attempt ${attemptId} for user ${result.userId}`);
      }

      return {
        processed: eligibilityInputs.length,
        eligible: eligibleResults.length,
        skipped: skippedResults.length,
      };
    },
    {
      connection: redisConnection,
      concurrency: 1, // Single tick at a time for determinism
    }
  );

  worker.on('completed', (job, result) => {
    console.log(`[retention-tick] Job ${job.id} completed:`, result);
  });

  worker.on('failed', (job, err) => {
    console.error(`[retention-tick] Job ${job?.id} failed:`, err);
  });

  return worker;
}

/**
 * Create the retention tick queue with hourly cron schedule.
 */
export function createRetentionTickQueue(
  redisConnection: { host: string; port: number }
): Queue<RetentionTickJobData> {
  const queue = new Queue<RetentionTickJobData>(RETENTION_TICK_QUEUE, {
    connection: redisConnection,
  });

  return queue;
}

/**
 * Schedule the hourly retention tick job.
 *
 * Uses a stable repeat key to prevent duplicates on worker restarts.
 * BullMQ will automatically replace any existing repeatable job with the same key.
 */
export async function scheduleRetentionTick(queue: Queue<RetentionTickJobData>): Promise<void> {
  // Remove existing repeatable jobs (defensive cleanup)
  const existingJobs = await queue.getRepeatableJobs();
  const removedCount = existingJobs.length;
  for (const job of existingJobs) {
    await queue.removeRepeatableByKey(job.key);
  }
  if (removedCount > 0) {
    console.log(`[retention-tick] Removed ${removedCount} existing repeatable job(s)`);
  }

  // Add hourly cron job with stable repeat key
  // Using a stable key ensures BullMQ replaces any existing repeatable job
  const REPEAT_KEY = 'retention-tick-hourly';
  await queue.add(
    'retention-tick',
    { scheduledAt: new Date().toISOString() },
    {
      repeat: {
        pattern: '0 * * * *', // Every hour at minute 0
        key: REPEAT_KEY, // Stable key prevents duplicates
      },
      jobId: 'retention-tick-hourly', // Stable jobId for individual instances
    }
  );

  console.log(`[retention-tick] Scheduled hourly retention tick job (repeat key: ${REPEAT_KEY})`);
}
