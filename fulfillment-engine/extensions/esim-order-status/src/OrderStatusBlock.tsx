import {
  reactExtension,
  useOrder,
  useExtensionTarget,
  useAppMetafields,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Divider,
  Image,
  Badge,
  Modal,
  useApi,
} from '@shopify/ui-extensions-react/customer-account';
import { useState, useEffect, useCallback } from 'react';
import QRCode from 'qrcode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EsimDeliveryResponse {
  status: string;
  lpa?: string;
  activationCode?: string;
  iccid?: string;
  usageUrl?: string;
  canCancel?: boolean;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BACKEND_URL = 'https://esim-api-production-a56a.up.railway.app';

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default reactExtension(
  'customer-account.order-status.cart-line-item.render-after',
  () => <EsimOrderStatusBlock />,
);

function EsimOrderStatusBlock() {
  const { extension } = useApi();
  const order = useOrder();
  const target = useExtensionTarget();

  // The extension renders once per line item.
  // `target.lineItem.id` is the GID; extract the numeric ID.
  const lineItemGid: string = (target as { lineItem?: { id?: string } })?.lineItem?.id ?? '';
  const lineItemId = lineItemGid.replace('gid://shopify/LineItem/', '');

  // Read the single "esim.delivery_tokens" metafield declared in shopify.extension.toml.
  // Value is a JSON object: { "<lineItemId>": "<accessToken>", ... }
  const metafields = useAppMetafields({ namespace: 'esim', key: 'delivery_tokens' });
  const tokensRaw = metafields?.[0]?.metafield?.value as string | undefined;
  const tokenMap: Record<string, string> = tokensRaw ? JSON.parse(tokensRaw) : {};
  const accessToken = lineItemId ? tokenMap[lineItemId] : undefined;

  const [esim, setEsim] = useState<EsimDeliveryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);

  // Fetch eSIM data from backend
  useEffect(() => {
    if (!accessToken) return;

    setLoading(true);
    fetch(`${BACKEND_URL}/esim/delivery/${accessToken}`)
      .then((r) => r.json())
      .then((data: EsimDeliveryResponse) => {
        setEsim(data);
        if (data.lpa) {
          QRCode.toDataURL(data.lpa, { width: 200, margin: 2 })
            .then(setQrDataUrl)
            .catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [accessToken]);

  const handleCancel = useCallback(async () => {
    if (!accessToken) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/esim/delivery/${accessToken}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; message?: string };
      if (res.ok) {
        setCancelled(true);
        setCancelModalOpen(false);
      } else if (body.error === 'esim_already_activated') {
        setCancelError('This eSIM has already been installed and cannot be cancelled.');
      } else {
        setCancelError(body.message ?? 'Cancel failed. Please contact support.');
      }
    } catch {
      setCancelError('Network error. Please try again.');
    } finally {
      setCancelling(false);
    }
  }, [accessToken]);

  // Don't render anything if this line item has no eSIM token
  if (!accessToken) return null;

  if (loading) {
    return (
      <BlockStack spacing="base">
        <Divider />
        <Text appearance="subdued">Setting up your eSIM...</Text>
      </BlockStack>
    );
  }

  if (!esim) return null;

  if (esim.status === 'cancelled' || cancelled) {
    return (
      <BlockStack spacing="base">
        <Divider />
        <Badge tone="critical">eSIM Cancelled</Badge>
      </BlockStack>
    );
  }

  if (esim.status === 'failed') {
    return (
      <BlockStack spacing="base">
        <Divider />
        <Banner status="critical">
          <Text>eSIM setup failed. Please contact support.</Text>
        </Banner>
      </BlockStack>
    );
  }

  if (esim.status !== 'delivered') {
    return (
      <BlockStack spacing="base">
        <Divider />
        <Text appearance="subdued">Your eSIM is being prepared...</Text>
      </BlockStack>
    );
  }

  // Delivered — show full eSIM card
  return (
    <BlockStack spacing="base">
      <Divider />
      <Text size="medium" emphasis="bold">
        Your eSIM
      </Text>

      {qrDataUrl && (
        <Image source={qrDataUrl} accessibilityDescription="eSIM QR code" />
      )}

      <BlockStack spacing="tight">
        <InlineStack spacing="base">
          <Text appearance="subdued">Activation Code</Text>
          <Text emphasis="bold">{esim.activationCode}</Text>
        </InlineStack>
        <InlineStack spacing="base">
          <Text appearance="subdued">ICCID</Text>
          <Text>{esim.iccid}</Text>
        </InlineStack>
      </BlockStack>

      <InlineStack spacing="base">
        {esim.lpa && (
          <Button
            to={`https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(esim.lpa)}`}
            appearance="primary"
          >
            Install on iPhone
          </Button>
        )}
        {esim.usageUrl && (
          <Button to={esim.usageUrl} appearance="secondary">
            View Usage
          </Button>
        )}
      </InlineStack>

      {esim.canCancel && !cancelled && (
        <Button appearance="critical" onPress={() => setCancelModalOpen(true)}>
          Cancel eSIM
        </Button>
      )}

      {cancelModalOpen && (
        <Modal
          title="Cancel eSIM"
          onClose={() => setCancelModalOpen(false)}
        >
          <BlockStack spacing="base">
            <Text>
              Are you sure you want to cancel this eSIM? This will deactivate the eSIM and
              refund your order. This action cannot be undone if the eSIM has already been installed.
            </Text>
            {cancelError && (
              <Banner status="critical">
                <Text>{cancelError}</Text>
              </Banner>
            )}
            <InlineStack spacing="base">
              <Button
                appearance="critical"
                onPress={handleCancel}
                loading={cancelling}
              >
                Yes, Cancel eSIM
              </Button>
              <Button appearance="secondary" onPress={() => setCancelModalOpen(false)}>
                Keep eSIM
              </Button>
            </InlineStack>
          </BlockStack>
        </Modal>
      )}
    </BlockStack>
  );
}
