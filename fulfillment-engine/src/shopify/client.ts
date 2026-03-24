import axios, { AxiosInstance } from 'axios';
import { logger } from '~/utils/logger';

interface ShopifyConfig {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
}

export interface DeliveryMetafieldEntry {
  status: 'provisioning' | 'delivered' | 'cancelled' | 'failed';
  accessToken?: string;
  lpa?: string;
  activationCode?: string;
  iccid?: string;
  usageUrl?: string;
  isTopup?: boolean;
}

interface TokenResponse {
  access_token: string;
  scope: string;
  expires_in: number;
}

/**
 * Shopify Admin API client with automatic token refresh
 * Uses client credentials grant (OAuth 2.0)
 */
export class ShopifyClient {
  private config: ShopifyConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private refreshPromise: Promise<string> | null = null;
  private axiosInstance: AxiosInstance;

  constructor(config: ShopifyConfig) {
    this.config = config;
    this.axiosInstance = axios.create({
      baseURL: `https://${config.shopDomain}/admin/api/2026-01`,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Get valid access token, refresh if needed
   */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();

    // Token still valid (with 5min buffer)
    if (this.accessToken && this.tokenExpiresAt > now + 5 * 60 * 1000) {
      return this.accessToken;
    }

    // Another request is already refreshing
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    // Refresh token
    this.refreshPromise = this.refreshAccessToken();
    try {
      const token = await this.refreshPromise;
      return token;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Exchange client credentials for access token
   */
  private async refreshAccessToken(): Promise<string> {
    try {
      const response = await axios.post<TokenResponse>(
        `https://${this.config.shopDomain}/admin/oauth/access_token`,
        new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      this.accessToken = response.data.access_token;
      this.tokenExpiresAt = Date.now() + response.data.expires_in * 1000;

      logger.info({ expiresIn: response.data.expires_in }, 'Access token refreshed');
      return this.accessToken;
    } catch (error) {
      logger.error({ err: error }, 'Failed to refresh access token');
      throw new Error('Failed to authenticate with Shopify');
    }
  }

  /**
   * Get order details by order ID
   */
  async getOrder(orderId: string): Promise<unknown> {
    const token = await this.getAccessToken();
    const response = await this.axiosInstance.get(`/orders/${orderId}.json`, {
      headers: {
        'X-Shopify-Access-Token': token,
      },
    });
    return response.data.order;
  }

  /**
   * Get variant metafields using GraphQL (better permission handling)
   */
  async getVariantMetafields(variantId: string): Promise<unknown[]> {
    const token = await this.getAccessToken();

    const query = `
      query getVariantMetafields($id: ID!) {
        productVariant(id: $id) {
          metafields(first: 20) {
            edges {
              node {
                namespace
                key
                value
                type
              }
            }
          }
        }
      }
    `;

    const response = await axios.post(
      `https://${this.config.shopDomain}/admin/api/2026-01/graphql.json`,
      {
        query,
        variables: {
          id: `gid://shopify/ProductVariant/${variantId}`,
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
      },
    );

    const edges = response.data?.data?.productVariant?.metafields?.edges || [];
    return edges.map((edge: { node: unknown }) => edge.node);
  }

  /**
   * Create fulfillment for an order using GraphQL
   * Uses the modern fulfillmentCreate mutation
   */
  async createFulfillment(orderId: string): Promise<unknown> {
    const token = await this.getAccessToken();

    // Step 1: Get the fulfillment order ID
    const queryFulfillmentOrders = `
      query getFulfillmentOrders($id: ID!) {
        order(id: $id) {
          fulfillmentOrders(first: 10) {
            edges {
              node {
                id
                status
                requestStatus
              }
            }
          }
        }
      }
    `;

    const queryResponse = await axios.post(
      `https://${this.config.shopDomain}/admin/api/2026-01/graphql.json`,
      {
        query: queryFulfillmentOrders,
        variables: {
          id: `gid://shopify/Order/${orderId}`,
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
      },
    );

    // Check for GraphQL errors
    if (queryResponse.data?.errors) {
      logger.error({ errors: queryResponse.data.errors }, 'GraphQL errors');
      throw new Error(`GraphQL errors: ${JSON.stringify(queryResponse.data.errors)}`);
    }

    const order = queryResponse.data?.data?.order;

    if (!order) {
      logger.error({ orderId, response: queryResponse.data }, 'Order not found');
      throw new Error(`Order not found: ${orderId}. Check if order ID is correct.`);
    }

    const fulfillmentOrders = order.fulfillmentOrders?.edges || [];

    logger.info({ orderId, count: fulfillmentOrders.length }, 'Found fulfillment orders');

    if (fulfillmentOrders.length === 0) {
      throw new Error(
        `No fulfillment orders found for order ${orderId}. Order may not be ready for fulfillment.`,
      );
    }

    // Find a fulfillable order (status: OPEN, SCHEDULED, or IN_PROGRESS)
    const fulfillableStatuses = ['OPEN', 'SCHEDULED', 'IN_PROGRESS'];
    const fulfillableOrder = fulfillmentOrders.find((edge: { node: { status: string } }) =>
      fulfillableStatuses.includes(edge.node.status),
    );

    if (!fulfillableOrder) {
      const statuses = fulfillmentOrders.map((e: { node: { status: string } }) => e.node.status);
      throw new Error(
        `No fulfillable orders found. Order statuses: ${statuses.join(', ')}. Order may already be fulfilled.`,
      );
    }

    const fulfillmentOrderId = fulfillableOrder.node.id;

    logger.info({ orderId, fulfillmentOrderId }, 'Creating fulfillment');

    // Step 2: Create the fulfillment (fulfills all items in the fulfillment order)
    const mutation = `
      mutation fulfillmentCreate($fulfillment: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $fulfillment) {
          fulfillment {
            id
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const mutationResponse = await axios.post(
      `https://${this.config.shopDomain}/admin/api/2026-01/graphql.json`,
      {
        query: mutation,
        variables: {
          fulfillment: {
            lineItemsByFulfillmentOrder: [
              {
                fulfillmentOrderId: fulfillmentOrderId,
              },
            ],
            notifyCustomer: false,
          },
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
      },
    );

    const result = mutationResponse.data?.data?.fulfillmentCreate;

    if (result?.userErrors && result.userErrors.length > 0) {
      const errors = result.userErrors.map((e: { message: string }) => e.message).join(', ');
      throw new Error(`Shopify fulfillment errors: ${errors}`);
    }

    return result?.fulfillment;
  }

  /**
   * Write a delivery access token into the order's "esim.delivery_tokens" metafield.
   *
   * All eSIM tokens for an order are stored as a single JSON object keyed by lineItemId:
   *   { "<lineItemId>": "<accessToken>", "<lineItemId2>": "<accessToken2>" }
   *
   * This allows the Customer Account UI Extension to declare one static metafield key
   * ("delivery_tokens") and look up the right token by matching the current line item ID.
   *
   * We read the existing value first and merge, so multiple line items in one order
   * accumulate their tokens without overwriting each other.
   */
  async writeDeliveryMetafield(
    orderId: string,
    lineItemId: string,
    entry: DeliveryMetafieldEntry,
  ): Promise<void> {
    const accessToken = await this.getAccessToken();

    // Step 1: Read existing delivery_tokens metafield (if any)
    const queryMetafield = `
      query getOrderMetafield($id: ID!, $namespace: String!, $key: String!) {
        order(id: $id) {
          metafield(namespace: $namespace, key: $key) {
            id
            value
          }
        }
      }
    `;

    const queryResponse = await axios.post(
      `https://${this.config.shopDomain}/admin/api/2026-01/graphql.json`,
      {
        query: queryMetafield,
        variables: {
          id: `gid://shopify/Order/${orderId}`,
          namespace: 'esim',
          key: 'delivery_tokens',
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
      },
    );

    // Step 2: Merge new entry into existing map
    const existing = queryResponse.data?.data?.order?.metafield?.value;
    let tokenMap: Record<string, DeliveryMetafieldEntry> = {};
    if (existing) {
      try {
        tokenMap = JSON.parse(existing) as Record<string, DeliveryMetafieldEntry>;
      } catch {
        // ignore malformed existing value
      }
    }
    tokenMap[lineItemId] = entry;

    // Step 3: Write merged map back
    const mutation = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key }
          userErrors { field message }
        }
      }
    `;

    const mutationResponse = await axios.post(
      `https://${this.config.shopDomain}/admin/api/2026-01/graphql.json`,
      {
        query: mutation,
        variables: {
          metafields: [
            {
              ownerId: `gid://shopify/Order/${orderId}`,
              namespace: 'esim',
              key: 'delivery_tokens',
              value: JSON.stringify(tokenMap),
              type: 'json',
            },
          ],
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
      },
    );

    const result = mutationResponse.data?.data?.metafieldsSet;
    if (result?.userErrors?.length > 0) {
      const errors = result.userErrors.map((e: { message: string }) => e.message).join(', ');
      throw new Error(`Shopify metafield write errors: ${errors}`);
    }
  }

  /**
   * Cancel a Shopify order and issue a full refund.
   * Used by the eSIM cancel flow after the vendor has confirmed the eSIM is not yet activated.
   */
  async cancelShopifyOrder(orderId: string): Promise<void> {
    const token = await this.getAccessToken();

    const mutation = `
      mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!, $notifyCustomer: Boolean!) {
        orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock, notifyCustomer: $notifyCustomer) {
          orderCancelUserErrors {
            field
            message
          }
          job {
            id
          }
        }
      }
    `;

    const response = await axios.post(
      `https://${this.config.shopDomain}/admin/api/2026-01/graphql.json`,
      {
        query: mutation,
        variables: {
          orderId: `gid://shopify/Order/${orderId}`,
          reason: 'CUSTOMER',
          refund: true,
          restock: false,
          notifyCustomer: true,
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
      },
    );

    const result = response.data?.data?.orderCancel;
    if (result?.orderCancelUserErrors?.length > 0) {
      const errors = result.orderCancelUserErrors
        .map((e: { message: string }) => e.message)
        .join(', ');
      throw new Error(`Shopify order cancel errors: ${errors}`);
    }
  }

  /**
   * Append a note to a Shopify order (reads current note first to avoid overwriting).
   */
  async appendOrderNote(orderId: string, note: string): Promise<void> {
    const token = await this.getAccessToken();

    const queryResponse = await axios.post(
      `https://${this.config.shopDomain}/admin/api/2026-01/graphql.json`,
      {
        query: `query getOrderNote($id: ID!) { order(id: $id) { note } }`,
        variables: { id: `gid://shopify/Order/${orderId}` },
      },
      { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token } },
    );

    const currentNote = (queryResponse.data?.data?.order?.note as string | null) ?? '';
    const updatedNote = currentNote ? `${currentNote}\n---\n${note}` : note;

    const mutationResponse = await axios.post(
      `https://${this.config.shopDomain}/admin/api/2026-01/graphql.json`,
      {
        query: `
          mutation orderUpdate($input: OrderInput!) {
            orderUpdate(input: $input) {
              order { id }
              userErrors { field message }
            }
          }
        `,
        variables: { input: { id: `gid://shopify/Order/${orderId}`, note: updatedNote } },
      },
      { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token } },
    );

    const errors = mutationResponse.data?.data?.orderUpdate?.userErrors;
    if (errors?.length > 0) {
      throw new Error(
        `Order note update errors: ${errors.map((e: { message: string }) => e.message).join(', ')}`,
      );
    }
  }

  /**
   * Add tags to a Shopify order.
   */
  async addOrderTags(orderId: string, tags: string[]): Promise<void> {
    const token = await this.getAccessToken();

    const response = await axios.post(
      `https://${this.config.shopDomain}/admin/api/2026-01/graphql.json`,
      {
        query: `
          mutation tagsAdd($id: ID!, $tags: [String!]!) {
            tagsAdd(id: $id, tags: $tags) {
              node { id }
              userErrors { message }
            }
          }
        `,
        variables: { id: `gid://shopify/Order/${orderId}`, tags },
      },
      { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token } },
    );

    const errors = response.data?.data?.tagsAdd?.userErrors;
    if (errors?.length > 0) {
      throw new Error(
        `Order tag errors: ${errors.map((e: { message: string }) => e.message).join(', ')}`,
      );
    }
  }

  /**
   * Look up a Shopify product variant GID by SKU string.
   * Returns null if no variant with that SKU exists.
   */
  async getVariantGidBySku(sku: string): Promise<string | null> {
    const token = await this.getAccessToken();

    const response = await axios.post(
      `https://${this.config.shopDomain}/admin/api/2026-01/graphql.json`,
      {
        query: `
          query getVariantBySku($query: String!) {
            productVariants(first: 1, query: $query) {
              edges { node { id } }
            }
          }
        `,
        variables: { query: `sku:${sku}` },
      },
      { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token } },
    );

    const edge = response.data?.data?.productVariants?.edges?.[0];
    return edge?.node?.id ?? null;
  }

  /**
   * Create a Shopify draft order for a top-up checkout.
   * Embeds the existing ICCID as a hidden line item custom attribute (_iccid).
   * Returns the draft order's hosted checkout URL (invoiceUrl).
   */
  async createDraftOrder(
    variantGid: string,
    iccid: string,
    customerEmail: string,
  ): Promise<{ checkoutUrl: string }> {
    const token = await this.getAccessToken();

    const mutation = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            invoiceUrl
          }
          userErrors { field message }
        }
      }
    `;

    const response = await axios.post(
      `https://${this.config.shopDomain}/admin/api/2026-01/graphql.json`,
      {
        query: mutation,
        variables: {
          input: {
            lineItems: [{ variantId: variantGid, quantity: 1 }],
            customAttributes: [{ key: '_iccid', value: iccid }],
            email: customerEmail,
          },
        },
      },
      { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token } },
    );

    const result = response.data?.data?.draftOrderCreate;
    if (result?.userErrors?.length > 0) {
      const errors = result.userErrors.map((e: { message: string }) => e.message).join(', ');
      throw new Error(`Shopify draftOrderCreate errors: ${errors}`);
    }

    const checkoutUrl = result?.draftOrder?.invoiceUrl;
    if (!checkoutUrl) {
      throw new Error('Shopify draftOrderCreate returned no invoiceUrl');
    }

    return { checkoutUrl };
  }

  /**
   * Initialize token on startup (optional but recommended)
   */
  async initialize(): Promise<void> {
    await this.getAccessToken();
  }
}

// Singleton instance
let shopifyClient: ShopifyClient | null = null;

export function getShopifyClient(): ShopifyClient {
  if (!shopifyClient) {
    const config = {
      shopDomain: process.env.SHOPIFY_SHOP_DOMAIN!,
      clientId: process.env.SHOPIFY_CLIENT_ID!,
      clientSecret: process.env.SHOPIFY_CLIENT_SECRET!,
    };

    if (!config.shopDomain || !config.clientId || !config.clientSecret) {
      throw new Error('Missing Shopify credentials in environment variables');
    }

    shopifyClient = new ShopifyClient(config);
  }

  return shopifyClient;
}
