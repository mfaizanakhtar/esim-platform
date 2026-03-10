/**
 * Shopify GraphQL Client with Variable Support
 * Simpler approach than full SDK - focuses on the key improvement: GraphQL variables
 */
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN!;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID!;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET!;

if (!SHOP_DOMAIN || !CLIENT_ID || !CLIENT_SECRET) {
  throw new Error('Missing required Shopify environment variables');
}

interface AccessTokenResponse {
  access_token: string;
  scope: string;
}

/**
 * Get access token using client credentials
 */
async function getAccessToken(): Promise<string> {
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
    `https://${SHOP_DOMAIN}/admin/api/2026-01/graphql.json`,
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
