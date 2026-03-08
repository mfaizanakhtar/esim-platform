import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getTgtCallbackSecret,
  getTgtFulfillmentMode,
  getTgtPollIntervalSeconds,
  getTgtPollMaxAttempts,
  isTgtEnabled,
} from '~/vendor/tgtConfig';

describe('tgtConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('parses mode with fallback', () => {
    vi.stubEnv('TGT_FULFILLMENT_MODE', 'callback');
    expect(getTgtFulfillmentMode()).toBe('callback');

    vi.stubEnv('TGT_FULFILLMENT_MODE', 'invalid');
    expect(getTgtFulfillmentMode()).toBe('hybrid');
  });

  it('parses polling intervals and attempts with defaults', () => {
    vi.stubEnv('TGT_POLL_INTERVAL_SECONDS', '20');
    vi.stubEnv('TGT_POLL_MAX_ATTEMPTS', '5');

    expect(getTgtPollIntervalSeconds()).toBe(20);
    expect(getTgtPollMaxAttempts()).toBe(5);

    vi.stubEnv('TGT_POLL_INTERVAL_SECONDS', '0');
    vi.stubEnv('TGT_POLL_MAX_ATTEMPTS', '-1');

    expect(getTgtPollIntervalSeconds()).toBe(15);
    expect(getTgtPollMaxAttempts()).toBe(8);
  });

  it('reads enable flag and callback secret fallback', () => {
    vi.stubEnv('TGT_ENABLED', 'true');
    expect(isTgtEnabled()).toBe(true);

    vi.stubEnv('TGT_CALLBACK_SECRET', 'cb-secret');
    vi.stubEnv('TGT_SECRET', 'tgt-secret');
    expect(getTgtCallbackSecret()).toBe('cb-secret');

    vi.stubEnv('TGT_CALLBACK_SECRET', '');
    expect(getTgtCallbackSecret()).toBe('tgt-secret');
  });
});
