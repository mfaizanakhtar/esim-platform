import {
  reactExtension,
  useAppMetafields,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Divider,
  QRCode,
  Modal,
} from '@shopify/ui-extensions-react/customer-account';
import { useState, useEffect } from 'react';

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
  isTopup?: boolean;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default reactExtension(
  'customer-account.order-status.announcement.render',
  () => <EsimOrderStatusAnnouncement />,
);

const BACKEND = 'https://esim-api-production-a56a.up.railway.app';

function EsimOrderStatusAnnouncement() {
  const metafields = useAppMetafields({ namespace: 'esim', key: 'delivery_tokens' });
  const tokensRaw = metafields?.[0]?.metafield?.value as string | undefined;

  let tokenMap: Record<string, DeliveryMetafieldEntry> = {};
  if (tokensRaw) {
    try {
      tokenMap = JSON.parse(tokensRaw) as Record<string, DeliveryMetafieldEntry>;
    } catch {
      // Malformed metafield — treat as empty
    }
  }

  // Only care about active eSIM entries (not cancelled/failed)
  const activeEntries = Object.values(tokenMap).filter(
    (e) => e.status === 'provisioning' || e.status === 'delivered',
  );

  // Track live state from polling (keyed by accessToken)
  const [liveMap, setLiveMap] = useState<Record<string, DeliveryMetafieldEntry>>({});

  // Merge live poll results over the metafield snapshot
  const resolvedEntries = activeEntries.map((e) =>
    e.accessToken && liveMap[e.accessToken] ? liveMap[e.accessToken] : e,
  );

  // Find the first provisioning entry to poll
  const pollingEntry = resolvedEntries.find(
    (e) => e.status === 'provisioning' && e.accessToken,
  );

  // Poll while any entry is still provisioning
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
          /* network blip — retry next tick */
        });
    }, 5000);

    return () => clearInterval(interval);
  }, [pollingEntry?.accessToken]);

  // Nothing to show if no active eSIM entries
  if (resolvedEntries.length === 0) return null;

  const allDelivered = resolvedEntries.every((e) => e.status === 'delivered');
  const anyProvisioning = resolvedEntries.some((e) => e.status === 'provisioning');

  if (anyProvisioning) {
    return (
      <Banner status="info" title="Your eSIM is being set up">
        <Text>It will be ready automatically — usually within a minute.</Text>
      </Banner>
    );
  }

  if (allDelivered) {
    return (
      <BlockStack spacing="base">
        <Banner status="success" title="Your eSIM is ready!">
          <BlockStack spacing="base">
            <Text>Tap below to view your eSIM details and QR code.</Text>
            <InlineStack spacing="base">
              {resolvedEntries.map((e, i) =>
                e.accessToken ? (
                  <Button
                    key={e.accessToken}
                    overlay={
                      <Modal
                        id={`esim-modal-${e.accessToken}`}
                        title={
                          resolvedEntries.length > 1 ? `eSIM ${i + 1} Details` : 'eSIM Details'
                        }
                        padding
                      >
                        <EsimModalContent entry={e} />
                      </Modal>
                    }
                  >
                    {resolvedEntries.length > 1 ? `View eSIM ${i + 1}` : 'View eSIM Details'}
                  </Button>
                ) : null,
              )}
            </InlineStack>
          </BlockStack>
        </Banner>
      </BlockStack>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Modal content — shows full eSIM card (QR, activation code, ICCID)
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
