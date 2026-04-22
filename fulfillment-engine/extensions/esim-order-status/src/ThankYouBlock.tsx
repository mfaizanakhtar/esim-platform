import {
  reactExtension,
  useApi,
  useSubscription,
  useSettings,
  BlockStack,
  InlineStack,
  Banner,
  Text,
  Button,
  Link,
  QRCode,
  Divider,
  Spinner,
} from '@shopify/ui-extensions-react/checkout';
import { useState, useEffect } from 'react';
import { PROVISIONING_QUIPS, type DeliveryMetafieldEntry } from './shared';

// ---------------------------------------------------------------------------
// Extension entry point — renders under each line item on the post-checkout
// thank-you page (checkout surface, visible without a customer account).
//
// Credentials are fetched by polling the backend — useAppMetafields is a
// one-time snapshot in the checkout surface and never updates after render.
// ---------------------------------------------------------------------------

export default reactExtension(
  'purchase.thank-you.cart-line-item.render-after',
  () => <ThankYouEsimBlock />,
);

type EsimStatus = 'pending' | 'provisioning' | 'delivered' | 'failed' | 'cancelled' | null;

function ThankYouEsimBlock() {
  const { backend_url, storefront_url } = useSettings<{ backend_url?: string; storefront_url?: string }>();
  const backendUrl = ((backend_url as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const storefrontUrl = ((storefront_url as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const accountOrdersUrl = storefrontUrl ? `${storefrontUrl}/account/orders` : null;

  const api = useApi<'purchase.thank-you.cart-line-item.render-after'>();
  const orderConfirmation = useSubscription(
    (api as unknown as { orderConfirmation: Parameters<typeof useSubscription>[0] }).orderConfirmation,
  ) as { order?: { id?: string } } | null;
  const numericOrderId = orderConfirmation?.order?.id?.split('/').pop() ?? '';

  const [status, setStatus] = useState<EsimStatus>(null);
  const [credentials, setCredentials] = useState<DeliveryMetafieldEntry | null>(null);
  const [quipIndex, setQuipIndex] = useState(0);

  useEffect(() => {
    if (!numericOrderId) return;
    let attempts = 0;
    let stopped = false;

    const pollCredentials = (accessToken: string) => {
      if (stopped) return;
      void fetch(`${backendUrl}/esim/delivery/${accessToken}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: DeliveryMetafieldEntry | null) => {
          if (data?.lpa) {
            stopped = true;
            setCredentials(data);
          } else if (!stopped) {
            setTimeout(() => pollCredentials(accessToken), 3000);
          }
        })
        .catch(() => {
          if (!stopped) setTimeout(() => pollCredentials(accessToken), 3000);
        });
    };

    const poll = () => {
      if (stopped || ++attempts > 120) return;
      void fetch(`${backendUrl}/esim/order-status/${numericOrderId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { status: EsimStatus; accessToken?: string } | null) => {
          if (!data || stopped) return;
          if (data.status) setStatus(data.status);
          if (data.status === 'delivered') {
            if (data.accessToken) pollCredentials(data.accessToken);
            return;
          }
          if (data.status === 'failed' || data.status === 'cancelled') {
            stopped = true;
            return;
          }
          setTimeout(poll, 5000);
        })
        .catch(() => {
          if (!stopped) setTimeout(poll, 5000);
        });
    };

    poll();
    return () => { stopped = true; };
  }, [numericOrderId, backendUrl]);

  const isProvisioning = !status || status === 'pending' || status === 'provisioning';

  useEffect(() => {
    if (!isProvisioning) return;
    const interval = setInterval(() => {
      setQuipIndex((prev) => (prev + 1) % PROVISIONING_QUIPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [isProvisioning]);

  if (status === 'failed' || status === 'cancelled') return null;

  // ── Provisioning ──────────────────────────────────────────────────────────
  if (isProvisioning) {
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
              Once ready, your QR code and activation details will appear right here — no need to
              refresh.
            </Text>
            <Text>
              {"Feel free to close this page. We'll email you the details once your eSIM is ready."}
            </Text>
          </BlockStack>
        </Banner>
      </BlockStack>
    );
  }

  // ── Delivered with full credentials ───────────────────────────────────────
  if (status === 'delivered' && credentials?.lpa) {
    return (
      <BlockStack spacing="base">
        <Divider />
        <Text size="medium" emphasis="bold">
          Your eSIM is ready!
        </Text>

        <QRCode content={credentials.lpa} accessibilityLabel="eSIM QR code" size="fill" />

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
          <Button
            to={`https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(credentials.lpa)}`}
            appearance="primary"
          >
            Install on iPhone
          </Button>
          {credentials.usageUrl && (
            <Button to={credentials.usageUrl} appearance="secondary">
              View Usage
            </Button>
          )}
        </InlineStack>

        <Text appearance="subdued">
          {"We've also emailed you a copy — find it anytime in "}
          {accountOrdersUrl ? (
            <Link to={accountOrdersUrl}>your account orders</Link>
          ) : (
            'your account orders'
          )}
          {'.'}
        </Text>
      </BlockStack>
    );
  }

  // ── Delivered but credentials still loading ────────────────────────────────
  if (status === 'delivered') {
    return (
      <BlockStack spacing="tight">
        <Banner status="success">
          <InlineStack spacing="base" blockAlignment="center">
            <Spinner size="small" />
            <Text emphasis="bold">Your eSIM is ready — loading details…</Text>
          </InlineStack>
        </Banner>
      </BlockStack>
    );
  }

  return null;
}
