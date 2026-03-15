export type TgtFulfillmentMode = 'polling' | 'callback' | 'hybrid';

export function getTgtFulfillmentMode(): TgtFulfillmentMode {
  const mode = (process.env.TGT_FULFILLMENT_MODE || 'hybrid').toLowerCase();
  if (mode === 'polling' || mode === 'callback' || mode === 'hybrid') {
    return mode;
  }
  return 'hybrid';
}

export function getTgtPollIntervalSeconds(): number {
  const value = Number(process.env.TGT_POLL_INTERVAL_SECONDS || 15);
  if (!Number.isFinite(value) || value < 1) return 15;
  return Math.floor(value);
}

export function getTgtPollMaxAttempts(): number {
  const value = Number(process.env.TGT_POLL_MAX_ATTEMPTS || 8);
  if (!Number.isFinite(value) || value < 1) return 8;
  return Math.floor(value);
}

export function getTgtCallbackSecret(): string {
  return process.env.TGT_CALLBACK_SECRET || process.env.TGT_SECRET || '';
}
