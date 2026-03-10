import crypto from 'crypto';

/**
 * Verify Shopify webhook HMAC signature
 * @param body - Raw request body as string
 * @param hmacHeader - HMAC header from request (X-Shopify-Hmac-Sha256)
 * @param secret - Webhook secret from Shopify
 * @returns true if signature is valid
 */
export function verifyShopifyWebhook(body: string, hmacHeader: string, secret: string): boolean {
  const hash = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
  return hash === hmacHeader;
}

/**
 * Generate idempotency key for webhook
 */
export function generateIdempotencyKey(orderId: string, lineItemId: string): string {
  return `${orderId}:${lineItemId}`;
}
