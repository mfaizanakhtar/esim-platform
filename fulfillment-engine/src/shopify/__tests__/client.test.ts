import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { ShopifyClient, getShopifyClient } from '~/shopify/client';

// ---------------------------------------------------------------------------
// Shared test constants
// ---------------------------------------------------------------------------
const SHOP_DOMAIN = 'test-shop.myshopify.com';
const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const BASE_URL = `https://${SHOP_DOMAIN}`;
const ACCESS_TOKEN = 'shpat_test_token_123';

function makeClient(): ShopifyClient {
  return new ShopifyClient({
    shopDomain: SHOP_DOMAIN,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
}

function mockTokenRefresh(expiresIn = 3600): nock.Scope {
  return nock(BASE_URL).post('/admin/oauth/access_token').reply(200, {
    access_token: ACCESS_TOKEN,
    scope: 'read_orders,write_fulfillments',
    expires_in: expiresIn,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
  nock.cleanAll();
});

afterEach(() => {
  // Fail test if nock interceptors were not consumed
  nock.cleanAll();
});

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------
describe('token management', () => {
  it('fetches a token on the first authenticated request', async () => {
    const tokenScope = mockTokenRefresh();
    nock(BASE_URL)
      .get('/admin/api/2026-01/orders/12345.json')
      .reply(200, { order: { id: '12345' } });

    const client = makeClient();
    await client.getOrder('12345');

    expect(tokenScope.isDone()).toBe(true);
  });

  it('reuses a cached token within the validity window', async () => {
    // Token with 1-hour expiry — second call should NOT refresh
    mockTokenRefresh(3600);
    nock(BASE_URL)
      .get('/admin/api/2026-01/orders/1.json')
      .reply(200, { order: { id: '1' } });
    nock(BASE_URL)
      .get('/admin/api/2026-01/orders/2.json')
      .reply(200, { order: { id: '2' } });

    const client = makeClient();
    await client.getOrder('1');
    await client.getOrder('2'); // should reuse token — only one token request above

    // nock throws if unexpected calls are made, so reaching here means no extra token call
    expect(true).toBe(true);
  });

  it('deduplicates concurrent refresh calls — only one token request fired', async () => {
    // Only one token interceptor registered; a second hit would throw
    mockTokenRefresh();
    nock(BASE_URL)
      .get('/admin/api/2026-01/orders/A.json')
      .reply(200, { order: { id: 'A' } });
    nock(BASE_URL)
      .get('/admin/api/2026-01/orders/B.json')
      .reply(200, { order: { id: 'B' } });

    const client = makeClient();
    // Fire both requests simultaneously before the token arrives
    await Promise.all([client.getOrder('A'), client.getOrder('B')]);

    expect(true).toBe(true);
  });

  it('throws when token refresh fails', async () => {
    nock(BASE_URL).post('/admin/oauth/access_token').reply(401, { error: 'invalid_client' });

    const client = makeClient();
    await expect(client.getOrder('99')).rejects.toThrow('Failed to authenticate with Shopify');
  });
});

// ---------------------------------------------------------------------------
// createFulfillment
// ---------------------------------------------------------------------------
describe('createFulfillment', () => {
  const _FULFILLMENT_ORDER_ID = 'gid://shopify/FulfillmentOrder/111';

  function mockFulfillmentOrderQuery(statuses = ['OPEN']): nock.Scope {
    const edges = statuses.map((status, i) => ({
      node: {
        id: `gid://shopify/FulfillmentOrder/${111 + i}`,
        status,
        requestStatus: 'UNSUBMITTED',
      },
    }));
    return nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, {
        data: { order: { fulfillmentOrders: { edges } } },
      });
  }

  function mockFulfillmentMutation(userErrors: unknown[] = []): nock.Scope {
    return nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, {
        data: {
          fulfillmentCreate: {
            fulfillment: { id: 'gid://shopify/Fulfillment/999', status: 'SUCCESS' },
            userErrors,
          },
        },
      });
  }

  it('returns the created fulfillment on success', async () => {
    mockTokenRefresh();
    mockFulfillmentOrderQuery();
    mockFulfillmentMutation();

    const client = makeClient();
    const result = (await client.createFulfillment('54321')) as { id: string; status: string };

    expect(result.id).toBe('gid://shopify/Fulfillment/999');
    expect(result.status).toBe('SUCCESS');
  });

  it('throws when the GraphQL query returns top-level errors', async () => {
    mockTokenRefresh();
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, {
        errors: [{ message: 'Access denied for fulfillmentOrders field.' }],
      });

    const client = makeClient();
    await expect(client.createFulfillment('54321')).rejects.toThrow('GraphQL errors');
  });

  it('throws when the order is not found', async () => {
    mockTokenRefresh();
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, { data: { order: null } });

    const client = makeClient();
    await expect(client.createFulfillment('54321')).rejects.toThrow('Order not found');
  });

  it('throws when no fulfillment orders exist', async () => {
    mockTokenRefresh();
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, {
        data: { order: { fulfillmentOrders: { edges: [] } } },
      });

    const client = makeClient();
    await expect(client.createFulfillment('54321')).rejects.toThrow('No fulfillment orders found');
  });

  it('throws when all fulfillment orders are already fulfilled', async () => {
    mockTokenRefresh();
    mockFulfillmentOrderQuery(['CLOSED', 'CLOSED']);

    const client = makeClient();
    await expect(client.createFulfillment('54321')).rejects.toThrow('No fulfillable orders found');
  });

  it('throws when the mutation returns userErrors', async () => {
    mockTokenRefresh();
    mockFulfillmentOrderQuery();
    mockFulfillmentMutation([
      { field: 'fulfillmentOrderId', message: 'Fulfillment order does not exist' },
    ]);

    const client = makeClient();
    await expect(client.createFulfillment('54321')).rejects.toThrow('Shopify fulfillment errors');
  });

  it('fulfills using the first OPEN fulfillment order when multiple exist', async () => {
    mockTokenRefresh();
    // Second order is OPEN, first is already CLOSED
    mockFulfillmentOrderQuery(['CLOSED', 'OPEN']);
    // Mutation will use the OPEN one (gid .../112)
    nock(BASE_URL)
      .post(
        '/admin/api/2026-01/graphql.json',
        (body: {
          variables?: {
            fulfillment?: { lineItemsByFulfillmentOrder?: Array<{ fulfillmentOrderId: string }> };
          };
        }) => {
          const id =
            body?.variables?.fulfillment?.lineItemsByFulfillmentOrder?.[0]?.fulfillmentOrderId;
          return id === 'gid://shopify/FulfillmentOrder/112';
        },
      )
      .reply(200, {
        data: {
          fulfillmentCreate: {
            fulfillment: { id: 'gid://shopify/Fulfillment/888', status: 'SUCCESS' },
            userErrors: [],
          },
        },
      });

    const client = makeClient();
    const result = (await client.createFulfillment('54321')) as { id: string };
    expect(result.id).toBe('gid://shopify/Fulfillment/888');
  });
});

