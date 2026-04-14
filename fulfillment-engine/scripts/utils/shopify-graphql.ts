/**
 * Shopify GraphQL Client with Variable Support
 * Simpler approach than full SDK - focuses on the key improvement: GraphQL variables
 */
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN!;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

if (!SHOP_DOMAIN) {
  throw new Error('Missing required SHOPIFY_SHOP_DOMAIN environment variable');
}
if (!ACCESS_TOKEN && (!CLIENT_ID || !CLIENT_SECRET)) {
  throw new Error(
    'Missing Shopify auth: set SHOPIFY_ACCESS_TOKEN or both SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET',
  );
}

interface AccessTokenResponse {
  access_token: string;
  scope: string;
}

/**
 * Get access token — uses SHOPIFY_ACCESS_TOKEN directly if set (custom app with permanent token),
 * otherwise falls back to client credentials OAuth flow.
 */
async function getAccessToken(): Promise<string> {
  if (ACCESS_TOKEN) {
    return ACCESS_TOKEN;
  }
  const response = await axios.post<AccessTokenResponse>(
    `https://${SHOP_DOMAIN}/admin/oauth/access_token`,
    {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    },
  );
  return response.data.access_token;
}

/**
 * Execute GraphQL query/mutation with variables
 * This is the key improvement: using variables instead of string interpolation
 */
export async function graphqlQuery<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const accessToken = await getAccessToken();

  const response = await axios.post<T>(
    `https://${SHOP_DOMAIN}/admin/api/2026-04/graphql.json`,
    {
      query,
      variables, // GraphQL variables - safer than string interpolation!
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
    },
  );

  return response.data;
}
