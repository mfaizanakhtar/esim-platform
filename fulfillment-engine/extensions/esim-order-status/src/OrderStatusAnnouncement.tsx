import {
  reactExtension,
  useAppMetafields,
  useSettings,
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
import { type DeliveryMetafieldEntry, parseTokenMap, PROVISIONING_QUIPS } from './shared';

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default reactExtension(
  'customer-account.order-status.announcement.render',
  () => <EsimOrderStatusAnnouncement />,
);

function EsimOrderStatusAnnouncement() {
  const { backend_url } = useSettings<{ backend_url?: string }>();
  const backendUrl = (backend_url as string | undefined) ?? '';

  const metafields = useAppMetafields({ namespace: 'esim', key: 'delivery_tokens' });
  const tokensRaw = metafields?.[0]?.metafield?.value as string | undefined;
  const tokenMap = parseTokenMap(tokensRaw);

  const activeEntries = Object.values(tokenMap).filter(
    (e) => e.status === 'provisioning' || e.status === 'delivered',
  );

  // Live updates from /esim/delivery/:token polling
  const [liveMap, setLiveMap] = useState<Record<string, DeliveryMetafieldEntry>>({});
  const [quipIndex, setQuipIndex] = useState(0);

  // Apply live updates, preserving the original accessToken (the
  // /esim/delivery/:token response doesn't include it).
  const resolvedEntries = activeEntries.map((e) =>
    e.accessToken && liveMap[e.accessToken]
      ? { ...e, ...liveMap[e.accessToken], accessToken: e.accessToken }
      : e,
  );

  // ── Token poll ───────────────────────────────────────────────────────────
  // For any provisioning entry with an accessToken, poll every 5s.
  const pollingEntry = resolvedEntries.find(
    (e) => e.status === 'provisioning' && e.accessToken,
  );

  useEffect(() => {
    if (!pollingEntry?.accessToken) return;
    const token = pollingEntry.accessToken;
    let attempts = 0;

    const interval = setInterval(() => {
      if (++attempts > 120) {
        clearInterval(interval);
        return;
      }
      void fetch(`${backendUrl}/esim/delivery/${token}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: DeliveryMetafieldEntry | null) => {
          if (data && ['delivered', 'failed', 'cancelled'].includes(data.status)) {
            setLiveMap((prev) => ({ ...prev, [token]: data }));
            clearInterval(interval);
          }
        })
        .catch(() => {
          /* network blip */
        });
    }, 5000);

    return () => clearInterval(interval);
  }, [pollingEntry?.accessToken, backendUrl]);

  // ── Quip rotation ────────────────────────────────────────────────────────
  const anyProvisioning = resolvedEntries.some((e) => e.status === 'provisioning');
  useEffect(() => {
    if (!anyProvisioning) return;
    const interval = setInterval(() => {
      setQuipIndex((prev) => (prev + 1) % PROVISIONING_QUIPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [anyProvisioning]);

  // ── Render ───────────────────────────────────────────────────────────────
  if (resolvedEntries.length === 0) return null;

  const allDelivered = resolvedEntries.every((e) => e.status === 'delivered');

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
        {resolvedEntries.map((e, i) =>
          e.accessToken ? (
            <Button
              key={e.accessToken}
              appearance="primary"
              overlay={
                <Modal
                  id={`esim-modal-${e.accessToken}`}
                  title={resolvedEntries.length > 1 ? `eSIM ${i + 1} Details` : 'eSIM Details'}
                  padding
                >
                  <EsimModalContent entry={e} />
                </Modal>
              }
            >
              {resolvedEntries.length > 1 ? `View eSIM ${i + 1}` : 'View eSIM'}
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
