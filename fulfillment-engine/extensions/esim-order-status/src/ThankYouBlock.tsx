import {
  reactExtension,
  useOrderConfirmation,
  useCartLine,
  useAppMetafields,
  BlockStack,
  InlineStack,
  Banner,
  Text,
  Button,
  QRCode,
  Divider,
  Spinner,
} from '@shopify/ui-extensions-react/checkout';
import { useState, useEffect } from 'react';
import { BACKEND, PROVISIONING_QUIPS, type DeliveryMetafieldEntry, parseTokenMap } from './shared';

// ---------------------------------------------------------------------------
// Extension entry point — renders under each line item on the post-checkout
// thank-you page (checkout surface, visible without a customer account).
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
// Module-level shared poll registry — one poll per order, shared across all
// cart line instances, avoids duplicate requests for multi-line orders.
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

  // Read the order metafield — written by the webhook/worker with credentials.
  // This is the primary source for credentials on the thank-you page.
  const metafields = useAppMetafields({ namespace: 'esim', key: 'delivery_tokens' });
  const tokensRaw = metafields?.[0]?.metafield?.value as string | undefined;
  const tokenMap = parseTokenMap(tokensRaw);
  const metafieldEntry: DeliveryMetafieldEntry | undefined = numericLineItemId
    ? tokenMap[numericLineItemId]
    : undefined;

  // Optimistic status: start as 'pending' so the spinner shows immediately
  // while the poll is in-flight. If the line item turns out to have no eSIM
  // (poll returns no match after all attempts), status stays 'pending' but
  // the component is hidden via the `isEsim` flag.
  const [isEsim, setIsEsim] = useState<boolean | null>(null);
  const [polledStatus, setPolledStatus] = useState<string>('pending');
  const [quipIndex, setQuipIndex] = useState(0);

  // Rotate quips while provisioning / pending
  const activeStatus = metafieldEntry?.status ?? polledStatus;
  useEffect(() => {
    if (activeStatus !== 'provisioning' && activeStatus !== 'pending') return;
    const interval = setInterval(() => {
      setQuipIndex((prev) => (prev + 1) % PROVISIONING_QUIPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [activeStatus]);

  // Subscribe to shared order poll — updates polledStatus and isEsim flag
  useEffect(() => {
    if (!numericOrderId || !numericLineItemId) return;
    return subscribeToOrderDeliveries(numericOrderId, (deliveries) => {
      const match = deliveries.find((d) => d.lineItemId === numericLineItemId);
      if (match) {
        setIsEsim(true);
        setPolledStatus(match.status);
      } else {
        setIsEsim(false);
      }
    });
  }, [numericOrderId, numericLineItemId]);

  // If the metafield already has an entry we know it's an eSIM line
  if (!metafieldEntry && isEsim === false) return null;
  if (!metafieldEntry && isEsim === null) {
    // Still waiting for first poll result — show optimistic spinner
    return (
      <BlockStack spacing="tight">
        <Banner status="info">
          <InlineStack spacing="base" blockAlignment="center">
            <Spinner size="small" />
            <Text>{PROVISIONING_QUIPS[quipIndex]}</Text>
          </InlineStack>
        </Banner>
      </BlockStack>
    );
  }

  // Use metafield entry as source of truth once available
  const entry = metafieldEntry;
  const status = entry?.status ?? polledStatus;

  // ── Provisioning / pending ────────────────────────────────────────────────
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
              Once ready, your QR code and activation details will appear right here automatically
              — no need to refresh.
            </Text>
            <Text>
              Feel free to close this page. {"We'll"} email you the details once your eSIM is
              ready.
            </Text>
          </BlockStack>
        </Banner>
      </BlockStack>
    );
  }

  // ── Delivered with full credentials from metafield ────────────────────────
  if (status === 'delivered' && entry?.lpa) {
    return (
      <BlockStack spacing="base">
        <Divider />
        <Text size="medium" emphasis="bold">
          Your eSIM is ready!
        </Text>

        <QRCode content={entry.lpa} accessibilityLabel="eSIM QR code" size="fill" />

        <BlockStack spacing="tight">
          {entry.activationCode && (
            <BlockStack spacing="extraTight">
              <Text appearance="subdued">Activation Code</Text>
              <Text emphasis="bold">{entry.activationCode}</Text>
            </BlockStack>
          )}
          {entry.iccid && (
            <BlockStack spacing="extraTight">
              <Text appearance="subdued">ICCID</Text>
              <Text>{entry.iccid}</Text>
            </BlockStack>
          )}
        </BlockStack>

        <InlineStack spacing="base">
          <Button
            to={`https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(entry.lpa)}`}
            appearance="primary"
          >
            Install on iPhone
          </Button>
          {entry.usageUrl && (
            <Button to={entry.usageUrl} appearance="secondary">
              View Usage
            </Button>
          )}
        </InlineStack>

        <Text appearance="subdued">
          {"We've also emailed you a copy — check your inbox if you need it later."}
        </Text>
      </BlockStack>
    );
  }

  // ── Delivered but metafield not yet populated with credentials ────────────
  if (status === 'delivered') {
    return (
      <BlockStack spacing="tight">
        <Banner status="success">
          <BlockStack spacing="base">
            <Text emphasis="bold">Your eSIM is ready!</Text>
            <Text>
              Check your email for the QR code and activation details, or view them in your
              account order history.
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
