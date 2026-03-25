// Shared types and constants for eSIM order status extension components

export interface DeliveryMetafieldEntry {
  status: 'provisioning' | 'delivered' | 'cancelled' | 'failed';
  accessToken?: string;
  lpa?: string;
  activationCode?: string;
  iccid?: string;
  usageUrl?: string;
  isTopup?: boolean;
}

export const BACKEND = 'https://esim-api-production-a56a.up.railway.app';

/**
 * Parse the esim.delivery_tokens metafield JSON into a map of
 * lineItemId → DeliveryMetafieldEntry. Returns an empty object on
 * missing or malformed values.
 */
export function parseTokenMap(raw: string | undefined): Record<string, DeliveryMetafieldEntry> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, DeliveryMetafieldEntry>;
  } catch {
    return {};
  }
}
