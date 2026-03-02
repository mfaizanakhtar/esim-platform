import pino from 'pino';

/**
 * Shared pino logger instance.
 *
 * Used by worker processes, services, and vendor clients.
 * The API layer (Fastify) has its own built-in pino logger accessed
 * via `request.log` / `fastify.log` — this singleton is for everything else.
 *
 * LOG_LEVEL env var controls verbosity (default: 'info').
 * pino-pretty is used automatically outside production for readable output.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
