import axios from 'axios';
import * as dotenv from 'dotenv';
import type { ShopifyGraphQLResponse } from './shopify-types';

dotenv.config();

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

interface AccessTokenResponse {
  access_token: string;
  scope: string;
}

export async function getAccessToken(): Promise<string> {
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

export async function shopifyGraphQL<T>(query: string): Promise<ShopifyGraphQLResponse<T>> {
  const accessToken = await getAccessToken();

  const response = await axios.post<ShopifyGraphQLResponse<T>>(
    `https://${SHOP_DOMAIN}/admin/api/2026-01/graphql.json`,
    { query },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
    },
  );

  return response.data;
}
