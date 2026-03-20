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
  const res = await axios.post<{ access_token: string; scope: string }>(
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`,
    {
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    },
  );

  console.log('\nSHOPIFY_CLI_THEME_TOKEN=' + res.data.access_token);
  console.log('Scopes: ' + res.data.scope + '\n');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
