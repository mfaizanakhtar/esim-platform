/**
 * Domain error base class.
 * All app-specific errors extend this so they can be distinguished from
 * unexpected third-party errors via `instanceof AppError`.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = this.constructor.name;
    // Maintain proper V8 stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Job data is malformed or missing required fields.
 * NOT retryable — the data payload won't change between attempts.
 */
export class JobDataError extends AppError {
  constructor(message: string) {
    super(message, 'JOB_DATA_ERROR');
  }
}

/**
 * SKU mapping configuration problem: missing mapping, inactive SKU,
 * bad providerSku format, missing vendor credentials, etc.
 * NOT retryable — requires a human to fix the database / config.
 */
export class MappingError extends AppError {
  constructor(message: string) {
    super(message, 'MAPPING_ERROR');
  }
}

/**
 * Vendor API call failed: network error, auth failure, unexpected response.
 * RETRYABLE — the vendor may recover on subsequent attempts.
 */
export class VendorError extends AppError {
  constructor(message: string) {
    super(message, 'VENDOR_ERROR');
  }
}

/**
 * Returns true if the error should trigger a pg-boss retry.
 * Only VendorErrors are retryable; config/data errors are not.
 */
export function isRetryable(err: unknown): boolean {
  return err instanceof VendorError;
}
