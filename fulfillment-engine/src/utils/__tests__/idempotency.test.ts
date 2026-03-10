import { describe, it, expect } from 'vitest';
import { makeIdempotencyKey } from '~/utils/idempotency';

describe('makeIdempotencyKey', () => {
  it('joins orderId and lineItemId with a double colon', () => {
    expect(makeIdempotencyKey('order-1', 'item-1')).toBe('order-1::item-1');
  });

  it('handles empty strings', () => {
    expect(makeIdempotencyKey('', '')).toBe('::');
  });

  it('handles numeric-looking IDs', () => {
    expect(makeIdempotencyKey('1001', '111')).toBe('1001::111');
  });

  it('preserves special characters in IDs', () => {
    expect(makeIdempotencyKey('order/123', 'item-456')).toBe('order/123::item-456');
  });

  it('produces unique keys for different lineItemIds', () => {
    const key1 = makeIdempotencyKey('order-1', 'item-1');
    const key2 = makeIdempotencyKey('order-1', 'item-2');
    expect(key1).not.toBe(key2);
  });
});
