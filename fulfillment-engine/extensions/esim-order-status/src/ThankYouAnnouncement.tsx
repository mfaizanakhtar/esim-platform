import {
  reactExtension,
  useAppMetafields,
  InlineStack,
  Text,
  Button,
  Modal,
  BlockStack,
  Divider,
  QRCode,
  Spinner,
} from '@shopify/ui-extensions-react/checkout';
import { useState, useEffect } from 'react';
import { PROVISIONING_QUIPS, type DeliveryMetafieldEntry, parseTokenMap } from './shared';

// ---------------------------------------------------------------------------
// Extension entry point — compact announcement bar at the top of the
// thank-you page. Matches the order-status announcement exactly:
//   provisioning → [spinner] [rotating quip]
//   delivered    → "Your eSIM is ready!" + "View eSIM" → Modal
//
// useAppMetafields is subscription-based: it re-renders automatically when
// the webhook writes the provisioning metafield (within ~1-2s of checkout).
// No cart-line detection needed — if there is no eSIM on this order the
// metafield will simply never be written and the component stays hidden.
// ---------------------------------------------------------------------------

export default reactExtension(
  'purchase.thank-you.announcement.render',
  () => <ThankYouAnnouncementBlock />,
);

function ThankYouAnnouncementBlock() {
  const metafields = useAppMetafields({ namespace: 'esim', key: 'delivery_tokens' });
  const tokensRaw = metafields?.[0]?.metafield?.value as string | undefined;
  const tokenMap = parseTokenMap(tokensRaw);

  const activeEntries = Object.values(tokenMap).filter(
    (e) => e.status === 'provisioning' || e.status === 'pending' || e.status === 'delivered',
  );

  const anyProvisioning = activeEntries.some(
    (e) => e.status === 'provisioning' || e.status === 'pending',
  );

  const [quipIndex, setQuipIndex] = useState(0);

  // ── Quip rotation ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!anyProvisioning) return;
    const interval = setInterval(() => {
      setQuipIndex((prev) => (prev + 1) % PROVISIONING_QUIPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [anyProvisioning]);

  // Nothing to show until the webhook writes the metafield
  if (activeEntries.length === 0) return null;

  // ── Provisioning — compact single row ─────────────────────────────────────
  if (anyProvisioning) {
    return (
      <InlineStack spacing="base" blockAlignment="center">
        <Spinner size="small" />
        <Text>{PROVISIONING_QUIPS[quipIndex]}</Text>
      </InlineStack>
    );
  }

  const deliveredEntries = activeEntries.filter((e) => e.status === 'delivered');
  if (deliveredEntries.length === 0) return null;

  // ── Delivered — "Your eSIM is ready!" + View eSIM → Modal ─────────────────
  return (
    <InlineStack spacing="base" blockAlignment="center">
      <Text emphasis="bold">Your eSIM is ready!</Text>
      {deliveredEntries.map((e, i) =>
        e.lpa ? (
          <Button
            key={e.iccid ?? i}
            overlay={
              <Modal
                id={`esim-thankyou-modal-${e.iccid ?? i}`}
                title={deliveredEntries.length > 1 ? `eSIM ${i + 1} Details` : 'eSIM Details'}
                padding
              >
                <EsimModalContent entry={e} />
              </Modal>
            }
          >
            {deliveredEntries.length > 1 ? `View eSIM ${i + 1}` : 'View eSIM'}
          </Button>
        ) : null,
      )}
    </InlineStack>
  );
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
