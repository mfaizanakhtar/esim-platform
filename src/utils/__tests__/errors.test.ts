import { describe, it, expect } from 'vitest';
import { AppError, JobDataError, MappingError, VendorError, isRetryable } from '../errors';

// ---------------------------------------------------------------------------
// AppError — base class
// ---------------------------------------------------------------------------

describe('AppError', () => {
  it('sets message, code, and name', () => {
    const err = new AppError('something went wrong', 'TEST_CODE');
    expect(err.message).toBe('something went wrong');
    expect(err.code).toBe('TEST_CODE');
    expect(err.name).toBe('AppError');
  });

  it('is an instance of Error', () => {
    const err = new AppError('msg', 'CODE');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });

  it('has a stack trace', () => {
    const err = new AppError('msg', 'CODE');
    expect(err.stack).toBeDefined();
    expect(typeof err.stack).toBe('string');
  });

  it('preserves code as readonly', () => {
    const err = new AppError('msg', 'MY_CODE');
    expect(err.code).toBe('MY_CODE');
  });
});

// ---------------------------------------------------------------------------
// JobDataError
// ---------------------------------------------------------------------------

describe('JobDataError', () => {
  it('sets code to JOB_DATA_ERROR', () => {
    const err = new JobDataError('bad payload');
    expect(err.code).toBe('JOB_DATA_ERROR');
  });

  it('sets message and name', () => {
    const err = new JobDataError('missing deliveryId');
    expect(err.message).toBe('missing deliveryId');
    expect(err.name).toBe('JobDataError');
  });

  it('is instanceof AppError and Error', () => {
    const err = new JobDataError('x');
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// MappingError
// ---------------------------------------------------------------------------

describe('MappingError', () => {
  it('sets code to MAPPING_ERROR', () => {
    const err = new MappingError('SKU not found');
    expect(err.code).toBe('MAPPING_ERROR');
  });

  it('sets message and name', () => {
    const err = new MappingError('inactive mapping');
    expect(err.message).toBe('inactive mapping');
    expect(err.name).toBe('MappingError');
  });

  it('is instanceof AppError and Error', () => {
    const err = new MappingError('x');
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// VendorError
// ---------------------------------------------------------------------------

describe('VendorError', () => {
  it('sets code to VENDOR_ERROR', () => {
    const err = new VendorError('API timeout');
    expect(err.code).toBe('VENDOR_ERROR');
  });

  it('sets message and name', () => {
    const err = new VendorError('FiRoam returned 500');
    expect(err.message).toBe('FiRoam returned 500');
    expect(err.name).toBe('VendorError');
  });

  it('is instanceof AppError and Error', () => {
    const err = new VendorError('x');
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// isRetryable
// ---------------------------------------------------------------------------

describe('isRetryable', () => {
  it('returns true for VendorError', () => {
    expect(isRetryable(new VendorError('api down'))).toBe(true);
  });

  it('returns false for JobDataError', () => {
    expect(isRetryable(new JobDataError('bad data'))).toBe(false);
  });

  it('returns false for MappingError', () => {
    expect(isRetryable(new MappingError('missing sku'))).toBe(false);
  });

  it('returns false for AppError base class', () => {
    expect(isRetryable(new AppError('oops', 'SOME_CODE'))).toBe(false);
  });

  it('returns false for a plain Error', () => {
    expect(isRetryable(new Error('unexpected'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRetryable(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isRetryable(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isRetryable('error string')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isRetryable(42)).toBe(false);
  });

  it('returns false for a plain object', () => {
    expect(isRetryable({ message: 'looks like an error' })).toBe(false);
  });
});
