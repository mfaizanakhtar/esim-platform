// Shared types, constants, and utilities for eSIM order status extension components

import { useState, useEffect } from 'react';

export const BACKEND_URL = 'https://api.sailesim.com';

const CUSTOMER_API_VERSION = '2025-07';
const CUSTOMER_API_URL = `shopify://customer-account/api/${CUSTOMER_API_VERSION}/graphql.json`;

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
 * Extract numeric ID from a Shopify GID like "gid://shopify/Order/123"
 */
export function extractNumericId(gid: string | undefined): string {
  if (!gid) return '';
  return gid.split('/').pop() ?? '';
}

/**
 * Parse the esim.delivery_tokens metafield JSON into a map of
 * lineItemId → DeliveryMetafieldEntry.
 */
export function parseTokenMap(raw: string | undefined): Record<string, DeliveryMetafieldEntry> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, DeliveryMetafieldEntry>;
  } catch {
    return {};
  }
}

/**
 * Query the order's esim.delivery_tokens metafield via the Customer Account API.
 * This reads ORDER metafields (written post-checkout by finalizeDelivery),
 * unlike useMetafields() which only reads checkout-scoped metafields.
 */
/**
 * Query the order's esim.delivery_tokens metafield via the Customer Account API.
 * This reads ORDER metafields (written post-checkout by finalizeDelivery),
 * unlike useMetafields() which only reads checkout-scoped metafields.
 */
export function useOrderMetafield(orderGid: string | undefined): Record<string, DeliveryMetafieldEntry> {
  const [tokenMap, setTokenMap] = useState<Record<string, DeliveryMetafieldEntry>>({});

  useEffect(() => {
    if (!orderGid) return;
    let cancelled = false;

    void fetch(CUSTOMER_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query OrderEsimMetafield($orderId: ID!) {
          order(id: $orderId) {
            metafield(namespace: "esim", key: "delivery_tokens") {
              value
            }
          }
        }`,
        variables: { orderId: orderGid },
      }),
    })
      .then((r) => r.json())
      .then((result: { data?: { order?: { metafield?: { value: string } } } }) => {
        if (cancelled) return;
        const raw = result.data?.order?.metafield?.value;
        setTokenMap(parseTokenMap(raw));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [orderGid]);

  return tokenMap;
}
