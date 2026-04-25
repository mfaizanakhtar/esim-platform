import {
  reactExtension,
  useApi,
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
import { BACKEND_URL, PROVISIONING_QUIPS, type DeliveryMetafieldEntry } from './shared';

export default reactExtension(
  'purchase.thank-you.announcement.render',
  () => <ThankYouAnnouncementBlock />,
);

interface DeliveryStatus {
  lineItemId: string;
  variantId: string;
  status: string;
  accessToken?: string;
}

function ThankYouAnnouncementBlock() {
  const backendUrl = BACKEND_URL;

  const api = useApi<'purchase.thank-you.announcement.render'>();
  const orderConfirmation = useSubscription(
    (api as unknown as { orderConfirmation: Parameters<typeof useSubscription>[0] }).orderConfirmation,
  ) as { order?: { id?: string } } | null;
  const numericOrderId = orderConfirmation?.order?.id?.split('/').pop() ?? '';

  const [deliveries, setDeliveries] = useState<DeliveryStatus[]>([]);
  const [credentialsMap, setCredentialsMap] = useState<Record<string, DeliveryMetafieldEntry>>({});
  const [quipIndex, setQuipIndex] = useState(0);

  useEffect(() => {
    if (!numericOrderId) return;
    let attempts = 0;
    let stopped = false;

    // Track which access tokens are already being polled for credentials
    const pollingTokens = new Set<string>();

    const pollCredentials = (accessToken: string, lineItemId: string) => {
      if (stopped || pollingTokens.has(accessToken)) return;
      pollingTokens.add(accessToken);

      let credAttempts = 0;
      const doPoll = () => {
        if (stopped || ++credAttempts > 200) return;
        void fetch(`${backendUrl}/esim/delivery/${accessToken}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data: DeliveryMetafieldEntry | null) => {
            if (data?.lpa) {
              setCredentialsMap((prev) => ({ ...prev, [lineItemId]: data }));
            } else if (!stopped) {
              setTimeout(doPoll, 3000);
            }
          })
          .catch(() => {
            if (!stopped) setTimeout(doPoll, 3000);
          });
      };
      doPoll();
    };

    const poll = () => {
      if (stopped || ++attempts > 120) return;
      void fetch(`${backendUrl}/esim/order-status/${numericOrderId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { deliveries?: DeliveryStatus[] } | null) => {
          if (!data?.deliveries || stopped) return;
          setDeliveries(data.deliveries);

          const allTerminal = data.deliveries.every(
            (d) => d.status === 'delivered' || d.status === 'failed' || d.status === 'cancelled',
          );

          // Start credential polling for each delivered item
          for (const d of data.deliveries) {
            if (d.status === 'delivered' && d.accessToken) {
              pollCredentials(d.accessToken, d.lineItemId);
            }
          }

          if (!allTerminal) {
            setTimeout(poll, 5000);
          }
        })
        .catch(() => {
          if (!stopped) setTimeout(poll, 5000);
        });
    };

    poll();
    return () => { stopped = true; };
  }, [numericOrderId, backendUrl]);

  const deliveredCount = deliveries.filter((d) => d.status === 'delivered').length;
  const totalCount = deliveries.length;
  const allFailed = totalCount > 0 && deliveries.every(
    (d) => d.status === 'failed' || d.status === 'cancelled',
  );
  const credentialsList = Object.entries(credentialsMap);
  const allCredentialsReady = totalCount > 0 && credentialsList.length === deliveredCount && deliveredCount === totalCount;

  // Keep quips cycling until all credentials are loaded
  const showQuips = !allCredentialsReady && !allFailed;
  useEffect(() => {
    if (!showQuips) return;
    const interval = setInterval(() => {
      setQuipIndex((prev) => (prev + 1) % PROVISIONING_QUIPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [showQuips]);

  if (allFailed) return null;

  // All eSIMs ready with credentials
  if (allCredentialsReady) {
    return (
      <InlineStack spacing="base" blockAlignment="center">
        <Text emphasis="bold" appearance="success">
          {totalCount > 1 ? `✓ All ${totalCount} eSIMs are ready!` : '✓ Your eSIM is ready!'}
        </Text>
        {credentialsList.map(([lineItemId, entry], i) => (
          <Button
            key={lineItemId}
            appearance="primary"
            overlay={
              <Modal
                id={`esim-thankyou-modal-${lineItemId}`}
                title={totalCount > 1 ? `eSIM ${i + 1} Details` : 'eSIM Details'}
                padding
              >
                <EsimModalContent entry={entry} />
              </Modal>
            }
          >
            {totalCount > 1 ? `View eSIM ${i + 1}` : 'View eSIM'}
          </Button>
        ))}
      </InlineStack>
    );
  }

  // Partial progress
  if (deliveredCount > 0 && deliveredCount < totalCount) {
    return (
      <InlineStack spacing="base" blockAlignment="center">
        <Spinner size="small" />
        <Text>{`${deliveredCount} of ${totalCount} eSIMs ready — setting up the rest...`}</Text>
      </InlineStack>
    );
  }

  // Still waiting
  return (
    <InlineStack spacing="base" blockAlignment="center">
      <Spinner size="small" />
      <Text>{PROVISIONING_QUIPS[quipIndex]}</Text>
    </InlineStack>
  );
}

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
