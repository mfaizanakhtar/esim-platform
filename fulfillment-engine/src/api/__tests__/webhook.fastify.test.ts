/**
 * Fastify integration tests for src/api/webhook.ts
 *
 * These tests mount the actual webhook route handler through Fastify's
 * inject() mechanism so we get real coverage of the handler code paths,
 * including HMAC verification, Zod validation, idempotency checks, and
 * job-queue enqueuing.
 *
 * The content-type parser from server.ts (which stores rawBody) is replicated
 * here so the handler can access request.rawBody for HMAC verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import type { EsimDelivery } from '@prisma/client';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('~/db/prisma', () => ({
  default: {
    esimDelivery: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

const mockJobSend = vi.fn().mockResolvedValue('job-id-wh');
vi.mock('~/queue/jobQueue', () => ({
  getJobQueue: vi.fn(() => ({ send: mockJobSend })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import webhookRoutes from '~/api/webhook';
import prisma from '~/db/prisma';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-webhook-secret-32-bytes-long';

/**
 * Build a Fastify instance that mirrors the relevant parts of server.ts:
 * - Custom content-type parser that stores rawBody
 * - Webhook routes registered at root (no prefix in test)
 */
async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Replicate the rawBody parser from server.ts
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.register(webhookRoutes);
  await app.ready();
  return app;
}

/** Compute a valid Shopify HMAC for the given body + secret */
function computeHmac(body: string, secret: string = TEST_SECRET): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

/** Full valid Shopify orders/paid payload */
const ORDER_PAYLOAD = {
  id: 111111,
  name: '#1234',
  email: 'buyer@example.com',
  customer: {
    id: 999,
    email: 'buyer@example.com',
    first_name: 'Jane',
    last_name: 'Doe',
  },
  line_items: [
    {
      id: 101,
      variant_id: 201,
      quantity: 1,
      product_id: 301,
      title: 'eSIM - US 10GB',
      name: 'eSIM - US 10GB',
      sku: 'ESIM-US-10GB',
    },
  ],
};

/** Build signed request headers */
function signedHeaders(rawBody: string, shopDomain = 'test-store.myshopify.com') {
  return {
    'content-type': 'application/json',
    'x-shopify-hmac-sha256': computeHmac(rawBody),
    'x-shopify-shop-domain': shopDomain,
  };
}

