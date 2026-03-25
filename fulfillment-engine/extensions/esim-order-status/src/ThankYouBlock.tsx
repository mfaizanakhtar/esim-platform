import {
  reactExtension,
  useOrderConfirmation,
  useCartLine,
  BlockStack,
  InlineStack,
  Banner,
  Text,
  Button,
  Spinner,
} from '@shopify/ui-extensions-react/checkout';
import { useState, useEffect } from 'react';
import { BACKEND, PROVISIONING_QUIPS } from './shared';

// ---------------------------------------------------------------------------
// Extension entry point — renders under each line item on the post-checkout
// thank-you page (checkout surface, visible without a customer account).
// Polls /esim/order-delivery-status for status only (no credentials here —
// full QR code / activation code are shown in the My Account order page).
// ---------------------------------------------------------------------------

export default reactExtension(
  'purchase.thank-you.cart-line-item.render-after',
  () => <ThankYouEsimBlock />,
);

interface OrderDelivery {
  lineItemId: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Module-level shared poll registry — deduplicate concurrent polls across
// all cart line instances mounting for the same order.
// ---------------------------------------------------------------------------

type PollCallback = (deliveries: OrderDelivery[]) => void;

const activeOrderPolls = new Map<
  string,
  { callbacks: Set<PollCallback>; stopped: boolean }
>();

function subscribeToOrderDeliveries(orderId: string, onResult: PollCallback): () => void {
  if (!activeOrderPolls.has(orderId)) {
    const state: { callbacks: Set<PollCallback>; stopped: boolean } = {
      callbacks: new Set(),
      stopped: false,
    };
    activeOrderPolls.set(orderId, state);

    let attempts = 0;
    const poll = async () => {
      if (state.stopped || ++attempts > 40) {
        activeOrderPolls.delete(orderId);
        return;
      }
      try {
        const r = await fetch(`${BACKEND}/esim/order-delivery-status/${orderId}`);
        if (r.ok) {
          const data = (await r.json()) as { deliveries: OrderDelivery[] };
          state.callbacks.forEach((cb) => cb(data.deliveries));
          // Stop once every delivery has left pending/provisioning
          const allSettled =
            data.deliveries.length > 0 &&
            data.deliveries.every((d) => !['pending', 'provisioning'].includes(d.status));
          if (allSettled) {
            state.stopped = true;
            activeOrderPolls.delete(orderId);
            return;
          }
        }
      } catch {
        /* network blip — retry */
      }
      if (!state.stopped) setTimeout(() => void poll(), 3000);
    };

    void poll();
  }

  const state = activeOrderPolls.get(orderId)!;
  state.callbacks.add(onResult);
  return () => {
    state.callbacks.delete(onResult);
    if (state.callbacks.size === 0) {
      state.stopped = true;
      activeOrderPolls.delete(orderId);
    }
  };
}

// ---------------------------------------------------------------------------

function ThankYouEsimBlock() {
  const orderConfirmation = useOrderConfirmation();
  const cartLine = useCartLine();

  // Extract numeric IDs from GIDs (e.g. "gid://shopify/Order/12345" → "12345")
  const numericOrderId = orderConfirmation?.order?.id?.split('/').pop() ?? '';
  const numericLineItemId = cartLine?.id?.split('/').pop() ?? '';

  const [status, setStatus] = useState<string | null>(null);
  const [quipIndex, setQuipIndex] = useState(0);

  // Rotate quips while provisioning or pending
  useEffect(() => {
    if (status !== 'provisioning' && status !== 'pending') return;
    const interval = setInterval(() => {
      setQuipIndex((prev) => (prev + 1) % PROVISIONING_QUIPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [status]);

  // Subscribe to shared order poll — updates status when worker progresses
  useEffect(() => {
    if (!numericOrderId || !numericLineItemId) return;
    return subscribeToOrderDeliveries(numericOrderId, (deliveries) => {
      const match = deliveries.find((d) => d.lineItemId === numericLineItemId);
      if (match) setStatus(match.status);
    });
  }, [numericOrderId, numericLineItemId]);

  if (!status) return null;

  // ── Provisioning / pending state ─────────────────────────────────────────
  if (status === 'provisioning' || status === 'pending') {
    return (
      <BlockStack spacing="tight">
        <Banner status="info">
          <BlockStack spacing="base">
            <InlineStack spacing="base" blockAlignment="center">
              <Spinner size="small" />
              <Text emphasis="bold">Your eSIM is being set up</Text>
            </InlineStack>
            <Text appearance="subdued">{PROVISIONING_QUIPS[quipIndex]}</Text>
            <Text>
              Once ready, your QR code and activation details will appear in your account — no
              need to refresh this page.
            </Text>
            <Text>
              Feel free to close this page. We'll email you the details once your eSIM is ready.
            </Text>
          </BlockStack>
        </Banner>
      </BlockStack>
    );
  }

  // ── Delivered state ───────────────────────────────────────────────────────
  if (status === 'delivered') {
    return (
      <BlockStack spacing="tight">
        <Banner status="success">
          <BlockStack spacing="base">
            <Text emphasis="bold">Your eSIM is ready!</Text>
            <Text>
              Check your email for the QR code and activation details. You can also find them in
              your account order history.
            </Text>
          </BlockStack>
        </Banner>
        <InlineStack spacing="base">
          <Button to="https://fluxyfi.com/account/orders" appearance="secondary">
            View in My Account
          </Button>
        </InlineStack>
      </BlockStack>
    );
  }

  if (status === 'failed') {
    return (
      <BlockStack spacing="tight">
        <Banner status="critical">
          <Text>
            eSIM setup encountered an issue. Our team has been notified — please contact support.
          </Text>
        </Banner>
      </BlockStack>
    );
  }

  return null;
}
