import {
  reactExtension,
  useOrder,
  useAppMetafields,
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
import { type DeliveryMetafieldEntry, BACKEND, parseTokenMap, PROVISIONING_QUIPS } from './shared';

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default reactExtension(
  'customer-account.order-status.announcement.render',
  () => <EsimOrderStatusAnnouncement />,
);

interface OrderDelivery {
  lineItemId: string;
  status: string;
  accessToken?: string;
}

function EsimOrderStatusAnnouncement() {
  // Read order ID for bootstrap polling (before metafield is written)
  const order = useOrder();
  const numericOrderId = order?.id?.split('/').pop() ?? '';

  // Metafield snapshot (written by webhook after order creation)
  const metafields = useAppMetafields({ namespace: 'esim', key: 'delivery_tokens' });
  const tokensRaw = metafields?.[0]?.metafield?.value as string | undefined;
  const tokenMap = parseTokenMap(tokensRaw);
  const metafieldEntries = Object.values(tokenMap).filter(
    (e) => e.status === 'provisioning' || e.status === 'delivered',
  );

  // Bootstrap entries: polled from backend when metafield isn't written yet
  const [bootstrapEntries, setBootstrapEntries] = useState<OrderDelivery[]>([]);

  // Live updates from /esim/delivery/:token polling
  const [liveMap, setLiveMap] = useState<Record<string, DeliveryMetafieldEntry>>({});
  const [quipIndex, setQuipIndex] = useState(0);

  // ── Bootstrap poll ──────────────────────────────────────────────────────
  // When the metafield is missing (typical on first load — the webhook
  // hasn't fired yet), poll the order-status endpoint until we see deliveries.
  useEffect(() => {
    if (!numericOrderId || metafieldEntries.length > 0) return;
    let stopped = false;
    let attempts = 0;

    const poll = async () => {
      if (stopped || ++attempts > 30) return;
      try {
        const r = await fetch(`${BACKEND}/esim/order-delivery-status/${numericOrderId}`);
        if (r.ok) {
          const data = (await r.json()) as { deliveries: OrderDelivery[] };
          const active = data.deliveries.filter(
            (d) => d.status === 'provisioning' || d.status === 'delivered',
          );
          if (active.length > 0) {
            setBootstrapEntries(active);
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
  }, [numericOrderId, metafieldEntries.length]);

  // ── Merge entries ────────────────────────────────────────────────────────
  // Prefer metafield entries (authoritative) over bootstrap entries.
  const baseEntries: DeliveryMetafieldEntry[] =
    metafieldEntries.length > 0
      ? metafieldEntries
      : bootstrapEntries.map((b) => ({
          status: b.status as DeliveryMetafieldEntry['status'],
          accessToken: b.accessToken,
        }));

  // Apply live updates on top
  const resolvedEntries = baseEntries.map((e) =>
    e.accessToken && liveMap[e.accessToken] ? liveMap[e.accessToken] : e,
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
      void fetch(`${BACKEND}/esim/delivery/${token}`)
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
  }, [pollingEntry?.accessToken]);

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
    // Compact — fits the limited announcement banner height on mobile
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
        <Text emphasis="bold">Your eSIM is ready!</Text>
        {resolvedEntries.map((e, i) =>
          e.accessToken ? (
            <Button
              key={e.accessToken}
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