/** Build a minimal EsimDelivery row */
function makeDelivery(overrides: Partial<EsimDelivery> = {}): EsimDelivery {
  return {
    id: 'del-webhook-001',
    shop: 'test-store.myshopify.com',
    orderId: '111111',
    orderName: '#1234',
    lineItemId: '101',
    variantId: '201',
    customerEmail: 'buyer@example.com',
    vendorReferenceId: null,
    provider: null,
    payloadEncrypted: null,
    status: 'pending',
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /orders/paid — Fastify handler', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SHOPIFY_WEBHOOK_SECRET = TEST_SECRET;
    app = await buildTestApp();
  });

  afterEach(async () => {
    vi.resetAllMocks();
    await app.close();
  });

  // ── Missing HMAC header → 401 ────────────────────────────────────────

  it('returns 401 when x-shopify-hmac-sha256 header is absent', async () => {
    const rawBody = JSON.stringify(ORDER_PAYLOAD);

    const res = await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: {
        'content-type': 'application/json',
        'x-shopify-shop-domain': 'test-store.myshopify.com',
        // No HMAC header
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'Missing HMAC signature' });
  });

  // ── Invalid HMAC → 401 ───────────────────────────────────────────────

  it('returns 401 when HMAC signature is invalid', async () => {
    const rawBody = JSON.stringify(ORDER_PAYLOAD);

    const res = await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': 'definitely-wrong-signature',
        'x-shopify-shop-domain': 'test-store.myshopify.com',
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'Invalid signature' });
  });

  // ── Missing webhook secret env var → 500 ────────────────────────────

  it('returns 500 when SHOPIFY_WEBHOOK_SECRET is not configured', async () => {
    delete process.env.SHOPIFY_WEBHOOK_SECRET;

    const rawBody = JSON.stringify(ORDER_PAYLOAD);

    const res = await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': computeHmac(rawBody),
        'x-shopify-shop-domain': 'test-store.myshopify.com',
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: 'Server misconfiguration' });
  });

  // ── Invalid payload shape → 400 ──────────────────────────────────────

  it('returns 400 when payload fails Zod validation', async () => {
    const badPayload = { this_is: 'not a shopify order' };
    const rawBody = JSON.stringify(badPayload);

    const res = await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: signedHeaders(rawBody),
      payload: rawBody,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'Invalid webhook payload' });
  });

  it('returns 200 and ignores payload when x-shopify-topic is not orders/paid', async () => {
    const nonPaidPayload = { id: 999999, admin_graphql_api_id: 'gid://shopify/Order/999999' };
    const rawBody = JSON.stringify(nonPaidPayload);

    const res = await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: {
        ...signedHeaders(rawBody),
        'x-shopify-topic': 'orders/updated',
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, ignored: true });
    expect(vi.mocked(prisma.esimDelivery.create)).not.toHaveBeenCalled();
    expect(mockJobSend).not.toHaveBeenCalled();
  });

  // ── No customer email → 400 ──────────────────────────────────────────

  it('returns 400 when no customer email can be resolved', async () => {
    const noEmailPayload = {
      id: 222222,
      name: '#9999',
      email: '', // empty — treated as falsy
      line_items: [
        {
          id: 102,
          variant_id: 202,
          quantity: 1,
          product_id: 302,
          title: 'eSIM',
          name: 'eSIM',
          sku: null,
        },
      ],
    };
    const rawBody = JSON.stringify(noEmailPayload);

    const res = await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: signedHeaders(rawBody),
      payload: rawBody,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'No customer email' });
  });

  // ── Duplicate webhook (idempotency) → 200 skipped ───────────────────

  it('returns 200 and skips when the line item was already processed', async () => {
    vi.mocked(prisma.esimDelivery.findFirst).mockResolvedValue(makeDelivery());

    const rawBody = JSON.stringify(ORDER_PAYLOAD);

    const res = await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: signedHeaders(rawBody),
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true });

    // Delivery record NOT created again
    expect(vi.mocked(prisma.esimDelivery.create)).not.toHaveBeenCalled();
    // Job NOT re-enqueued
    expect(mockJobSend).not.toHaveBeenCalled();
  });

  // ── Happy path — new order ───────────────────────────────────────────

  it('returns 200 and creates delivery + enqueues job for new order', async () => {
    vi.mocked(prisma.esimDelivery.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.esimDelivery.create).mockResolvedValue(makeDelivery());

    const rawBody = JSON.stringify(ORDER_PAYLOAD);

    const res = await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: signedHeaders(rawBody),
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true });

    // Delivery record created
    expect(vi.mocked(prisma.esimDelivery.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: '111111',
          orderName: '#1234',
          lineItemId: '101',
          customerEmail: 'buyer@example.com',
          status: 'pending',
        }),
      }),
    );

    // Job enqueued
    expect(mockJobSend).toHaveBeenCalledWith(
      'provision-esim',
      expect.objectContaining({
        orderId: '111111',
        orderName: '#1234',
        lineItemId: '101',
        customerEmail: 'buyer@example.com',
        sku: 'ESIM-US-10GB',
      }),
      expect.any(Object),
    );
  });

  // ── Multiple line items ───────────────────────────────────────────────

  it('creates one delivery and job per unique line item', async () => {
    const twoItemOrder = {
      ...ORDER_PAYLOAD,
      id: 333333,
      name: '#2000',
      line_items: [
        {
          id: 401,
          variant_id: 501,
          quantity: 1,
          product_id: 601,
          title: 'US eSIM',
          name: 'US eSIM',
          sku: 'ESIM-US',
        },
        {
          id: 402,
          variant_id: 502,
          quantity: 1,
          product_id: 602,
          title: 'EU eSIM',
          name: 'EU eSIM',
          sku: 'ESIM-EU',
        },
      ],
    };

    // Neither line item exists yet
    vi.mocked(prisma.esimDelivery.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.esimDelivery.create)
      .mockResolvedValueOnce(makeDelivery({ lineItemId: '401' }))
      .mockResolvedValueOnce(makeDelivery({ lineItemId: '402' }));

    const rawBody = JSON.stringify(twoItemOrder);

    const res = await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: signedHeaders(rawBody),
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(prisma.esimDelivery.create)).toHaveBeenCalledTimes(2);
    expect(mockJobSend).toHaveBeenCalledTimes(2);
  });

  // ── Partial duplicate: one new + one duplicate ───────────────────────

  it('processes only new line items when some are already provisioned', async () => {
    const twoItemOrder = {
      ...ORDER_PAYLOAD,
      id: 444444,
      name: '#3000',
      line_items: [
        {
          id: 701,
          variant_id: 801,
          quantity: 1,
          product_id: 901,
          title: 'US eSIM',
          name: 'US eSIM',
          sku: 'ESIM-US',
        },
        {
          id: 702,
          variant_id: 802,
          quantity: 1,
          product_id: 902,
          title: 'EU eSIM',
          name: 'EU eSIM',
          sku: 'ESIM-EU',
        },
      ],
    };

    // First line item already exists, second is new
    vi.mocked(prisma.esimDelivery.findFirst)
      .mockResolvedValueOnce(makeDelivery({ lineItemId: '701' })) // duplicate
      .mockResolvedValueOnce(null); // new
    vi.mocked(prisma.esimDelivery.create).mockResolvedValue(makeDelivery({ lineItemId: '702' }));

    const rawBody = JSON.stringify(twoItemOrder);

    const res = await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: signedHeaders(rawBody),
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(prisma.esimDelivery.create)).toHaveBeenCalledTimes(1);
    expect(mockJobSend).toHaveBeenCalledTimes(1);
  });

  // ── Uses customer.email over order.email ─────────────────────────────

  it('uses customer.email when both customer.email and email are present', async () => {
    const payload = {
      ...ORDER_PAYLOAD,
      email: 'order-level@example.com',
      customer: {
        id: 888,
        email: 'customer-level@example.com',
        first_name: 'Alice',
        last_name: 'Smith',
      },
    };

    vi.mocked(prisma.esimDelivery.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.esimDelivery.create).mockResolvedValue(makeDelivery());

    const rawBody = JSON.stringify(payload);

    await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: signedHeaders(rawBody),
      payload: rawBody,
    });

    expect(vi.mocked(prisma.esimDelivery.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customerEmail: 'customer-level@example.com' }),
      }),
    );
  });

  // ── Fallback to order-level email when customer is absent ────────────

  it('falls back to order-level email when customer object is absent', async () => {
    const payload = {
      id: 555555,
      name: '#5000',
      email: 'fallback@example.com',
      // no customer field
      line_items: [
        {
          id: 901,
          variant_id: 1001,
          quantity: 1,
          product_id: 1101,
          title: 'eSIM',
          name: 'eSIM',
          sku: null,
        },
      ],
    };

    vi.mocked(prisma.esimDelivery.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.esimDelivery.create).mockResolvedValue(
      makeDelivery({ customerEmail: 'fallback@example.com' }),
    );

    const rawBody = JSON.stringify(payload);

    await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: signedHeaders(rawBody),
      payload: rawBody,
    });

    expect(vi.mocked(prisma.esimDelivery.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customerEmail: 'fallback@example.com' }),
      }),
    );
  });

  it('falls back to contact_email when customer.email and email are missing', async () => {
    const payload = {
      id: 565656,
      name: '#5050',
      email: null,
      contact_email: 'contact-fallback@example.com',
      customer: null,
      line_items: [
        {
          id: 911,
          variant_id: 1011,
          quantity: 1,
          product_id: 1111,
          title: null,
          name: null,
          sku: 'ESIM-CONTACT',
        },
      ],
    };

    vi.mocked(prisma.esimDelivery.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.esimDelivery.create).mockResolvedValue(
      makeDelivery({ customerEmail: 'contact-fallback@example.com' }),
    );

    const rawBody = JSON.stringify(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: signedHeaders(rawBody),
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(prisma.esimDelivery.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customerEmail: 'contact-fallback@example.com' }),
      }),
    );
  });

  it('accepts nullable customer fields from Shopify payload', async () => {
    const payload = {
      id: 575757,
      name: '#5151',
      email: 'nullable-fields@example.com',
      customer: {
        id: 1000,
        email: null,
        first_name: null,
        last_name: null,
        phone: null,
      },
      line_items: [
        {
          id: 921,
          variant_id: 1021,
          quantity: 1,
          product_id: 1121,
          title: null,
          name: null,
          sku: 'ESIM-NULLABLE',
        },
      ],
    };

    vi.mocked(prisma.esimDelivery.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.esimDelivery.create).mockResolvedValue(
      makeDelivery({ customerEmail: 'nullable-fields@example.com' }),
    );

    const rawBody = JSON.stringify(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: signedHeaders(rawBody),
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(mockJobSend).toHaveBeenCalledTimes(1);
  });

  it('skips line items with null variant_id and still processes valid line items', async () => {
    const payload = {
      ...ORDER_PAYLOAD,
      id: 585858,
      name: '#5252',
      line_items: [
        {
          id: 931,
          variant_id: null,
          quantity: 1,
          product_id: 1131,
          title: 'Gift Card',
          name: 'Gift Card',
          sku: null,
        },
        {
          id: 932,
          variant_id: 1032,
          quantity: 1,
          product_id: 1132,
          title: 'US eSIM',
          name: 'US eSIM',
          sku: 'ESIM-US',
        },
      ],
    };

    vi.mocked(prisma.esimDelivery.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.esimDelivery.create).mockResolvedValue(makeDelivery({ lineItemId: '932' }));

    const rawBody = JSON.stringify(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: signedHeaders(rawBody),
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(prisma.esimDelivery.create)).toHaveBeenCalledTimes(1);
    expect(mockJobSend).toHaveBeenCalledTimes(1);
    expect(mockJobSend).toHaveBeenCalledWith(
      'provision-esim',
      expect.objectContaining({ lineItemId: '932', variantId: '1032' }),
      expect.any(Object),
    );
  });

  // ── Shop domain stored on delivery ───────────────────────────────────

  it('stores the shop domain from x-shopify-shop-domain header', async () => {
    vi.mocked(prisma.esimDelivery.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.esimDelivery.create).mockResolvedValue(makeDelivery());

    const rawBody = JSON.stringify(ORDER_PAYLOAD);

    await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: {
        ...signedHeaders(rawBody),
        'x-shopify-shop-domain': 'my-store.myshopify.com',
      },
      payload: rawBody,
    });

    expect(vi.mocked(prisma.esimDelivery.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shop: 'my-store.myshopify.com' }),
      }),
    );
  });

  // ── requestId propagated to job payload ──────────────────────────────

  it('includes requestId in the enqueued job payload', async () => {
    vi.mocked(prisma.esimDelivery.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.esimDelivery.create).mockResolvedValue(makeDelivery());

    const rawBody = JSON.stringify(ORDER_PAYLOAD);

    await app.inject({
      method: 'POST',
      url: '/orders/paid',
      headers: signedHeaders(rawBody),
      payload: rawBody,
    });

    expect(mockJobSend).toHaveBeenCalledWith(
      'provision-esim',
      expect.objectContaining({ requestId: expect.any(String) }),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// GET /test — health endpoint
// ---------------------------------------------------------------------------

describe('GET /test', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.SHOPIFY_WEBHOOK_SECRET = TEST_SECRET;
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });
});
