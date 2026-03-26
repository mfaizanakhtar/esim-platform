import {
  reactExtension,
  useApi,
  useSubscription,
  InlineStack,
  Text,
  Button,
  Spinner,
} from '@shopify/ui-extensions-react/checkout';
import { useState, useEffect } from 'react';
import { PROVISIONING_QUIPS, BACKEND } from './shared';

// ---------------------------------------------------------------------------
// Extension entry point — compact announcement bar at the top of the
// thank-you page.
//
// useAppMetafields is not reactive in the checkout surface — it's a snapshot
// at render time (before the webhook fires and writes the metafield).
// Instead we poll GET /esim/order-status/:orderId every 5s to track status.
// No credentials are returned — full eSIM details live in the authenticated
// customer-account order-status page.
// ---------------------------------------------------------------------------

export default reactExtension(
  'purchase.thank-you.announcement.render',
  () => <ThankYouAnnouncementBlock />,
);

type EsimStatus = 'pending' | 'provisioning' | 'delivered' | 'failed' | 'cancelled' | null;

function ThankYouAnnouncementBlock() {
  // Get the confirmed order ID from the order confirmation API
  const api = useApi<'purchase.thank-you.announcement.render'>();
  const orderConfirmation = useSubscription(
    (api as unknown as { orderConfirmation: Parameters<typeof useSubscription>[0] }).orderConfirmation,
  ) as { order?: { id?: string } } | null;
  const numericOrderId = orderConfirmation?.order?.id?.split('/').pop() ?? '';

  const [status, setStatus] = useState<EsimStatus>(null);
  const [quipIndex, setQuipIndex] = useState(0);

  // ── Poll /esim/order-status/:orderId ─────────────────────────────────────
  useEffect(() => {
    if (!numericOrderId) return;
    let attempts = 0;
    let stopped = false;

    const poll = () => {
      if (stopped || ++attempts > 120) return;
      void fetch(`${BACKEND}/esim/order-status/${numericOrderId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { status: EsimStatus } | null) => {
          if (!data || stopped) return;
          setStatus(data.status);
          if (['delivered', 'failed', 'cancelled'].includes(data.status ?? '')) {
            stopped = true;
            return;
          }
          setTimeout(poll, 5000);
        })
        .catch(() => {
          if (!stopped) setTimeout(poll, 5000);
        });
    };

    // Wait 2s before first poll to give webhook time to fire and write to DB
    const initial = setTimeout(poll, 2000);
    return () => {
      stopped = true;
      clearTimeout(initial);
    };
  }, [numericOrderId]);

  // ── Quip rotation ─────────────────────────────────────────────────────────
  const isProvisioning = status === 'provisioning' || status === 'pending';
  useEffect(() => {
    if (!isProvisioning) return;
    const interval = setInterval(() => {
      setQuipIndex((prev) => (prev + 1) % PROVISIONING_QUIPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [isProvisioning]);

  // Nothing to show until we get a status from the backend
  if (!status || status === 'failed' || status === 'cancelled') return null;

  // ── Provisioning — compact single row ─────────────────────────────────────
  if (isProvisioning) {
    return (
      <InlineStack spacing="base" blockAlignment="center">
        <Spinner size="small" />
        <Text>{PROVISIONING_QUIPS[quipIndex]}</Text>
      </InlineStack>
    );
  }

  // ── Delivered ─────────────────────────────────────────────────────────────
  if (status === 'delivered') {
    return (
      <InlineStack spacing="base" blockAlignment="center">
        <Text emphasis="bold">Your eSIM is ready!</Text>
        <Button to="https://fluxyfi.com/account/orders" appearance="plain">
          View in My Account
        </Button>
      </InlineStack>
    );
  }

  return null;
}
