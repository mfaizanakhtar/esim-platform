import axios, { AxiosInstance } from 'axios';
import { logger } from '~/utils/logger';

const SHOPIFY_API_VERSION = '2026-04';

interface ShopifyConfig {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  /** Optional permanent Admin API access token (shpat_...). When provided, bypasses OAuth flow. */
  staticAccessToken?: string;
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
      baseURL: `https://${config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}`,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Get valid access token. If a static token is configured, returns it directly.
   * Otherwise performs OAuth client-credentials refresh.
   */
  private async getAccessToken(): Promise<string> {
    // Static permanent token (shpat_...) — no OAuth needed
    if (this.config.staticAccessToken) {
      return this.config.staticAccessToken;
    }

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
      `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
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
      `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
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
      `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
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

    const fulfillmentId = result?.fulfillment?.id;

    // Mark as delivered immediately — eSIMs are digital goods with instant delivery.
    // Non-fatal: a failure here does not prevent the fulfillment from being recorded.
    if (fulfillmentId) {
      try {
        const eventMutation = `
          mutation fulfillmentEventCreate($fulfillmentEvent: FulfillmentEventInput!) {
            fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
              fulfillmentEvent { id status }
              userErrors { field message }
            }
          }
        `;

        const eventResponse = await axios.post(
          `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
          {
            query: eventMutation,
            variables: {
              fulfillmentEvent: {
                fulfillmentId,
                status: 'DELIVERED',
                happenedAt: new Date().toISOString(),
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

        const graphqlErrors = eventResponse.data?.errors;
        if (graphqlErrors?.length > 0) {
          logger.warn(
            { fulfillmentId, errors: graphqlErrors },
            'fulfillmentEventCreate top-level GraphQL errors (non-fatal)',
          );
        } else {
          const eventResult = eventResponse.data?.data?.fulfillmentEventCreate;
          if (eventResult?.userErrors?.length > 0) {
            logger.warn(
              { fulfillmentId, errors: eventResult.userErrors },
              'fulfillmentEventCreate userErrors (non-fatal)',
            );
          }
        }
      } catch (error) {
        logger.warn(
          { fulfillmentId, err: error },
          'Failed to create DELIVERED fulfillment event (non-fatal)',
        );
      }
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
      `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
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
      `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
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
   * Issue a full refund on a Shopify order (works on fulfilled orders too).
   * Step 1: fetch the order's SALE/CAPTURE transactions and refundable line items.
   * Step 2: call refundCreate directly with transaction amounts (no suggestedRefund needed).
   * Notifies the customer and does not restock (digital goods).
   */
  async cancelShopifyOrder(orderId: string): Promise<void> {
    const token = await this.getAccessToken();
    const gid = `gid://shopify/Order/${orderId}`;
    const headers = { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token };
    const graphql = (query: string, variables: Record<string, unknown>) =>
      axios.post(
        `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        { query, variables },
        { headers },
      );

    // Step 1: Fetch transactions and refundable line items
    // Note: Order.transactions is a plain list in the Shopify Admin API — no pagination args
    const orderRes = await graphql(
      `
        query getOrderForRefund($id: ID!) {
          order(id: $id) {
            lineItems(first: 50) {
              edges {
                node {
                  id
                  refundableQuantity
                }
              }
            }
            transactions {
              id
              kind
              gateway
              status
              amountSet {
                shopMoney {
                  amount
                }
              }
              maximumRefundableV2 {
                amount
              }
            }
          }
        }
      `,
      { id: gid },
    );

    const fetchErrors = orderRes.data?.errors;
    if (fetchErrors?.length > 0) {
      const msg = fetchErrors.map((e: { message: string }) => e.message).join(', ');
      throw new Error(`Shopify order fetch GraphQL errors: ${msg}`);
    }

    const order = orderRes.data?.data?.order;
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    // Build refund line items (no restock — digital goods)
    const refundLineItems = (order.lineItems?.edges ?? [])
      .filter((e: { node: { refundableQuantity: number } }) => e.node.refundableQuantity > 0)
      .map((e: { node: { id: string; refundableQuantity: number } }) => ({
        lineItemId: e.node.id,
        quantity: e.node.refundableQuantity,
        restockType: 'NO_RESTOCK',
      }));

    if (refundLineItems.length === 0) {
      throw new Error(`Order ${orderId} has no refundable line items`);
    }

    // Build transactions: refund against each SUCCESS sale/capture
    logger.info({ orderId, rawTransactions: order.transactions }, 'raw Shopify transactions');

    type RawTx = {
      id: string;
      kind: string;
      gateway: string;
      status: string;
      amountSet?: { shopMoney?: { amount?: string } };
      maximumRefundableV2?: { amount?: string };
    };

    const transactions = ((order.transactions as RawTx[]) ?? [])
      .filter((tx) => ['SALE', 'CAPTURE'].includes(tx.kind) && tx.status === 'SUCCESS')
      .map((tx) => ({
        parentId: tx.id,
        kind: 'REFUND',
        gateway: tx.gateway,
        amount: tx.maximumRefundableV2?.amount ?? tx.amountSet?.shopMoney?.amount ?? '0',
      }))
      .filter((tx) => parseFloat(tx.amount) > 0);

    if (transactions.length === 0) {
      throw new Error(`Order ${orderId} has no refundable transactions`);
    }

    logger.info({ orderId, refundLineItems, transactions }, 'sending refundCreate');

    // Step 2: Apply the refund
    const refundRes = await graphql(
      `
        mutation refundCreate($input: RefundInput!) {
          refundCreate(input: $input) {
            refund {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        input: {
          orderId: gid,
          notify: true,
          note: 'eSIM cancelled at customer request',
          refundLineItems,
          transactions,
        },
      },
    );

    logger.info(
      { orderId, refundCreateResponse: refundRes.data?.data?.refundCreate },
      'refundCreate response',
    );

    // Check top-level GraphQL errors (permission / syntax errors)
    const graphqlErrors = refundRes.data?.errors;
    if (graphqlErrors?.length > 0) {
      const msg = graphqlErrors.map((e: { message: string }) => e.message).join(', ');
      throw new Error(`Shopify refund GraphQL errors: ${msg}`);
    }

    const refundResult = refundRes.data?.data?.refundCreate;
    const userErrors = refundResult?.userErrors ?? [];
    if (userErrors.length > 0) {
      const errors = userErrors.map((e: { message: string }) => e.message).join(', ');
      throw new Error(`Shopify refund errors: ${errors}`);
    }

    // If no refund ID was returned (but also no errors), something silently failed
    if (!refundResult?.refund?.id) {
      logger.error({ orderId, refundResult }, 'refundCreate returned no refund ID');
      throw new Error(`Shopify refundCreate returned no refund ID for order ${orderId}`);
    }

    logger.info(
      { orderId, refundId: refundResult.refund.id },
      'Shopify refund created successfully',
    );
  }

  /**
   * Append a note to a Shopify order (reads current note first to avoid overwriting).
   */
  async appendOrderNote(orderId: string, note: string): Promise<void> {
    const token = await this.getAccessToken();

    const queryResponse = await axios.post(
      `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        query: `query getOrderNote($id: ID!) { order(id: $id) { note } }`,
        variables: { id: `gid://shopify/Order/${orderId}` },
      },
      { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token } },
    );

    const currentNote = (queryResponse.data?.data?.order?.note as string | null) ?? '';
    const updatedNote = currentNote ? `${currentNote}\n---\n${note}` : note;

    const mutationResponse = await axios.post(
      `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
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
      `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
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
      `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
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
      `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
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
   * Batch-lookup variant GID, product GID, and total variant count by SKU.
   * Sends one GraphQL request per 50 SKUs using aliased queries.
   * SKUs not found in Shopify are simply absent from the returned Map.
   */
  async getVariantGidsBySkus(
    skus: string[],
  ): Promise<Map<string, { variantGid: string; productGid: string; productVariantCount: number }>> {
    if (skus.length === 0) return new Map();
    const token = await this.getAccessToken();
    const CHUNK = 50;
    const result = new Map<
      string,
      { variantGid: string; productGid: string; productVariantCount: number }
    >();

    for (let i = 0; i < skus.length; i += CHUNK) {
      const chunk = skus.slice(i, i + CHUNK);
      const aliases = chunk
        .map((sku, idx) => {
          const escaped = sku.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          return `sku_${idx}: productVariants(first: 1, query: "sku:\\"${escaped}\\"") {
            edges { node { id product { id variantsCount { count } } } }
          }`;
        })
        .join('\n');

      const response = await axios.post(
        `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        { query: `query batchGetVariants { ${aliases} }` },
        { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token } },
      );

      const topErrors = response.data?.errors as Array<{ message: string }> | undefined;
      if (topErrors?.length) {
        throw new Error(`Shopify GraphQL errors: ${topErrors.map((e) => e.message).join(', ')}`);
      }
      const data = (response.data?.data ?? {}) as Record<string, unknown>;
      for (let j = 0; j < chunk.length; j++) {
        const alias = data[`sku_${j}`] as
          | {
              edges: Array<{
                node: {
                  id: string;
                  product: { id: string; variantsCount: { count: number } };
                };
              }>;
            }
          | undefined;
        const edge = alias?.edges?.[0];
        if (edge?.node?.id && edge.node.product?.id) {
          result.set(chunk[j], {
            variantGid: edge.node.id,
            productGid: edge.node.product.id,
            productVariantCount: edge.node.product.variantsCount?.count ?? 1,
          });
        }
      }
    }

    return result;
  }

  /**
   * Batch-lookup product GID and total variant count by variant GID.
   * Uses the `nodes` query for direct GID lookup — more reliable than SKU search.
   * Variant GIDs not found (already deleted) are absent from the returned Map.
   */
  async getVariantInfoByGids(
    variantGids: string[],
  ): Promise<Map<string, { variantGid: string; productGid: string; productVariantCount: number }>> {
    if (variantGids.length === 0) return new Map();
    const token = await this.getAccessToken();
    const result = new Map<
      string,
      { variantGid: string; productGid: string; productVariantCount: number }
    >();

    const CHUNK = 50;
    for (let i = 0; i < variantGids.length; i += CHUNK) {
      const chunk = variantGids.slice(i, i + CHUNK);
      const response = await axios.post(
        `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          query: `query getVariantsByIds($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on ProductVariant {
                id
                product { id variantsCount { count } }
              }
            }
          }`,
          variables: { ids: chunk },
        },
        { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token } },
      );

      const topErrors = response.data?.errors as Array<{ message: string }> | undefined;
      if (topErrors?.length) {
        throw new Error(`Shopify GraphQL errors: ${topErrors.map((e) => e.message).join(', ')}`);
      }

      const nodes = (response.data?.data?.nodes ?? []) as Array<{
        id?: string;
        product?: { id: string; variantsCount: { count: number } };
      }>;

      for (const node of nodes) {
        if (node?.id && node.product?.id) {
          result.set(node.id, {
            variantGid: node.id,
            productGid: node.product.id,
            productVariantCount: node.product.variantsCount?.count ?? 1,
          });
        }
      }
    }

    return result;
  }

  /**
   * Delete an entire Shopify product (and all its variants).
   */
  async deleteProduct(productGid: string): Promise<void> {
    const token = await this.getAccessToken();
    const mutation = `
      mutation productDelete($input: ProductDeleteInput!) {
        productDelete(input: $input) {
          deletedProductId
          userErrors { field message }
        }
      }
    `;
    const response = await axios.post(
      `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      { query: mutation, variables: { input: { id: productGid } } },
      { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token } },
    );
    const topErrors = response.data?.errors as Array<{ message: string }> | undefined;
    if (topErrors?.length) {
      throw new Error(`Shopify GraphQL errors: ${topErrors.map((e) => e.message).join(', ')}`);
    }
    const result = response.data?.data?.productDelete as
      | { deletedProductId?: string; userErrors: Array<{ message: string }> }
      | undefined;
    if (result?.userErrors?.length) {
      throw new Error(
        `Shopify productDelete errors: ${result.userErrors.map((e) => e.message).join(', ')}`,
      );
    }
  }

  /**
   * Delete specific variants from a product.
   * Use deleteProduct() instead when removing all variants of a product.
   */
  async deleteVariants(productGid: string, variantGids: string[]): Promise<void> {
    const token = await this.getAccessToken();
    const mutation = `
      mutation productVariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
        productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
          product { id }
          userErrors { field message }
        }
      }
    `;
    const response = await axios.post(
      `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      { query: mutation, variables: { productId: productGid, variantsIds: variantGids } },
      { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token } },
    );
    const topErrors = response.data?.errors as Array<{ message: string }> | undefined;
    if (topErrors?.length) {
      throw new Error(`Shopify GraphQL errors: ${topErrors.map((e) => e.message).join(', ')}`);
    }
    const result = response.data?.data?.productVariantsBulkDelete as
      | { product: unknown; userErrors: Array<{ message: string }> }
      | undefined;
    if (result?.userErrors?.length) {
      throw new Error(
        `Shopify productVariantsBulkDelete errors: ${result.userErrors.map((e) => e.message).join(', ')}`,
      );
    }
  }

  /**
   * Initialize token on startup (optional but recommended)
   */
  async initialize(): Promise<void> {
    await this.getAccessToken();
  }

  /**
   * Fetch all product variants with non-empty SKUs from Shopify.
   * Fetches all variants that have a non-empty SKU.
   * Uses Shopify's `query: "sku:*"` filter to skip blank-SKU option placeholders server-side,
   * avoiding the need to cap at an arbitrary maxVariants limit.
   * Returns { sku, variantId, productTitle, variantTitle }[]
   */
  async getAllVariants(): Promise<
    Array<{ sku: string; variantId: string; productTitle: string; variantTitle: string }>
  > {
    const token = await this.getAccessToken();
    const results: Array<{
      sku: string;
      variantId: string;
      productTitle: string;
      variantTitle: string;
    }> = [];
    let cursor: string | null = null;

    const gqlQuery = `
      query getAllVariants($first: Int!, $after: String) {
        productVariants(first: $first, after: $after, query: "sku:*") {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              sku
              title
              product { title }
            }
          }
        }
      }
    `;

    for (;;) {
      const variantResp = (await axios.post(
        `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        { query: gqlQuery, variables: { first: 250, after: cursor } },
        { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token } },
      )) as {
        data: {
          data: {
            productVariants: {
              pageInfo: { hasNextPage: boolean; endCursor: string };
              edges: Array<{
                node: { id: string; sku: string; title: string; product: { title: string } };
              }>;
            };
          };
        };
      };

      const pv = variantResp.data?.data?.productVariants;
      for (const edge of pv?.edges ?? []) {
        const node = edge.node;
        if (!node.sku) continue; // belt-and-suspenders: skip blank SKUs
        results.push({
          sku: node.sku,
          variantId: node.id,
          productTitle: node.product?.title ?? '',
          variantTitle: node.title ?? '',
        });
      }

      if (!pv?.pageInfo?.hasNextPage) break;
      cursor = pv.pageInfo.endCursor;
    }

    return results;
  }

  /**
   * Create a Shopify product with variants using productCreate + productVariantsBulkCreate.
   * Returns the product GID.
   */
  async createProduct(params: {
    title: string;
    handle: string;
    bodyHtml: string;
    status: 'ACTIVE' | 'DRAFT';
    productType?: string;
    vendor?: string;
    tags?: string[];
    options: string[];
    variants: Array<{
      sku: string;
      price: string;
      optionValues: string[];
    }>;
    imageUrl?: string;
    seo?: { title: string; description: string };
  }): Promise<{ productId: string }> {
    const accessToken = await this.getAccessToken();

    // Step 0: If a product with this handle already exists, delete it (cleanup broken placeholders)
    const existingQuery = `
      query findByHandle($query: String!) {
        products(first: 1, query: $query) {
          nodes { id }
        }
      }
    `;
    const existingResp = await axios.post(
      `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        query: existingQuery,
        variables: { query: `handle:${params.handle}` },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
      },
    );
    const existingProduct = existingResp.data?.data?.products?.nodes?.[0];
    if (existingProduct?.id) {
      logger.info(
        { handle: params.handle, id: existingProduct.id },
        'Deleting existing product before recreate',
      );
      await this.deleteProduct(existingProduct.id);
    }

    // Step 1: Create product with first batch of variants (max 250)
    const mutation = `
      mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
        productCreate(product: $product, media: $media) {
          product { id }
          userErrors { field message }
        }
      }
    `;

    const productInput: Record<string, unknown> = {
      title: params.title,
      handle: params.handle,
      descriptionHtml: params.bodyHtml,
      status: params.status,
      productType: params.productType ?? 'eSIM',
      vendor: params.vendor,
      tags: params.tags ?? [],
      productOptions: params.options.map((name, idx) => ({
        name,
        values: [{ name: params.variants[0]?.optionValues[idx] ?? 'Default' }],
      })),
    };
    const media = params.imageUrl
      ? [{ originalSource: params.imageUrl, mediaContentType: 'IMAGE' }]
      : undefined;

    const createResponse = await axios.post(
      `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      { query: mutation, variables: { product: productInput, media } },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
      },
    );

    const createData = createResponse.data?.data?.productCreate;
    if (createData?.userErrors?.length > 0) {
      throw new Error(
        `productCreate error: ${createData.userErrors.map((e: { message: string }) => e.message).join(', ')}`,
      );
    }

    const productId = createData?.product?.id;
    if (!productId) {
      throw new Error('productCreate returned no product ID');
    }

    // Step 2: Update the default variant (created with the product) with SKU + price
    if (params.variants.length > 0) {
      const firstVariant = params.variants[0];
      const defaultVariantQuery = `
        query getDefaultVariant($productId: ID!) {
          product(id: $productId) {
            variants(first: 1) { nodes { id } }
          }
        }
      `;
      const dvResp = await axios.post(
        `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        { query: defaultVariantQuery, variables: { productId } },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken,
          },
        },
      );
      const defaultVariantId = dvResp.data?.data?.product?.variants?.nodes?.[0]?.id;
      if (defaultVariantId) {
        const updateVariantMutation = `
          mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              productVariants { id }
              userErrors { field message }
            }
          }
        `;
        await axios.post(
          `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
          {
            query: updateVariantMutation,
            variables: {
              productId,
              variants: [
                {
                  id: defaultVariantId,
                  inventoryItem: { sku: firstVariant.sku, tracked: false },
                  inventoryPolicy: 'CONTINUE',
                  price: firstVariant.price,
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
      }

      // Step 3: Bulk create remaining variants (skip the first — it's the default)
      const remainingVariants = params.variants.slice(1);
      const variantMutation = `
        mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            productVariants { id }
            userErrors { field message }
          }
        }
      `;

      const BATCH_SIZE = 250;
      for (let i = 0; i < remainingVariants.length; i += BATCH_SIZE) {
        const batch = remainingVariants.slice(i, i + BATCH_SIZE);
        const variantInputs = batch.map((v) => ({
          inventoryItem: { sku: v.sku, tracked: false },
          inventoryPolicy: 'CONTINUE',
          price: v.price,
          optionValues: v.optionValues.map((val, idx) => ({
            optionName: params.options[idx],
            name: val,
          })),
        }));

        const variantResponse = await axios.post(
          `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
          {
            query: variantMutation,
            variables: { productId, variants: variantInputs },
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Access-Token': accessToken,
            },
          },
        );

        const variantData = variantResponse.data?.data?.productVariantsBulkCreate;
        if (variantData?.userErrors?.length > 0) {
          logger.error(
            { productId, errors: variantData.userErrors, batch: i },
            'Variant creation failed',
          );
          throw new Error(`Variant creation failed: ${JSON.stringify(variantData.userErrors)}`);
        }
      }
    }

    // Step 4: Apply SEO via productUpdate (productCreate doesn't reliably support seo)
    if (params.seo) {
      await this.updateProduct({ productId, seo: params.seo });
    }

    return { productId };
  }

  /* v8 ignore start — updateProduct tested via integration */
  async updateProduct(params: {
    productId: string;
    title?: string;
    descriptionHtml?: string;
    status?: 'ACTIVE' | 'DRAFT';
    tags?: string[];
    vendor?: string;
    seo?: { title: string; description: string };
  }): Promise<void> {
    const accessToken = await this.getAccessToken();

    const mutation = `
      mutation productUpdate($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id }
          userErrors { field message }
        }
      }
    `;

    const input: Record<string, unknown> = { id: params.productId };
    if (params.title !== undefined) input.title = params.title;
    if (params.descriptionHtml !== undefined) input.descriptionHtml = params.descriptionHtml;
    if (params.status !== undefined) input.status = params.status;
    if (params.tags !== undefined) input.tags = params.tags;
    if (params.vendor !== undefined) input.vendor = params.vendor;
    if (params.seo) input.seo = { title: params.seo.title, description: params.seo.description };

    const response = await axios.post(
      `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      { query: mutation, variables: { input } },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
      },
    );

    if (response.data?.errors) {
      throw new Error(`productUpdate GraphQL error: ${JSON.stringify(response.data.errors)}`);
    }

    const data = response.data?.data?.productUpdate;
    if (data?.userErrors?.length > 0) {
      throw new Error(
        `productUpdate error: ${data.userErrors.map((e: { message: string }) => e.message).join(', ')}`,
      );
    }
  }
  /* v8 ignore stop */
  async updateVariantPrices(
    productId: string,
    variants: Array<{ variantId: string; price: string }>,
  ): Promise<void> {
    const accessToken = await this.getAccessToken();

    const mutation = `
      mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id }
          userErrors { field message }
        }
      }
    `;

    const variantInputs = variants.map((v) => ({
      id: v.variantId,
      price: v.price,
    }));

    const response = await axios.post(
      `https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      { query: mutation, variables: { productId, variants: variantInputs } },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
      },
    );

    if (response.data?.errors) {
      throw new Error(`updateVariantPrices GraphQL error: ${JSON.stringify(response.data.errors)}`);
    }

    const data = response.data?.data?.productVariantsBulkUpdate;
    if (data?.userErrors?.length > 0) {
      throw new Error(
        `updateVariantPrices error: ${data.userErrors.map((e: { message: string }) => e.message).join(', ')}`,
      );
    }
  }
}

// Singleton instance
let shopifyClient: ShopifyClient | null = null;

export function getShopifyClient(): ShopifyClient {
  if (!shopifyClient) {
    const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
    const staticAccessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!shopDomain) {
      throw new Error('Missing SHOPIFY_SHOP_DOMAIN environment variable');
    }

    // Support two auth modes:
    // 1. Permanent token (shpat_...): set SHOPIFY_ACCESS_TOKEN — no OAuth needed
    // 2. OAuth client credentials: requires SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
    if (!staticAccessToken && (!clientId || !clientSecret)) {
      throw new Error(
        'Shopify auth not configured: set SHOPIFY_ACCESS_TOKEN or both SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET',
      );
    }

    shopifyClient = new ShopifyClient({
      shopDomain,
      clientId: clientId ?? '',
      clientSecret: clientSecret ?? '',
      staticAccessToken,
    });
  }

  return shopifyClient;
}