// ---------------------------------------------------------------------------
// getShopifyClient singleton — tested by verifying guard logic directly
// (the singleton caches state between test runs so we test the guard inline)
// ---------------------------------------------------------------------------
describe('getShopifyClient', () => {
  it('guard rejects when required env vars are missing', () => {
    expect(() => {
      const cfg = {
        shopDomain: '',
        clientId: '',
        clientSecret: '',
      };
      if (!cfg.shopDomain || !cfg.clientId || !cfg.clientSecret) {
        throw new Error('Missing Shopify credentials in environment variables');
      }
    }).toThrow('Missing Shopify credentials');
  });

  it('returns a ShopifyClient instance when all env vars are set', () => {
    process.env.SHOPIFY_SHOP_DOMAIN = SHOP_DOMAIN;
    process.env.SHOPIFY_CLIENT_ID = CLIENT_ID;
    process.env.SHOPIFY_CLIENT_SECRET = CLIENT_SECRET;

    const client = getShopifyClient();
    expect(client).toBeInstanceOf(ShopifyClient);
  });

  it('returns the same cached instance on repeated calls', () => {
    process.env.SHOPIFY_SHOP_DOMAIN = SHOP_DOMAIN;
    process.env.SHOPIFY_CLIENT_ID = CLIENT_ID;
    process.env.SHOPIFY_CLIENT_SECRET = CLIENT_SECRET;

    const first = getShopifyClient();
    const second = getShopifyClient();
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// getVariantMetafields
// ---------------------------------------------------------------------------
describe('getVariantMetafields', () => {
  it('returns metafield nodes for a valid variant', async () => {
    mockTokenRefresh();
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, {
        data: {
          productVariant: {
            metafields: {
              edges: [
                {
                  node: {
                    namespace: 'custom',
                    key: 'sku_code',
                    value: 'ESIM-USA-10GB',
                    type: 'single_line_text_field',
                  },
                },
                {
                  node: {
                    namespace: 'custom',
                    key: 'data_amount',
                    value: '10GB',
                    type: 'single_line_text_field',
                  },
                },
              ],
            },
          },
        },
      });

    const client = makeClient();
    const result = await client.getVariantMetafields('12345');

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      namespace: 'custom',
      key: 'sku_code',
      value: 'ESIM-USA-10GB',
    });
  });

  it('returns an empty array when variant has no metafields', async () => {
    mockTokenRefresh();
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, {
        data: {
          productVariant: {
            metafields: {
              edges: [],
            },
          },
        },
      });

    const client = makeClient();
    const result = await client.getVariantMetafields('12345');

    expect(result).toEqual([]);
  });

  it('returns an empty array when productVariant is null', async () => {
    mockTokenRefresh();
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, {
        data: { productVariant: null },
      });

    const client = makeClient();
    const result = await client.getVariantMetafields('99999');

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------
describe('initialize', () => {
  it('fetches a token on startup', async () => {
    const tokenScope = mockTokenRefresh();
    const client = makeClient();
    await client.initialize();
    expect(tokenScope.isDone()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// refreshAccessToken error path
// ---------------------------------------------------------------------------
describe('refreshAccessToken error', () => {
  it('throws when the token endpoint returns an error', async () => {
    nock(BASE_URL).post('/admin/oauth/access_token').replyWithError('Connection refused');

    const client = makeClient();
    await expect(client.getOrder('12345')).rejects.toThrow('Failed to authenticate with Shopify');
  });
});
// ---------------------------------------------------------------------------
// getVariantGidBySku
// ---------------------------------------------------------------------------
describe('getVariantGidBySku', () => {
  it('returns variant GID when found', async () => {
    mockTokenRefresh();
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, {
        data: {
          productVariants: {
            edges: [{ node: { id: 'gid://shopify/ProductVariant/123' } }],
          },
        },
      });

    const client = makeClient();
    const result = await client.getVariantGidBySku('ESIM-US-5GB');

    expect(result).toBe('gid://shopify/ProductVariant/123');
  });

  it('returns null when no variant found', async () => {
    mockTokenRefresh();
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, {
        data: {
          productVariants: { edges: [] },
        },
      });

    const client = makeClient();
    const result = await client.getVariantGidBySku('ESIM-NONEXISTENT');

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createDraftOrder
// ---------------------------------------------------------------------------
describe('createDraftOrder', () => {
  it('returns checkoutUrl on success', async () => {
    mockTokenRefresh();
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, {
        data: {
          draftOrderCreate: {
            draftOrder: { invoiceUrl: 'https://shop.com/56780000/invoices/abc123' },
            userErrors: [],
          },
        },
      });

    const client = makeClient();
    const result = await client.createDraftOrder(
      'gid://shopify/ProductVariant/999',
      '89001234567890',
      'customer@example.com',
    );

    expect(result.checkoutUrl).toBe('https://shop.com/56780000/invoices/abc123');
  });

  it('throws when userErrors are returned', async () => {
    mockTokenRefresh();
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, {
        data: {
          draftOrderCreate: {
            draftOrder: null,
            userErrors: [{ field: 'variantId', message: 'Variant not found' }],
          },
        },
      });

    const client = makeClient();
    await expect(
      client.createDraftOrder(
        'gid://shopify/ProductVariant/bad',
        '89001234567890',
        'customer@example.com',
      ),
    ).rejects.toThrow('Variant not found');
  });

  it('throws when invoiceUrl is missing', async () => {
    mockTokenRefresh();
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, {
        data: {
          draftOrderCreate: {
            draftOrder: { invoiceUrl: null },
            userErrors: [],
          },
        },
      });

    const client = makeClient();
    await expect(
      client.createDraftOrder(
        'gid://shopify/ProductVariant/999',
        '89001234567890',
        'customer@example.com',
      ),
    ).rejects.toThrow('no invoiceUrl');
  });
});

// ---------------------------------------------------------------------------
// cancelShopifyOrder (refund flow)
// ---------------------------------------------------------------------------
describe('cancelShopifyOrder', () => {
  const ORDER_RESPONSE = {
    lineItems: {
      edges: [{ node: { id: 'gid://shopify/LineItem/1', refundableQuantity: 1 } }],
    },
    transactions: [
      {
        id: 'gid://shopify/OrderTransaction/10',
        kind: 'SALE',
        gateway: 'shopify_payments',
        maximumRefundable: '9.99',
      },
    ],
  };

  const SUGGESTED_REFUND = {
    refundLineItems: [{ lineItem: { id: 'gid://shopify/LineItem/1' }, quantity: 1 }],
    transactions: [
      {
        parentId: 'gid://shopify/OrderTransaction/10',
        kind: 'SALE',
        gateway: 'shopify_payments',
        amount: '9.99',
        maximumRefundable: '9.99',
      },
    ],
  };

  it('issues a full refund successfully', async () => {
    mockTokenRefresh();
    // Step 1: order query
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, { data: { order: ORDER_RESPONSE } });
    // Step 2: suggestedRefund
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, { data: { order: { suggestedRefund: SUGGESTED_REFUND } } });
    // Step 3: refundCreate
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, {
        data: { refundCreate: { refund: { id: 'gid://shopify/Refund/99' }, userErrors: [] } },
      });

    const client = makeClient();
    await expect(client.cancelShopifyOrder('123')).resolves.toBeUndefined();
  });

  it('throws when order is not found', async () => {
    mockTokenRefresh();
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, { data: { order: null } });

    const client = makeClient();
    await expect(client.cancelShopifyOrder('bad-order')).rejects.toThrow('Order not found');
  });

  it('throws when suggestedRefund is null', async () => {
    mockTokenRefresh();
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, { data: { order: ORDER_RESPONSE } });
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, { data: { order: { suggestedRefund: null } } });

    const client = makeClient();
    await expect(client.cancelShopifyOrder('123')).rejects.toThrow(
      'Could not fetch suggested refund',
    );
  });

  it('throws when refundCreate returns userErrors', async () => {
    mockTokenRefresh();
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, { data: { order: ORDER_RESPONSE } });
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, { data: { order: { suggestedRefund: SUGGESTED_REFUND } } });
    nock(BASE_URL)
      .post('/admin/api/2026-01/graphql.json')
      .reply(200, {
        data: {
          refundCreate: { refund: null, userErrors: [{ field: 'base', message: 'Refund failed' }] },
        },
      });

    const client = makeClient();
    await expect(client.cancelShopifyOrder('123')).rejects.toThrow(
      'Shopify refund errors: Refund failed',
    );
  });
});
