import {
  reactExtension,
  useMetafields,
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
import { useState } from 'react';
import { CancelSection } from './CancelEsim';

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
// Extension entry point — order action panel in customer account
// ---------------------------------------------------------------------------

export default reactExtension('customer-account.order.action.render', () => <EsimOrderAction />);

function EsimOrderAction() {
  const metafields = useMetafields({ namespace: 'esim', key: 'delivery_tokens' });
  const tokensRaw = metafields?.[0]?.value as string | undefined;

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
  const [cancelled, setCancelled] = useState(false);

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

      <CancelSection
        accessToken={entry.accessToken}
        cancelled={cancelled}
        onCancelled={() => setCancelled(true)}
      />
    </BlockStack>
  );
}
