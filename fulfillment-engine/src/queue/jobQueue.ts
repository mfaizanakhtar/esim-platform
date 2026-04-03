import PgBoss from 'pg-boss';
import { logger } from '~/utils/logger';

let jobQueue: PgBoss | null = null;

/**
 * Initialize and get pg-boss job queue instance
 */
export async function initializeJobQueue(): Promise<PgBoss> {
  if (!jobQueue) {
    const connectionString = process.env.DATABASE_URL!;

    if (!connectionString) {
      throw new Error('DATABASE_URL not set');
    }

    jobQueue = new PgBoss({ connectionString, max: 3 });
    await jobQueue.start();
    logger.info('pg-boss started');
  }

  return jobQueue;
}

/**
 * Get existing job queue instance (must call initializeJobQueue first)
 */
export function getJobQueue(): PgBoss {
  if (!jobQueue) {
    throw new Error('Job queue not initialized. Call initializeJobQueue() first.');
  }
  return jobQueue;
}

/**
 * Gracefully stop job queue
 */
export async function stopJobQueue(): Promise<void> {
  if (jobQueue) {
    await jobQueue.stop();
    jobQueue = null;
    logger.info('pg-boss stopped');
  }
}
