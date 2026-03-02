import pino from 'pino';

/**
 * Shared pino logger instance.
 *
 * Used by worker processes, services, and vendor clients.
 * The API layer (Fastify) has its own built-in pino logger accessed
 * via `request.log` / `fastify.log` — this singleton is for everything else.
 *
 * LOG_LEVEL env var controls verbosity (default: 'info').
 * pino-pretty is used in local dev when the package is installed.
 * In production the transport is omitted (plain JSON output).
 */
function buildTransport(): pino.TransportSingleOptions | undefined {
  // Never use pino-pretty in production
  if (process.env.NODE_ENV === 'production') return undefined;

  // In dev/test, use pino-pretty only if it is actually installed.
  // It is a devDependency and will not be present in the production Docker image.
  try {
    require.resolve('pino-pretty');
    return { target: 'pino-pretty', options: { colorize: true } };
  } catch {
    return undefined;
  }
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: buildTransport(),
});
