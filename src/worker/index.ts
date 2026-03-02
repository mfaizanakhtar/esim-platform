import 'dotenv/config';
import { initializeJobQueue, stopJobQueue } from '../queue/jobQueue';
import { handleProvision } from './jobs/provisionEsim';
import { logger } from '../utils/logger';
import { isRetryable } from '../utils/errors';

async function run() {
  logger.info('Starting worker process');

  const boss = await initializeJobQueue();

  // Register worker for provision-esim jobs
  await boss.work('provision-esim', { teamSize: 5, teamConcurrency: 2 }, async (job: unknown) => {
    const j = job as Record<string, unknown>;
    const jobId = j.id ? String(j.id) : 'unknown';
    const jobData = (j.data as Record<string, unknown>) || {};
    const requestId = jobData.requestId ? String(jobData.requestId) : undefined;

    logger.info({ jobId, requestId }, 'Processing job');

    try {
      await handleProvision(jobData as unknown as Parameters<typeof handleProvision>[0]);
      logger.info({ jobId, requestId }, 'Job completed successfully');
    } catch (err) {
      logger.error({ jobId, requestId, err }, 'Job failed');
      if (isRetryable(err)) {
        // VendorError — rethrow so pg-boss retries (vendor may recover)
        throw err;
      }
      // JobDataError / MappingError — config won't self-heal, skip retries
      logger.warn({ jobId, requestId }, 'Non-retryable error — skipping pg-boss retries');
    }
  });

  // Log jobs that have exhausted all retries (ended up in failed state)
  await boss.onComplete('provision-esim', async (job: unknown) => {
    const j = job as Record<string, unknown>;
    const state = j.state as string | undefined;
    if (state === 'failed') {
      const data = (j.data as Record<string, unknown>) || {};
      const request = (data.request as Record<string, unknown>) || {};
      const deliveryId = request.deliveryId ? String(request.deliveryId) : 'unknown';
      logger.error({ deliveryId, jobId: j.id }, 'Job permanently failed after all retries');
    }
  });

  logger.info('Worker registered and ready to process jobs');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down worker (SIGINT)');
    await stopJobQueue();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down worker (SIGTERM)');
    await stopJobQueue();
    process.exit(0);
  });
}

run().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
