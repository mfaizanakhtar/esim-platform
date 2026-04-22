// Shared types, constants, and utilities for eSIM order status extension components

import { useState, useEffect, useRef } from 'react';

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
 * Extract numeric ID from a Shopify GID like "gid://shopify/Order/123"
 */
export function extractNumericId(gid: string | undefined): string {
  if (!gid) return '';
  return gid.split('/').pop() ?? '';
}

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

interface OrderDeliveryResponse {
  deliveries: Array<{
    lineItemId: string;
    status: string;
    accessToken?: string;
  }>;
}

/**
 * Polls /esim/order-deliveries/:orderId and enriches delivered entries
 * with full credentials from /esim/delivery/:token.
 *
 * Returns Record<lineItemId, DeliveryMetafieldEntry> — same shape the
 * extension components already expect.
 */
export function useOrderDeliveries(orderId: string): Record<string, DeliveryMetafieldEntry> {
  const [deliveryMap, setDeliveryMap] = useState<Record<string, DeliveryMetafieldEntry>>({});
  const fetchedTokens = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!orderId) return;
    let stopped = false;
    let attempts = 0;

    const fetchCredentials = (accessToken: string, lineItemId: string) => {
      if (stopped || fetchedTokens.current.has(accessToken)) return;
      fetchedTokens.current.add(accessToken);

      void fetch(`${BACKEND_URL}/esim/delivery/${accessToken}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: DeliveryMetafieldEntry | null) => {
          if (stopped || !data) return;
          setDeliveryMap((prev) => ({
            ...prev,
            [lineItemId]: { ...prev[lineItemId], ...data, accessToken },
          }));
        })
        .catch(() => {
          // Allow retry on next poll cycle
          fetchedTokens.current.delete(accessToken);
        });
    };

    const poll = () => {
      if (stopped || ++attempts > 120) return;

      void fetch(`${BACKEND_URL}/esim/order-deliveries/${orderId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: OrderDeliveryResponse | null) => {
          if (stopped || !data?.deliveries) return;

          const newMap: Record<string, DeliveryMetafieldEntry> = {};
          let allTerminal = true;

          for (const d of data.deliveries) {
            const existing = deliveryMap[d.lineItemId];
            newMap[d.lineItemId] = {
              ...(existing || {}),
              status: d.status as DeliveryMetafieldEntry['status'],
              ...(d.accessToken ? { accessToken: d.accessToken } : {}),
            };

            if (d.status === 'delivered' && d.accessToken) {
              fetchCredentials(d.accessToken, d.lineItemId);
              // Not terminal until credentials are loaded
              if (!existing?.lpa) allTerminal = false;
            } else if (d.status !== 'failed' && d.status !== 'cancelled') {
              allTerminal = false;
            }
          }

          setDeliveryMap((prev) => {
            // Merge to preserve credentials already fetched
            const merged = { ...prev };
            for (const [k, v] of Object.entries(newMap)) {
              merged[k] = { ...(merged[k] || {}), ...v };
            }
            return merged;
          });

          if (!allTerminal) {
            setTimeout(poll, 5000);
          }
        })
        .catch(() => {
          if (!stopped) setTimeout(poll, 5000);
        });
    };

    poll();
    return () => {
      stopped = true;
    };
  }, [orderId]);

  return deliveryMap;
}
