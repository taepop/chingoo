/**
 * Manual Verification Script for Cron Duplication Prevention
 *
 * Run this script to verify that only one repeatable job exists:
 *   pnpm --filter workers ts-node src/verify-cron.ts
 *
 * Expected output:
 * - First run: "Found 1 repeatable job(s)" (or 0 if first time)
 * - After worker restarts: Should still show 1, not multiple
 */

import * as path from 'path';
import * as dotenv from 'dotenv';
import { Queue } from 'bullmq';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT ?? '6379', 10);

const RETENTION_TICK_QUEUE = 'retention-tick';

async function verifyCronJobs(): Promise<void> {
  const queue = new Queue(RETENTION_TICK_QUEUE, {
    connection: {
      host: REDIS_HOST,
      port: REDIS_PORT,
    },
  });

  try {
    const repeatableJobs = await queue.getRepeatableJobs();
    console.log(`\n[verify-cron] Found ${repeatableJobs.length} repeatable job(s) in queue "${RETENTION_TICK_QUEUE}":\n`);

    if (repeatableJobs.length === 0) {
      console.log('  No repeatable jobs found. Worker may not have started yet.');
    } else if (repeatableJobs.length === 1) {
      console.log('  ✅ CORRECT: Exactly one repeatable job (no duplicates)');
      console.log(`  - Key: ${repeatableJobs[0].key}`);
      console.log(`  - Pattern: ${repeatableJobs[0].pattern}`);
      console.log(`  - Next run: ${repeatableJobs[0].next}`);
    } else {
      console.log(`  ❌ ERROR: Found ${repeatableJobs.length} repeatable jobs (duplicates detected!)`);
      repeatableJobs.forEach((job, idx) => {
        console.log(`  Job ${idx + 1}:`);
        console.log(`    - Key: ${job.key}`);
        console.log(`    - Pattern: ${job.pattern}`);
        console.log(`    - Next run: ${job.next}`);
      });
      console.log('\n  Action: Restart the worker to clean up duplicates.');
    }
  } catch (error) {
    console.error('[verify-cron] Error:', error);
    process.exit(1);
  } finally {
    await queue.close();
  }
}

verifyCronJobs();
