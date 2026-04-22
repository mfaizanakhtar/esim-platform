import {
  reactExtension,
  useTarget,
  useOrder,
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
import { useOrderMetafield, PROVISIONING_QUIPS } from './shared';

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default reactExtension(
  'customer-account.order-status.cart-line-item.render-after',
  () => <EsimOrderStatusBlock />,
);

function EsimOrderStatusBlock() {
  const order = useOrder();
  const tokenMap = useOrderMetafield(order?.id);

  const target = useTarget();
  const lineItemId = target.id.split('/').pop() ?? '';
  const entry = lineItemId ? tokenMap[lineItemId] : undefined;

  const [cancelled, setCancelled] = useState(false);
  const [quipIndex, setQuipIndex] = useState(0);

  useEffect(() => {
    if (entry?.status !== 'provisioning') return;
    const interval = setInterval(() => {
      setQuipIndex((prev) => (prev + 1) % PROVISIONING_QUIPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [entry?.status]);

  if (!entry) return null;

  if (entry.status === 'provisioning') {
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

  return (
    <BlockStack spacing="base">
      <Divider />
      <Text size="medium" emphasis="bold">Your eSIM</Text>

      {entry.lpa && (
        <QRCode content={entry.lpa} accessibilityLabel="eSIM QR code" size="fill" />
      )}

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
