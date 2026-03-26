import {
  reactExtension,
  useApi,
  useAppMetafields,
  useSubscription,
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
import { PROVISIONING_QUIPS, BACKEND, type DeliveryMetafieldEntry, parseTokenMap } from './shared';

// ---------------------------------------------------------------------------
// Extension entry point — compact announcement bar at the top of the
// thank-you page. Matches the order-status announcement pattern exactly:
//   provisioning → [spinner] [rotating quip]
//   delivered    → "Your eSIM is ready!" + "View eSIM" → Modal (if credentials
//                  are in the metafield), else "View in My Account" link.
//
// Status is polled immediately via GET /esim/order-status/:orderId (fast, no
// 2s delay). Credentials come from useAppMetafields subscription — if Shopify
// pushes the updated metafield value after the webhook writes it, the modal
// becomes available automatically.
// ---------------------------------------------------------------------------

export default reactExtension(
  'purchase.thank-you.announcement.render',
  () => <ThankYouAnnouncementBlock />,
);

type EsimStatus = 'pending' | 'provisioning' | 'delivered' | 'failed' | 'cancelled' | null;

function ThankYouAnnouncementBlock() {
  // ── Order ID from confirmation API ────────────────────────────────────────
  const api = useApi<'purchase.thank-you.announcement.render'>();
  const orderConfirmation = useSubscription(
    (api as unknown as { orderConfirmation: Parameters<typeof useSubscription>[0] }).orderConfirmation,
  ) as { order?: { id?: string } } | null;
  const numericOrderId = orderConfirmation?.order?.id?.split('/').pop() ?? '';

  // ── Credentials from metafield subscription ───────────────────────────────
  // These arrive reactively once the webhook writes the metafield.
  const metafields = useAppMetafields({ namespace: 'esim', key: 'delivery_tokens' });
  const tokensRaw = metafields?.[0]?.metafield?.value as string | undefined;
  const tokenMap = parseTokenMap(tokensRaw);
  const deliveredEntry = Object.values(tokenMap).find(
    (e): e is DeliveryMetafieldEntry & { lpa: string } =>
      e.status === 'delivered' && typeof e.lpa === 'string' && e.lpa.length > 0,
  );

  // ── Status via polling ────────────────────────────────────────────────────
  const [status, setStatus] = useState<EsimStatus>(null);
  const [quipIndex, setQuipIndex] = useState(0);

  useEffect(() => {
    if (!numericOrderId) return;
    let attempts = 0;
    let stopped = false;

    const poll = () => {
      if (stopped || ++attempts > 120) return;
      void fetch(`${BACKEND}/esim/order-status/${numericOrderId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { status: EsimStatus } | null) => {
          if (!data || stopped) return;
          if (data.status) setStatus(data.status);
          if (['delivered', 'failed', 'cancelled'].includes(data.status ?? '')) {
            stopped = true;
            return;
          }
          setTimeout(poll, 5000);
        })
        .catch(() => {
          if (!stopped) setTimeout(poll, 5000);
        });
    };

    // Poll immediately — no delay
    poll();
    return () => { stopped = true; };
  }, [numericOrderId]);

  // ── Quip rotation ─────────────────────────────────────────────────────────
  const isProvisioning = status === 'provisioning' || status === 'pending';
  useEffect(() => {
    if (!isProvisioning) return;
    const interval = setInterval(() => {
      setQuipIndex((prev) => (prev + 1) % PROVISIONING_QUIPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [isProvisioning]);

  if (!status || status === 'failed' || status === 'cancelled') return null;

  // ── Provisioning ─────────────────────────────────────────────────────────
  if (isProvisioning) {
    return (
      <InlineStack spacing="base" blockAlignment="center">
        <Spinner size="small" />
        <Text>{PROVISIONING_QUIPS[quipIndex]}</Text>
      </InlineStack>
    );
  }

  // ── Delivered with credentials in metafield → modal ───────────────────────
  if (status === 'delivered' && deliveredEntry) {
    return (
      <InlineStack spacing="base" blockAlignment="center">
        <Text emphasis="bold">Your eSIM is ready!</Text>
        <Button
          overlay={
            <Modal id="esim-thankyou-announcement-modal" title="eSIM Details" padding>
              <EsimModalContent entry={deliveredEntry} />
            </Modal>
          }
        >
          View eSIM
        </Button>
      </InlineStack>
    );
  }

  // ── Delivered but credentials not yet in metafield → link fallback ─────────
  if (status === 'delivered') {
    return (
      <InlineStack spacing="base" blockAlignment="center">
        <Text emphasis="bold">Your eSIM is ready!</Text>
        <Button to="https://fluxyfi.com/account/orders" appearance="plain">
          View in My Account
        </Button>
      </InlineStack>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Modal content — QR code, activation code, ICCID, install buttons
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
