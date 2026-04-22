// Shared types, constants, and utilities for eSIM order status extension components

export const BACKEND_URL = 'https://api.sailesim.com';

export interface DeliveryMetafieldEntry {
  status: 'provisioning' | 'delivered' | 'cancelled' | 'failed';
  accessToken?: string;
  lpa?: string;
  activationCode?: string;
  iccid?: string;
  usageUrl?: string;
  isTopup?: boolean;
}

export const PROVISIONING_QUIPS = [
  'Beep boop... waking up your SIM...',
  'Negotiating with cell towers worldwide...',
  'Teaching tiny electrons to carry your data...',
  "Convincing satellites you're a VIP...",
  'Pinging networks in 47 countries...',
  'Bribing the signal gods...',
  'Almost there — pinky promise...',
  'Spinning up the hamster wheels...',
  'Your eSIM is putting on its shoes...',
  'Whispering to antennas around the globe...',
];

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
