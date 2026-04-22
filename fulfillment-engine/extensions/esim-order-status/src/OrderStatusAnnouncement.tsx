import {
  reactExtension,
  useOrder,
  InlineStack,
  Text,
  Button,
  Modal,
  BlockStack,
  Divider,
  QRCode,
  Spinner,
} from '@shopify/ui-extensions-react/customer-account';
import { useState, useEffect } from 'react';
import {
  type DeliveryMetafieldEntry,
  extractNumericId,
  useOrderDeliveries,
  PROVISIONING_QUIPS,
} from './shared';

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default reactExtension(
  'customer-account.order-status.announcement.render',
  () => <EsimOrderStatusAnnouncement />,
);

function EsimOrderStatusAnnouncement() {
  const order = useOrder();
  const orderId = extractNumericId(order?.id);

  const deliveryMap = useOrderDeliveries(orderId);
  const [quipIndex, setQuipIndex] = useState(0);

  const activeEntries = Object.values(deliveryMap).filter(
    (e) => e.status === 'provisioning' || e.status === 'delivered',
  );

  // ── Quip rotation ────────────────────────────────────────────────────────
  const anyProvisioning = activeEntries.some((e) => e.status === 'provisioning');
  useEffect(() => {
    if (!anyProvisioning) return;
    const interval = setInterval(() => {
      setQuipIndex((prev) => (prev + 1) % PROVISIONING_QUIPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [anyProvisioning]);

  // ── Render ───────────────────────────────────────────────────────────────
  if (activeEntries.length === 0) return null;

  const allDelivered = activeEntries.every((e) => e.status === 'delivered' && e.lpa);

  if (anyProvisioning) {
    return (
      <InlineStack spacing="base" blockAlignment="center">
        <Spinner size="small" />
        <Text>{PROVISIONING_QUIPS[quipIndex]}</Text>
      </InlineStack>
    );
  }

  if (allDelivered) {
    return (
      <InlineStack spacing="base" blockAlignment="center">
        <Text emphasis="bold" appearance="success">{'✓ Your eSIM is ready!'}</Text>
        {activeEntries.map((e, i) =>
          e.accessToken ? (
            <Button
              key={e.accessToken}
              appearance="primary"
              overlay={
                <Modal
                  id={`esim-modal-${e.accessToken}`}
                  title={activeEntries.length > 1 ? `eSIM ${i + 1} Details` : 'eSIM Details'}
                  padding
                >
                  <EsimModalContent entry={e} />
                </Modal>
              }
            >
              {activeEntries.length > 1 ? `View eSIM ${i + 1}` : 'View eSIM'}
            </Button>
          ) : null,
        )}
      </InlineStack>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Modal content — full eSIM card (QR code, activation code, ICCID)
// ---------------------------------------------------------------------------

function EsimModalContent({ entry }: { entry: DeliveryMetafieldEntry }) {
  return (
    <BlockStack spacing="base">
      {entry.lpa && <QRCode content={entry.lpa} accessibilityLabel="eSIM QR code" size="fill" />}

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

      <Divider />

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
    </BlockStack>
  );
}
