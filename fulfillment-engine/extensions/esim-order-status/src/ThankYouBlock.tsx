import {
  reactExtension,
  useOrderConfirmation,
  useCartLine,
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
import { BACKEND, PROVISIONING_QUIPS } from './shared';

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
  accessToken?: string;
}

interface EsimCredentials {
  status: string;
  lpa?: string;
  activationCode?: string;
  iccid?: string;
  usageUrl?: string;
}

function ThankYouEsimBlock() {
  const orderConfirmation = useOrderConfirmation();
  const cartLine = useCartLine();

  // Extract numeric IDs from GIDs (e.g. "gid://shopify/Order/12345" → "12345")
  const numericOrderId = orderConfirmation?.order?.id?.split('/').pop() ?? '';
  const numericLineItemId = cartLine?.id?.split('/').pop() ?? '';

  const [delivery, setDelivery] = useState<OrderDelivery | null>(null);
  const [credentials, setCredentials] = useState<EsimCredentials | null>(null);
  const [quipIndex, setQuipIndex] = useState(0);

  // ── Rotate quips while provisioning ─────────────────────────────────────
  useEffect(() => {
    if (delivery?.status !== 'provisioning') return;
    const interval = setInterval(() => {
      setQuipIndex((prev) => (prev + 1) % PROVISIONING_QUIPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [delivery?.status]);

  // ── Step 1: find our delivery by order + line item ID ────────────────────
  useEffect(() => {
    if (!numericOrderId) return;
    let stopped = false;
    let attempts = 0;

    const poll = async () => {
      if (stopped || ++attempts > 40) return;
      try {
        const r = await fetch(`${BACKEND}/esim/order-delivery-status/${numericOrderId}`);
        if (r.ok) {
          const data = (await r.json()) as { deliveries: OrderDelivery[] };
          const match = data.deliveries.find((d) => d.lineItemId === numericLineItemId);
          if (match) {
            setDelivery(match);
            // Stop this loop — token-level polling takes over for provisioning state
            stopped = true;
            return;
          }
        }
      } catch {
        /* network blip */
      }
      if (!stopped) setTimeout(() => void poll(), 3000);
    };

    void poll();
    return () => {
      stopped = true;
    };
  }, [numericOrderId, numericLineItemId]);

  // ── Step 2: once we have an accessToken, poll for delivery completion ────
  useEffect(() => {
    if (!delivery?.accessToken || delivery.status !== 'provisioning') return;
    const token = delivery.accessToken;
    let stopped = false;
    let attempts = 0;

    const interval = setInterval(() => {
      if (stopped || ++attempts > 80) {
        clearInterval(interval);
        return;
      }
      void fetch(`${BACKEND}/esim/delivery/${token}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: EsimCredentials | null) => {
          if (data && ['delivered', 'failed', 'cancelled'].includes(data.status)) {
            setDelivery((prev) => (prev ? { ...prev, status: data.status } : prev));
            if (data.status === 'delivered') setCredentials(data);
            stopped = true;
            clearInterval(interval);
          }
        })
        .catch(() => {});
    }, 5000);

    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [delivery?.accessToken, delivery?.status]);

  // ── Step 3: if already delivered when we first find it, fetch credentials
  useEffect(() => {
    if (!delivery?.accessToken || delivery.status !== 'delivered' || credentials) return;
    void fetch(`${BACKEND}/esim/delivery/${delivery.accessToken}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: EsimCredentials | null) => {
        if (data?.status === 'delivered') setCredentials(data);
      })
      .catch(() => {});
  }, [delivery?.accessToken, delivery?.status, credentials]);

  if (!delivery) return null;

  // ── Provisioning state ───────────────────────────────────────────────────
  if (delivery.status === 'provisioning') {
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
              Feel free to close this page and check your email instead, or find it anytime in
              your order history.
            </Text>
          </BlockStack>
        </Banner>
      </BlockStack>
    );
  }

  // ── Delivered state — show full eSIM card ────────────────────────────────
  if (delivery.status === 'delivered' && credentials) {
    return (
      <BlockStack spacing="base">
        <Divider />
        <Text size="medium" emphasis="bold">
          Your eSIM is ready!
        </Text>

        {credentials.lpa && (
          <QRCode content={credentials.lpa} accessibilityLabel="eSIM QR code" size="fill" />
        )}

        <BlockStack spacing="tight">
          {credentials.activationCode && (
            <BlockStack spacing="extraTight">
              <Text appearance="subdued">Activation Code</Text>
              <Text emphasis="bold">{credentials.activationCode}</Text>
            </BlockStack>
          )}
          {credentials.iccid && (
            <BlockStack spacing="extraTight">
              <Text appearance="subdued">ICCID</Text>
              <Text>{credentials.iccid}</Text>
            </BlockStack>
          )}
        </BlockStack>

        <InlineStack spacing="base">
          {credentials.lpa && (
            <Button
              to={`https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(credentials.lpa)}`}
              appearance="primary"
            >
              Install on iPhone
            </Button>
          )}
          {credentials.usageUrl && (
            <Button to={credentials.usageUrl} appearance="secondary">
              View Usage
            </Button>
          )}
        </InlineStack>

        <Text appearance="subdued">
          We've also emailed you a copy — check your inbox if you need it later.
        </Text>
      </BlockStack>
    );
  }

  // Delivered but credentials still loading — show brief placeholder
  if (delivery.status === 'delivered') {
    return (
      <BlockStack spacing="tight">
        <Banner status="success">
          <Text>Your eSIM is ready! Loading details...</Text>
        </Banner>
      </BlockStack>
    );
  }

  if (delivery.status === 'failed') {
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
