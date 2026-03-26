import {
  reactExtension,
  useCartLines,
  useAppMetafields,
  BlockStack,
  InlineStack,
  Banner,
  Text,
  Button,
  QRCode,
  Divider,
  Spinner,
} from '@shopify/ui-extensions-react/checkout';
import { useState, useEffect } from 'react';
import { PROVISIONING_QUIPS, type DeliveryMetafieldEntry, parseTokenMap } from './shared';

// ---------------------------------------------------------------------------
// Extension entry point — renders at the top of the thank-you page as a
// prominent announcement block (always visible, outside collapsed sections).
//
// Shows QR code inline when credentials are available; falls back to a
// "View in My Account" link if not. Shows provisioning spinner while waiting.
// ---------------------------------------------------------------------------

export default reactExtension(
  'purchase.thank-you.announcement.render',
  () => <ThankYouAnnouncementBlock />,
);

function isEsimLine(line: { merchandise?: { title?: string; product?: { productType?: string } } }): boolean {
  const title = line?.merchandise?.title ?? '';
  const productType = line?.merchandise?.product?.productType ?? '';
  return (
    title.toLowerCase().includes('esim') ||
    title.toLowerCase().includes('e-sim') ||
    productType.toLowerCase().includes('esim')
  );
}

function ThankYouAnnouncementBlock() {
  const cartLines = useCartLines();
  const metafields = useAppMetafields({ namespace: 'esim', key: 'delivery_tokens' });
  const tokensRaw = metafields?.[0]?.metafield?.value as string | undefined;
  const tokenMap = parseTokenMap(tokensRaw);

  const looksLikeEsim = cartLines.some((line) => isEsimLine(line as Parameters<typeof isEsimLine>[0]));
  const entries = Object.values(tokenMap).filter(
    (e) => e.status === 'provisioning' || e.status === 'pending' || e.status === 'delivered',
  );

  const anyProvisioning =
    entries.some((e) => e.status === 'provisioning' || e.status === 'pending') ||
    (entries.length === 0 && looksLikeEsim);

  const [quipIndex, setQuipIndex] = useState(0);

  useEffect(() => {
    if (!anyProvisioning) return;
    const interval = setInterval(() => {
      setQuipIndex((prev) => (prev + 1) % PROVISIONING_QUIPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [anyProvisioning]);

  // Nothing to render for non-eSIM orders
  if (entries.length === 0 && !looksLikeEsim) return null;

  // ── Provisioning ──────────────────────────────────────────────────────────
  if (anyProvisioning) {
    return (
      <Banner status="info">
        <BlockStack spacing="base">
          <InlineStack spacing="base" blockAlignment="center">
            <Spinner size="small" />
            <Text emphasis="bold">Your eSIM is being set up</Text>
          </InlineStack>
          <Text appearance="subdued">{PROVISIONING_QUIPS[quipIndex]}</Text>
          <Text>
            Once ready, your QR code and activation details will appear right here — no need to
            refresh.
          </Text>
          <Text>
            {"Feel free to close this page. We'll also email you the details once your eSIM is ready."}
          </Text>
        </BlockStack>
      </Banner>
    );
  }

  const deliveredEntries = entries.filter(
    (e): e is DeliveryMetafieldEntry & { lpa: string } =>
      e.status === 'delivered' && typeof e.lpa === 'string' && e.lpa.length > 0,
  );

  // ── Delivered with credentials — show QR inline ───────────────────────────
  if (deliveredEntries.length > 0) {
    return (
      <BlockStack spacing="base">
        <Divider />
        <Text size="medium" emphasis="bold">
          {deliveredEntries.length > 1 ? 'Your eSIMs are ready!' : 'Your eSIM is ready!'}
        </Text>

        {deliveredEntries.map((e, i) => (
          <BlockStack key={e.iccid ?? i} spacing="base">
            {deliveredEntries.length > 1 && (
              <Text emphasis="bold">eSIM {i + 1}</Text>
            )}
            <QRCode content={e.lpa} accessibilityLabel="eSIM QR code" size="fill" />

            <BlockStack spacing="tight">
              {e.activationCode && (
                <BlockStack spacing="extraTight">
                  <Text appearance="subdued">Activation Code</Text>
                  <Text emphasis="bold">{e.activationCode}</Text>
                </BlockStack>
              )}
              {e.iccid && (
                <BlockStack spacing="extraTight">
                  <Text appearance="subdued">ICCID</Text>
                  <Text>{e.iccid}</Text>
                </BlockStack>
              )}
            </BlockStack>

            <InlineStack spacing="base">
              <Button
                to={`https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(e.lpa)}`}
                appearance="primary"
              >
                Install on iPhone
              </Button>
              {e.usageUrl && (
                <Button to={e.usageUrl} appearance="secondary">
                  View Usage
                </Button>
              )}
            </InlineStack>

            {i < deliveredEntries.length - 1 && <Divider />}
          </BlockStack>
        ))}

        <Text appearance="subdued">
          {"We've also emailed you a copy — check your inbox if you need it later."}
        </Text>
      </BlockStack>
    );
  }

  // ── Delivered but credentials not yet available ───────────────────────────
  return (
    <Banner status="success">
      <BlockStack spacing="base">
        <Text emphasis="bold">Your eSIM is ready!</Text>
        <Text>
          Check your email for the QR code and activation details, or view them in your account
          order history.
        </Text>
        <Button to="https://fluxyfi.com/account/orders" appearance="secondary">
          View in My Account
        </Button>
      </BlockStack>
    </Banner>
  );
}
