import 'dotenv/config';
import buildServer from './server';
import { initializeJobQueue, stopJobQueue } from './queue/jobQueue';
import { logger } from './utils/logger';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

async function main() {
  // Initialize job queue for API process
  await initializeJobQueue();
  logger.info('Job queue initialized');

  const server = await buildServer();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down (SIGINT)');
    await server.close();
    await stopJobQueue();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down (SIGTERM)');
    await server.close();
    await stopJobQueue();
    process.exit(0);
  });

  try {
    await server.listen({ port: PORT, host: '0.0.0.0' });
    logger.info({ port: PORT }, 'Server listening');
  } catch (err) {
    server.log.error(err);
    await stopJobQueue();
    process.exit(1);
  }
}

main();
