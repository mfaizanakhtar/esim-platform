import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifyShopifyWebhook, generateIdempotencyKey } from '~/shopify/webhooks';

describe('verifyShopifyWebhook', () => {
  it('returns true for a valid HMAC signature', () => {
    const secret = 'my-webhook-secret';
    const body = JSON.stringify({ id: 12345, email: 'customer@example.com' });
    const hmac = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');

    expect(verifyShopifyWebhook(body, hmac, secret)).toBe(true);
  });

  it('returns false for an invalid HMAC signature', () => {
    expect(verifyShopifyWebhook('{"id":123}', 'invalid-hmac-value', 'my-secret')).toBe(false);
  });

  it('returns false when body is tampered after signing', () => {
    const secret = 'tamper-test-secret';
    const original = '{"id":1}';
    const hmac = crypto.createHmac('sha256', secret).update(original, 'utf8').digest('base64');

    expect(verifyShopifyWebhook('{"id":2}', hmac, secret)).toBe(false);
  });
});

describe('generateIdempotencyKey', () => {
  it('returns orderId:lineItemId format', () => {
    expect(generateIdempotencyKey('order-1', 'item-1')).toBe('order-1:item-1');
  });

  it('produces different keys for different inputs', () => {
    const key1 = generateIdempotencyKey('order-1', 'item-1');
    const key2 = generateIdempotencyKey('order-1', 'item-2');
    const key3 = generateIdempotencyKey('order-2', 'item-1');

    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
  });

  it('handles numeric-looking IDs correctly', () => {
    expect(generateIdempotencyKey('1001', '111')).toBe('1001:111');
  });
});
