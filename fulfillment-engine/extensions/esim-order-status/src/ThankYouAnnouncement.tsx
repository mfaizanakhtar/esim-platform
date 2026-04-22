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

type EsimStatus = 'pending' | 'provisioning' | 'delivered' | 'failed' | 'cancelled' | null;

function ThankYouAnnouncementBlock() {
  const backendUrl = BACKEND_URL;

  const api = useApi<'purchase.thank-you.announcement.render'>();
  const orderConfirmation = useSubscription(
    (api as unknown as { orderConfirmation: Parameters<typeof useSubscription>[0] }).orderConfirmation,
  ) as { order?: { id?: string } } | null;
  const numericOrderId = orderConfirmation?.order?.id?.split('/').pop() ?? '';

  const [status, setStatus] = useState<EsimStatus>(null);
  const [credentials, setCredentials] = useState<DeliveryMetafieldEntry | null>(null);
  const [quipIndex, setQuipIndex] = useState(0);

  useEffect(() => {
    if (!numericOrderId) return;
    let attempts = 0;
    let stopped = false;

    const pollCredentials = (accessToken: string) => {
      if (stopped) return;
      void fetch(`${backendUrl}/esim/delivery/${accessToken}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: DeliveryMetafieldEntry | null) => {
          if (data?.lpa) {
            stopped = true;
            setCredentials(data);
          } else if (!stopped) {
            setTimeout(() => pollCredentials(accessToken), 3000);
          }
        })
        .catch(() => {
          if (!stopped) setTimeout(() => pollCredentials(accessToken), 3000);
        });
    };

    const poll = () => {
      if (stopped || ++attempts > 120) return;
      void fetch(`${backendUrl}/esim/order-status/${numericOrderId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { status: EsimStatus; accessToken?: string } | null) => {
          if (!data || stopped) return;
          if (data.status) setStatus(data.status);
          if (data.status === 'delivered') {
            if (data.accessToken) pollCredentials(data.accessToken);
            return;
          }
          if (data.status === 'failed' || data.status === 'cancelled') {
            stopped = true;
            return;
          }
          setTimeout(poll, 5000);
        })
        .catch(() => {
          if (!stopped) setTimeout(poll, 5000);
        });
    };

    poll();
    return () => { stopped = true; };
  }, [numericOrderId, backendUrl]);

  // Keep quips cycling until credentials are loaded
  const showQuips = !credentials?.lpa && status !== 'failed' && status !== 'cancelled';
  useEffect(() => {
    if (!showQuips) return;
    const interval = setInterval(() => {
      setQuipIndex((prev) => (prev + 1) % PROVISIONING_QUIPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [showQuips]);

  if (status === 'failed' || status === 'cancelled') return null;

  if (credentials?.lpa) {
    return (
      <InlineStack spacing="base" blockAlignment="center">
        <Text emphasis="bold" appearance="success">{'✓ Your eSIM is ready!'}</Text>
        <Button
          appearance="primary"
          overlay={
            <Modal id="esim-thankyou-announcement-modal" title="eSIM Details" padding>
              <EsimModalContent entry={credentials} />
            </Modal>
          }
        >
          View eSIM
        </Button>
      </InlineStack>
    );
  }

  // Show cycling quips while waiting (provisioning, polling, or fetching credentials)
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
