import {
  reactExtension,
  useTarget,
  useAppMetafields,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Divider,
  Badge,
  QRCode,
} from '@shopify/ui-extensions-react/customer-account';
import { useState, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeliveryMetafieldEntry {
  status: 'provisioning' | 'delivered' | 'cancelled' | 'failed';
  accessToken?: string;
  lpa?: string;
  activationCode?: string;
  iccid?: string;
  usageUrl?: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BACKEND_URL = 'https://esim-api-production-a56a.up.railway.app';

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default reactExtension(
  'customer-account.order-status.cart-line-item.render-after',
  () => <EsimOrderStatusBlock />,
);

function EsimOrderStatusBlock() {
  const target = useTarget();

  // The extension renders once per line item.
  // target.id is formatted as gid://shopify/LineItem/123 on order status page.
  const lineItemId = target.id.split('/').pop() ?? '';

  // Read the single "esim.delivery_tokens" metafield declared in shopify.extension.toml.
  // Value is a JSON object: { "<lineItemId>": { status, accessToken, lpa, ... }, ... }
  const metafields = useAppMetafields({ namespace: 'esim', key: 'delivery_tokens' });
  const tokensRaw = metafields?.[0]?.metafield?.value as string | undefined;
  let tokenMap: Record<string, DeliveryMetafieldEntry> = {};
  if (tokensRaw) {
    try {
      tokenMap = JSON.parse(tokensRaw) as Record<string, DeliveryMetafieldEntry>;
    } catch {
      // Malformed metafield value; treat as empty
    }
  }
  const entry = lineItemId ? tokenMap[lineItemId] : undefined;

  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);

  const handleCancel = useCallback(async () => {
    if (!entry?.accessToken) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/esim/delivery/${entry.accessToken}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; message?: string };
      if (res.ok) {
        setCancelled(true);
        setConfirmingCancel(false);
      } else if (body.error === 'esim_already_activated') {
        setCancelError('This eSIM has already been installed and cannot be cancelled.');
      } else {
        setCancelError(body.message ?? 'Cancel failed. Please contact support.');
      }
    } catch {
      setCancelError('Network error. Please try again.');
    } finally {
      setCancelling(false);
    }
  }, [entry?.accessToken]);

  // Don't render anything if this line item has no eSIM entry
  if (!entry) return null;

  if (entry.status === 'provisioning') {
    return (
      <BlockStack spacing="base">
        <Divider />
        <Text appearance="subdued">Setting up your eSIM...</Text>
      </BlockStack>
    );
  }

  if (entry.status === 'failed') {
    return (
      <BlockStack spacing="base">
        <Divider />
        <Banner status="critical">
          <Text>eSIM setup failed. Please contact support.</Text>
        </Banner>
      </BlockStack>
    );
  }

  if (entry.status === 'cancelled' || cancelled) {
    return (
      <BlockStack spacing="base">
        <Divider />
        <Badge tone="critical">eSIM Cancelled</Badge>
      </BlockStack>
    );
  }

  if (entry.status !== 'delivered') {
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

      {entry.lpa && <QRCode content={entry.lpa} accessibilityLabel="eSIM QR code" size="fill" />}

      <BlockStack spacing="tight">
        <InlineStack spacing="base">
          <Text appearance="subdued">Activation Code</Text>
          <Text emphasis="bold">{entry.activationCode}</Text>
        </InlineStack>
        <InlineStack spacing="base">
          <Text appearance="subdued">ICCID</Text>
          <Text>{entry.iccid}</Text>
        </InlineStack>
      </BlockStack>

      <InlineStack spacing="base">
        {entry.lpa && (
          <Button
            to={`https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(entry.lpa)}`}
            appearance="primary"
          >
            Install on iPhone
          </Button>
        )}
        {entry.usageUrl && (
          <Button to={entry.usageUrl} appearance="secondary">
            View Usage
          </Button>
        )}
      </InlineStack>

      {entry.accessToken && !cancelled && !confirmingCancel && (
        <Button appearance="critical" onPress={() => setConfirmingCancel(true)}>
          Cancel eSIM
        </Button>
      )}

      {confirmingCancel && (
        <BlockStack spacing="base">
          <Text>
            Are you sure you want to cancel this eSIM? This will deactivate the eSIM and refund
            your order. This action cannot be undone if the eSIM has already been installed.
          </Text>
          {cancelError && (
            <Banner status="critical">
              <Text>{cancelError}</Text>
            </Banner>
          )}
          <InlineStack spacing="base">
            <Button appearance="critical" onPress={handleCancel} loading={cancelling}>
              Yes, Cancel eSIM
            </Button>
            <Button appearance="secondary" onPress={() => { setConfirmingCancel(false); setCancelError(null); }}>
              Keep eSIM
            </Button>
          </InlineStack>
        </BlockStack>
      )}
    </BlockStack>
  );
}
