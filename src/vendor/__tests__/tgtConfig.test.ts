import { describe, it, expect } from 'vitest';
import {
  getTgtCallbackSecret,
  getTgtFulfillmentMode,
  getTgtPollIntervalSeconds,
  getTgtPollMaxAttempts,
  isTgtEnabled,
} from '~/vendor/tgtConfig';

describe('tgtConfig', () => {
  it('parses mode with fallback', () => {
    process.env.TGT_FULFILLMENT_MODE = 'callback';
    expect(getTgtFulfillmentMode()).toBe('callback');

    process.env.TGT_FULFILLMENT_MODE = 'invalid';
    expect(getTgtFulfillmentMode()).toBe('hybrid');
  });

  it('parses polling intervals and attempts with defaults', () => {
    process.env.TGT_POLL_INTERVAL_SECONDS = '20';
    process.env.TGT_POLL_MAX_ATTEMPTS = '5';

    expect(getTgtPollIntervalSeconds()).toBe(20);
    expect(getTgtPollMaxAttempts()).toBe(5);

    process.env.TGT_POLL_INTERVAL_SECONDS = '0';
    process.env.TGT_POLL_MAX_ATTEMPTS = '-1';

    expect(getTgtPollIntervalSeconds()).toBe(15);
    expect(getTgtPollMaxAttempts()).toBe(8);
  });

  it('reads enable flag and callback secret fallback', () => {
    process.env.TGT_ENABLED = 'true';
    expect(isTgtEnabled()).toBe(true);

    process.env.TGT_CALLBACK_SECRET = 'cb-secret';
    process.env.TGT_SECRET = 'tgt-secret';
    expect(getTgtCallbackSecret()).toBe('cb-secret');

    delete process.env.TGT_CALLBACK_SECRET;
    expect(getTgtCallbackSecret()).toBe('tgt-secret');
  });
});
