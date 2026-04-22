import {
  reactExtension,
  useTarget,
  useMetafields,
  useSettings,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Divider,
  Badge,
  QRCode,
  Spinner,
} from '@shopify/ui-extensions-react/customer-account';
import { useState, useEffect } from 'react';
import { CancelSection } from './CancelEsim';
import { type DeliveryMetafieldEntry, parseTokenMap, PROVISIONING_QUIPS } from './shared';

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default reactExtension(
  'customer-account.order-status.cart-line-item.render-after',
  () => <EsimOrderStatusBlock />,
);

function EsimOrderStatusBlock() {
  const { backend_url } = useSettings<{ backend_url?: string }>();
  const backendUrl = (backend_url as string | undefined) ?? '';

  const target = useTarget();

  // The extension renders once per line item.
  // target.id is formatted as gid://shopify/LineItem/123 on order status page.
  const lineItemId = target.id.split('/').pop() ?? '';

  // Read the single "esim.delivery_tokens" metafield declared in shopify.extension.toml.
  // Value is a JSON object: { "<lineItemId>": { status, accessToken, lpa, ... }, ... }
  const metafields = useMetafields({ namespace: 'esim', key: 'delivery_tokens' });
  const tokensRaw = metafields?.[0]?.value as string | undefined;
  const tokenMap = parseTokenMap(tokensRaw);
  const entry = lineItemId ? tokenMap[lineItemId] : undefined;

  const [cancelled, setCancelled] = useState(false);
  const [liveEntry, setLiveEntry] = useState<DeliveryMetafieldEntry | null>(null);
  const [quipIndex, setQuipIndex] = useState(0);

  const resolvedEntry = liveEntry ?? entry;

  // Rotate quips while provisioning
  useEffect(() => {
    if (resolvedEntry?.status !== 'provisioning') return;
    const interval = setInterval(() => {
      setQuipIndex((prev) => (prev + 1) % PROVISIONING_QUIPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [resolvedEntry?.status]);

  // Poll the backend every 5s while status is provisioning so the card
  // auto-updates to delivered without requiring a page reload.
  useEffect(() => {
    if (!resolvedEntry?.accessToken || resolvedEntry.status !== 'provisioning') return;
    let attempts = 0;
    const interval = setInterval(() => {
      if (++attempts > 120) {
        clearInterval(interval);
        return;
      }
      void fetch(`${backendUrl}/esim/delivery/${resolvedEntry.accessToken}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: DeliveryMetafieldEntry | null) => {
          if (data && ['delivered', 'failed', 'cancelled'].includes(data.status)) {
            setLiveEntry(data);
            clearInterval(interval);
          }
        })
        .catch(() => {
          /* network blip — retry next tick */
        });
    }, 5000);
    return () => clearInterval(interval);
  }, [resolvedEntry?.accessToken, resolvedEntry?.status, backendUrl]);

  // Don't render anything if this line item has no eSIM entry
  if (!resolvedEntry) return null;

  if (resolvedEntry.status === 'provisioning') {
    return (
      <BlockStack spacing="base">
        <Divider />
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
          </BlockStack>
        </Banner>
      </BlockStack>
    );
  }

  if (resolvedEntry.status === 'failed') {
    return (
      <BlockStack spacing="base">
        <Divider />
        <Banner status="critical">
          <Text>eSIM setup failed. Please contact support.</Text>
        </Banner>
      </BlockStack>
    );
  }

  if (resolvedEntry.status === 'cancelled' || cancelled) {
    return (
      <BlockStack spacing="base">
        <Divider />
        <Badge tone="critical">eSIM Cancelled</Badge>
      </BlockStack>
    );
  }

  if (resolvedEntry.status !== 'delivered') {
    return (
      <BlockStack spacing="base">
        <Divider />
        <Text appearance="subdued">Your eSIM is being prepared...</Text>
      </BlockStack>
    );
  }

  // Delivered — show full eSIM card
  return (
    <BlockStack spacing="base">
      <Divider />
      <Text size="medium" emphasis="bold">
        Your eSIM
      </Text>

      {resolvedEntry.lpa && (
        <QRCode content={resolvedEntry.lpa} accessibilityLabel="eSIM QR code" size="fill" />
      )}

      <BlockStack spacing="tight">
        {resolvedEntry.activationCode && (
          <BlockStack spacing="extraTight">
            <Text appearance="subdued">Activation Code</Text>
            <Text emphasis="bold">{resolvedEntry.activationCode}</Text>
          </BlockStack>
        )}
        {resolvedEntry.iccid && (
          <BlockStack spacing="extraTight">
            <Text appearance="subdued">ICCID</Text>
            <Text>{resolvedEntry.iccid}</Text>
          </BlockStack>
        )}
      </BlockStack>

      <InlineStack spacing="base">
        {resolvedEntry.lpa && (
          <Button
            to={`https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(resolvedEntry.lpa)}`}
            appearance="primary"
          >
            Install on iPhone
          </Button>
        )}
        {resolvedEntry.usageUrl && (
          <Button to={resolvedEntry.usageUrl} appearance="secondary">
            View Usage
          </Button>
        )}
      </InlineStack>

      <CancelSection
        accessToken={resolvedEntry.accessToken}
        cancelled={cancelled}
        onCancelled={() => setCancelled(true)}
      />
    </BlockStack>
  );
}
