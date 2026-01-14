/**
 * Workers Entry Point
 *
 * Starts BullMQ workers for background job processing:
 * - retention-tick: Hourly retention eligibility check (per ARCHITECTURE.md A.2.3)
 *
 * Per VERSIONS.md: BullMQ v5.x, Redis v7.x
 */

import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables from root .env
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { PrismaClient } from '@prisma/client';
import {
  createRetentionTickWorker,
  createRetentionTickQueue,
  scheduleRetentionTick,
} from './retention/retention.worker';

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT ?? '6379', 10);

const redisConnection = {
  host: REDIS_HOST,
  port: REDIS_PORT,
};

// ─────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[workers] Starting workers...');
  console.log(`[workers] Redis connection: ${REDIS_HOST}:${REDIS_PORT}`);

  // Initialize Prisma client
  const prisma = new PrismaClient();

  try {
    // Test database connection
    await prisma.$connect();
    console.log('[workers] Database connected');

    // Create and start retention tick worker
    const retentionWorker = createRetentionTickWorker(prisma, redisConnection);
    console.log('[workers] Retention tick worker started');

    // Create queue and schedule hourly tick
    const retentionQueue = createRetentionTickQueue(redisConnection);
    await scheduleRetentionTick(retentionQueue);

    // Graceful shutdown handling
    const shutdown = async (signal: string): Promise<void> => {
      console.log(`[workers] Received ${signal}, shutting down...`);

      await retentionWorker.close();
      await retentionQueue.close();
      await prisma.$disconnect();

      console.log('[workers] Shutdown complete');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    console.log('[workers] All workers running. Press Ctrl+C to stop.');
  } catch (error) {
    console.error('[workers] Failed to start workers:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();
