/**
 * Creates a unique idempotency key for an eSIM order by combining
 * the Shopify order ID and line item ID.
 *
 * Used to prevent duplicate eSIM provisioning when Shopify retries webhooks.
 */
export function makeIdempotencyKey(orderId: string, lineItemId: string): string {
  return `${orderId}::${lineItemId}`;
}
