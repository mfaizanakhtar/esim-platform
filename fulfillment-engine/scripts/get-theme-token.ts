/**
 * Get a short-lived Shopify Admin API access token with write_themes scope.
 * Use the output as SHOPIFY_CLI_THEME_TOKEN for local theme push/pull.
 *
 * Usage:
 *   npx ts-node scripts/get-theme-token.ts
 *
 * Requires in .env:
 *   SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
 */
import * as dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const { SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = process.env;

if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
  console.error(
    'Missing required env vars: SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET',
  );
  process.exit(1);
}

async function main() {
  const body = new URLSearchParams({
    client_id: SHOPIFY_CLIENT_ID!,
    client_secret: SHOPIFY_CLIENT_SECRET!,
    grant_type: 'client_credentials',
  });

  const res = await axios.post<{ access_token: string; scope: string }>(
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`,
    body.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 },
  );

  // Mask the token in CI logs to prevent credential leakage
  if (process.env.CI) {
    console.log(`::add-mask::${res.data.access_token}`);
  }

  console.log(`\nSHOPIFY_CLI_THEME_TOKEN=${res.data.access_token}`);
  console.log(`Scopes: ${res.data.scope}\n`);
}

main().catch((err: unknown) => {
  const message = axios.isAxiosError(err)
    ? `Token request failed: ${err.response?.status ?? 'unknown'} ${err.response?.statusText ?? ''}`.trim()
    : `Unexpected error: ${String(err)}`;
  console.error(message);
  process.exit(1);
});
