import {
  reactExtension,
  useAppMetafields,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Divider,
  Badge,
  QRCode,
  CustomerAccountAction,
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
// Extension entry point — order action panel in customer account
// ---------------------------------------------------------------------------

export default reactExtension('customer-account.order.action.render', () => <EsimOrderAction />);

function EsimOrderAction() {
  const metafields = useAppMetafields({ namespace: 'esim', key: 'delivery_tokens' });
  const tokensRaw = metafields?.[0]?.metafield?.value as string | undefined;

  let tokenMap: Record<string, DeliveryMetafieldEntry> = {};
  if (tokensRaw) {
    try {
      tokenMap = JSON.parse(tokensRaw) as Record<string, DeliveryMetafieldEntry>;
    } catch {
      // Malformed metafield; treat as empty
    }
  }

  const entries = Object.values(tokenMap);

  return (
    <CustomerAccountAction title="Your eSIM">
      {entries.length === 0 ? (
        <Text appearance="subdued">No eSIM found for this order.</Text>
      ) : (
        <BlockStack spacing="base">
          {entries.map((entry, i) => (
            <EsimCard key={entry.accessToken ?? String(i)} entry={entry} />
          ))}
        </BlockStack>
      )}
    </CustomerAccountAction>
  );
}

// ---------------------------------------------------------------------------
// Per-eSIM card — renders one eSIM entry from metafield
// ---------------------------------------------------------------------------

function EsimCard({ entry }: { entry: DeliveryMetafieldEntry }) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);

  const handleCancel = useCallback(async () => {
    if (!entry.accessToken) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/esim/delivery/${entry.accessToken}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string; message?: string };
        if (body.error === 'esim_already_activated') {
          setCancelError('This eSIM has already been installed and cannot be cancelled.');
        } else {
          setCancelError(body.message ?? 'Cancel failed. Please contact support.');
        }
      } else {
        setCancelled(true);
        setConfirmingCancel(false);
      }
    } catch {
      setCancelError('Network error. Please try again.');
    } finally {
      setCancelling(false);
    }
  }, [entry.accessToken]);

  if (entry.status === 'provisioning') {
    return <Text appearance="subdued">Setting up your eSIM...</Text>;
  }

  if (entry.status === 'failed') {
    return (
      <Banner status="critical">
        <Text>eSIM setup failed. Please contact support.</Text>
      </Banner>
    );
  }

  if (entry.status === 'cancelled' || cancelled) {
    return <Badge tone="critical">eSIM Cancelled</Badge>;
  }

  if (entry.status !== 'delivered') {
    return <Text appearance="subdued">Your eSIM is being prepared...</Text>;
  }

  // Delivered — show full eSIM card
  return (
    <BlockStack spacing="base">
      <Divider />

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
