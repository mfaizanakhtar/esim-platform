export function makeIdempotencyKey(orderId: string, lineItemId: string): string {
  return `${orderId}::${lineItemId}`;
}
