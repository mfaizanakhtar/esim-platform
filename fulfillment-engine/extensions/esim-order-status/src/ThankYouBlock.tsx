import {
  reactExtension,
  useCartLine,
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
// Extension entry point — renders under each line item on the post-checkout
// thank-you page (checkout surface, visible without a customer account).
//
// Credentials come from the order metafield (esim.delivery_tokens) — the same
// source used by the customer-account order status extension. No backend call
// is made from this component; all data goes through Shopify's metafield API.
// ---------------------------------------------------------------------------

export default reactExtension(
  'purchase.thank-you.cart-line-item.render-after',
  () => <ThankYouEsimBlock />,
);

/** Detect whether the current cart line is an eSIM product by inspecting
 *  the merchandise metadata available in the checkout surface. */
function isEsimMerchandise(cartLine: ReturnType<typeof useCartLine>): boolean {
  const title = cartLine?.merchandise?.title ?? '';
  const productType = (cartLine?.merchandise as { product?: { productType?: string } })?.product
    ?.productType ?? '';
  return (
    title.toLowerCase().includes('esim') ||
    title.toLowerCase().includes('e-sim') ||
    productType.toLowerCase().includes('esim')
  );
}

function ThankYouEsimBlock() {
  const cartLine = useCartLine();

  // Read the order metafield — written by the webhook/worker with delivery state.
  // The value is a JSON map: { "<lineItemId>": { status, lpa, ... }, ... }
  const metafields = useAppMetafields({ namespace: 'esim', key: 'delivery_tokens' });
  const tokensRaw = metafields?.[0]?.metafield?.value as string | undefined;
  const tokenMap = parseTokenMap(tokensRaw);
  const numericLineItemId = cartLine?.id?.split('/').pop() ?? '';
  const entry: DeliveryMetafieldEntry | undefined = numericLineItemId
    ? tokenMap[numericLineItemId]
    : undefined;

  // Optimistic provisioning state: show spinner while metafield is being written.
  // Only shown for products identified as eSIMs via merchandise metadata —
  // prevents false-positive spinners under non-eSIM line items.
  const looksLikeEsim = isEsimMerchandise(cartLine);
  const [quipIndex, setQuipIndex] = useState(0);
  const isProvisioning = !entry && looksLikeEsim;

  useEffect(() => {
    if (!isProvisioning) return;
    const interval = setInterval(() => {
      setQuipIndex((prev) => (prev + 1) % PROVISIONING_QUIPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [isProvisioning]);

  // Nothing to render if not an eSIM line and no metafield entry
  if (!entry && !looksLikeEsim) return null;

  // ── Optimistic provisioning (metafield not yet written) ───────────────────
  if (isProvisioning) {
    return (
      <BlockStack spacing="tight">
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
              {"Feel free to close this page. We'll email you the details once your eSIM is ready."}
            </Text>
          </BlockStack>
        </Banner>
      </BlockStack>
    );
  }

  // Metafield entry exists — use it as the source of truth
  if (!entry) return null;

  // ── Provisioning from metafield ───────────────────────────────────────────
  if (entry.status === 'provisioning' || entry.status === 'pending') {
    return (
      <BlockStack spacing="tight">
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
              {"Feel free to close this page. We'll email you the details once your eSIM is ready."}
            </Text>
          </BlockStack>
        </Banner>
      </BlockStack>
    );
  }

  // ── Delivered with full credentials ──────────────────────────────────────
  if (entry.status === 'delivered' && entry.lpa) {
    return (
      <BlockStack spacing="base">
        <Divider />
        <Text size="medium" emphasis="bold">
          Your eSIM is ready!
        </Text>

        <QRCode content={entry.lpa} accessibilityLabel="eSIM QR code" size="fill" />

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

        <InlineStack spacing="base">
          <Button
            to={`https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(entry.lpa)}`}
            appearance="primary"
          >
            Install on iPhone
          </Button>
          {entry.usageUrl && (
            <Button to={entry.usageUrl} appearance="secondary">
              View Usage
            </Button>
          )}
        </InlineStack>

        <Text appearance="subdued">
          {"We've also emailed you a copy — check your inbox if you need it later."}
        </Text>
      </BlockStack>
    );
  }

  // ── Delivered but credentials not yet in metafield ────────────────────────
  if (entry.status === 'delivered') {
    return (
      <BlockStack spacing="tight">
        <Banner status="success">
          <BlockStack spacing="base">
            <Text emphasis="bold">Your eSIM is ready!</Text>
            <Text>
              Check your email for the QR code and activation details, or view them in your
              account order history.
            </Text>
          </BlockStack>
        </Banner>
        <InlineStack spacing="base">
          <Button to="https://fluxyfi.com/account/orders" appearance="secondary">
            View in My Account
          </Button>
        </InlineStack>
      </BlockStack>
    );
  }

  if (entry.status === 'failed') {
    return (
      <BlockStack spacing="tight">
        <Banner status="critical">
          <Text>
            eSIM setup encountered an issue. Our team has been notified — please contact support.
          </Text>
        </Banner>
      </BlockStack>
    );
  }

  return null;
}
