import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import type { EsimDelivery, ProviderSkuMapping } from '@prisma/client';

// ---------------------------------------------------------------------------
// vi.hoisted: runs before vi.mock factories AND before static imports.
// Put both env var setup and shareable mock functions here so they exist
// when the vi.mock factories capture their closures.
// ---------------------------------------------------------------------------
const adminMocks = vi.hoisted(() => {
  process.env.ADMIN_API_KEY = 'test-admin-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  return {
    mockJobSend: vi.fn().mockResolvedValue('job-id-admin'),
    mockSendDeliveryEmail: vi.fn(),
    mockDecrypt: vi.fn(),
    mockTgtListProducts: vi.fn(),
    mockFiroamGetSkus: vi.fn(),
    mockFiroamGetPackages: vi.fn(),
    mockGetAllVariants: vi.fn(),
    mockGetVariantGidsBySkus: vi.fn(),
    mockGetVariantInfoByGids: vi.fn(),
    mockDeleteProduct: vi.fn(),
    mockDeleteVariants: vi.fn(),
    mockOpenAiCreate: vi.fn(),
    mockOpenAiEmbeddingsCreate: vi.fn(),
    mockIsVectorAvailable: vi.fn().mockResolvedValue(false),
    mockEmbedBatch: vi.fn().mockResolvedValue([]),
    mockFindTopCandidates: vi.fn().mockResolvedValue([]),
    mockStoreEmbedding: vi.fn().mockResolvedValue(undefined),
    mockBackfillMissingEmbeddings: vi.fn().mockResolvedValue(0),
    mockBuildCatalogText: vi.fn().mockReturnValue(''),
    mockParseCatalogEntry: vi.fn().mockResolvedValue(null),
    mockHandleCancelEsim: vi.fn().mockResolvedValue(undefined),
    mockCancelShopifyOrder: vi.fn().mockResolvedValue(undefined),
  };
});

// ---------------------------------------------------------------------------
// Module mocks (hoisted before static imports)
// ---------------------------------------------------------------------------

vi.mock('~/db/prisma', () => ({
  default: {
    esimDelivery: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    providerSkuMapping: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
    providerSkuCatalog: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      upsert: vi.fn(),
    },
    aiMapJob: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    shopifyVariant: {
      count: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock('~/vendor/tgtClient', () => ({
  default: class MockTgtClient {
    async listProducts(...args: unknown[]) {
      return adminMocks.mockTgtListProducts(...args);
    }
  },
}));

vi.mock('~/vendor/firoamClient', () => ({
  default: class MockFiRoamClient {
    async getSkus(...args: unknown[]) {
      return adminMocks.mockFiroamGetSkus(...args);
    }
    async getPackages(...args: unknown[]) {
      return adminMocks.mockFiroamGetPackages(...args);
    }
  },
}));

vi.mock('~/queue/jobQueue', () => ({
  getJobQueue: vi.fn(() => ({ send: adminMocks.mockJobSend })),
}));

vi.mock('~/services/email', () => ({
  sendDeliveryEmail: adminMocks.mockSendDeliveryEmail,
}));

vi.mock('~/utils/crypto', () => ({
  decrypt: adminMocks.mockDecrypt,
  encrypt: vi.fn(),
}));

vi.mock('~/shopify/client', () => ({
  getShopifyClient: vi.fn(() => ({
    getAllVariants: adminMocks.mockGetAllVariants,
    getVariantGidsBySkus: adminMocks.mockGetVariantGidsBySkus,
    getVariantInfoByGids: adminMocks.mockGetVariantInfoByGids,
    deleteProduct: adminMocks.mockDeleteProduct,
    deleteVariants: adminMocks.mockDeleteVariants,
    cancelShopifyOrder: adminMocks.mockCancelShopifyOrder,
  })),
}));

vi.mock('~/worker/jobs/cancelEsim', () => ({
  handleCancelEsim: (...args: unknown[]) => adminMocks.mockHandleCancelEsim(...args),
}));

vi.mock('openai', () => {
  class MockAPIError extends Error {
    status: number;
    code: string | null = null;
    constructor(status: number, _error: unknown, message: string, _headers: unknown) {
      super(message);
      this.status = status;
    }
  }
  return {
    default: Object.assign(
      class MockOpenAI {
        chat = {
          completions: {
            create: adminMocks.mockOpenAiCreate,
          },
        };
        embeddings = {
          create: adminMocks.mockOpenAiEmbeddingsCreate,
        };
      },
      { APIError: MockAPIError },
    ),
  };
});

vi.mock('~/services/embeddingService', () => ({
  isVectorAvailable: () => adminMocks.mockIsVectorAvailable(),
  embedBatch: (...args: unknown[]) => adminMocks.mockEmbedBatch(...args),
  findTopCandidates: (...args: unknown[]) => adminMocks.mockFindTopCandidates(...args),
  storeEmbedding: (...args: unknown[]) => adminMocks.mockStoreEmbedding(...args),
  backfillMissingEmbeddings: (...args: unknown[]) =>
    adminMocks.mockBackfillMissingEmbeddings(...args),
  buildCatalogText: (...args: unknown[]) => adminMocks.mockBuildCatalogText(...args),
  parseCatalogEntry: (...args: unknown[]) => adminMocks.mockParseCatalogEntry(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import OpenAI from 'openai';
import adminRoutes from '~/api/admin';
import prisma from '~/db/prisma';

type ProviderCatalogItem = {
  id: string;
  provider: string;
  productCode: string;
  productName: string;
  productType: string | null;
  region: string | null;
  countryCodes: unknown;
  dataAmount: string | null;
  validity: string | null;
  netPrice: unknown;
  currency: string | null;
  cardType: string | null;
  activeType: string | null;
  rawPayload: unknown;
  parsedJson?: unknown;
  isActive: boolean;
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

// Keep this cast local to tests to avoid depending on Prisma's generated
// `ProviderSkuCatalog` type shape when editor diagnostics are stale.
// Runtime behavior still uses the mocked delegate methods below.
const prismaCatalog = (
  prisma as unknown as {
    providerSkuCatalog: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
  }
).providerSkuCatalog as {
  findMany: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const AUTH = { 'x-admin-key': 'test-admin-key' };
const JSON_HEADERS = { ...AUTH, 'content-type': 'application/json' };

/** Build a minimal EsimDelivery with sensible defaults */
function makeDelivery(overrides: Partial<EsimDelivery> = {}): EsimDelivery {
  return {
    id: 'del-001',
    shop: 'test.myshopify.com',
    orderId: 'order-123',
    orderName: '#1001',
    lineItemId: 'line-111',
    variantId: 'var-222',
    customerEmail: 'customer@test.com',
    vendorReferenceId: null,
    provider: null,
    iccidHash: null,
    topupIccid: null,
    sku: null,
    payloadEncrypted: null,
    accessToken: null,
    status: 'pending',
    lastError: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

/** Build a minimal ProviderSkuMapping with sensible defaults */
function makeMapping(overrides: Partial<ProviderSkuMapping> = {}): ProviderSkuMapping {
  return {
    id: 'map-001',
    shopifySku: 'ESIM-USA-10GB',
    provider: 'firoam',
    providerSku: '156:826:14094',
    name: 'USA 10GB',
    region: 'USA',
    dataAmount: '10GB',
    validity: '30 days',
    packageType: 'fixed',
    daysCount: null,
    providerConfig: null,
    providerCatalogId: null,
    isActive: true,
    priority: 1,
    priorityLocked: false,
    mappingLocked: false,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function makeCatalogItem(overrides: Partial<ProviderCatalogItem> = {}): ProviderCatalogItem {
  return {
    id: 'cat-001',
    provider: 'tgt',
    productCode: 'A-002-ES-AU-T-30D/180D-3GB(A)',
    productName: 'Israel 3GB',
    productType: 'DATA_PACK',
    region: 'Middle East',
    countryCodes: ['IL'],
    dataAmount: '3GB',
    validity: '180 days',
    netPrice: '1.10' as unknown as ProviderCatalogItem['netPrice'],
    currency: 'USD',
    cardType: 'M1',
    activeType: 'AUTO_ACTIVATE',
    rawPayload: { productCode: 'A-002-ES-AU-T-30D/180D-3GB(A)' },
    isActive: true,
    lastSyncedAt: new Date('2026-03-08T00:00:00Z'),
    createdAt: new Date('2026-03-08T00:00:00Z'),
    updatedAt: new Date('2026-03-08T00:00:00Z'),
    ...overrides,
  };
}

/** A realistic encrypted payload JSON string */
const encPayload = JSON.stringify({
  lpa: 'LPA:1$smdp.io$ACTCODE',
  activationCode: 'ACTCODE',
  iccid: '8901000000000000001',
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Admin Routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    adminMocks.mockJobSend.mockResolvedValue('job-id-admin');
    adminMocks.mockHandleCancelEsim.mockResolvedValue(undefined);
    adminMocks.mockCancelShopifyOrder.mockResolvedValue(undefined);
    app = Fastify({ logger: false });
    app.register(adminRoutes);
    await app.ready();
  });

  afterEach(async () => {
    vi.resetAllMocks();
    await app.close();
  });

  // ── Authentication guard ────────────────────────────────────────────────

  describe('Admin key authentication', () => {
    it('returns 401 when x-admin-key header is missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/deliveries' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: 'Unauthorized' });
    });

    it('returns 401 when x-admin-key header is wrong', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/deliveries',
        headers: { 'x-admin-key': 'wrong-secret' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('allows requests with the correct admin key', async () => {
      vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([]);
      vi.mocked(prisma.esimDelivery.count).mockResolvedValue(0);
      const res = await app.inject({ method: 'GET', url: '/deliveries', headers: AUTH });
      expect(res.statusCode).toBe(200);
    });
  });

  // ── GET /deliveries ─────────────────────────────────────────────────────

  describe('GET /deliveries', () => {
    it('returns list of deliveries with total', async () => {
      vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([makeDelivery()]);
      vi.mocked(prisma.esimDelivery.count).mockResolvedValue(1);

      const res = await app.inject({ method: 'GET', url: '/deliveries', headers: AUTH });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.deliveries).toHaveLength(1);
      expect(body.limit).toBe(50);
      expect(body.offset).toBe(0);
    });

    it('strips payloadEncrypted from every delivery in the list', async () => {
      vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
        makeDelivery({ payloadEncrypted: 'super-secret-lpa' }),
      ]);
      vi.mocked(prisma.esimDelivery.count).mockResolvedValue(1);

      const res = await app.inject({ method: 'GET', url: '/deliveries', headers: AUTH });
      const body = res.json();
      expect(body.deliveries[0].payloadEncrypted).toBeUndefined();
    });

    it('filters by status query param', async () => {
      vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
        makeDelivery({ status: 'failed' }),
      ]);
      vi.mocked(prisma.esimDelivery.count).mockResolvedValue(1);

      await app.inject({ method: 'GET', url: '/deliveries?status=failed', headers: AUTH });

      expect(vi.mocked(prisma.esimDelivery.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'failed' } }),
      );
    });

    it('applies pagination: limit and offset', async () => {
      vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([]);
      vi.mocked(prisma.esimDelivery.count).mockResolvedValue(0);

      const res = await app.inject({
        method: 'GET',
        url: '/deliveries?limit=10&offset=20',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.limit).toBe(10);
      expect(body.offset).toBe(20);
    });

    it('caps limit at 200 regardless of query param', async () => {
      vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([]);
      vi.mocked(prisma.esimDelivery.count).mockResolvedValue(0);

      const res = await app.inject({
        method: 'GET',
        url: '/deliveries?limit=9999',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().limit).toBe(200);
    });
  });

  // ── GET /deliveries/:id ─────────────────────────────────────────────────

  describe('GET /deliveries/:id', () => {
    it('returns 404 when delivery not found', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/deliveries/nonexistent-id',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'Delivery not found' });
    });

    it('returns delivery with decrypted esimPayload', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
        ...makeDelivery({ payloadEncrypted: 'enc-data', status: 'delivered' }),
        attempts: [],
        esimOrders: [],
      } as unknown as EsimDelivery);
      adminMocks.mockDecrypt.mockResolvedValue(encPayload);

      const res = await app.inject({ method: 'GET', url: '/deliveries/del-001', headers: AUTH });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.esimPayload).toMatchObject({
        lpa: 'LPA:1$smdp.io$ACTCODE',
        activationCode: 'ACTCODE',
        iccid: '8901000000000000001',
      });
      expect(body.payloadEncrypted).toBeUndefined();
    });

    it('returns esimPayload.error when decryption fails', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
        ...makeDelivery({ payloadEncrypted: 'corrupt-data' }),
        attempts: [],
        esimOrders: [],
      } as unknown as EsimDelivery);
      adminMocks.mockDecrypt.mockRejectedValue(new Error('Decryption failed'));

      const res = await app.inject({ method: 'GET', url: '/deliveries/del-001', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(res.json().esimPayload).toMatchObject({ error: 'Failed to decrypt payload' });
    });

    it('returns null esimPayload when no payloadEncrypted', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
        ...makeDelivery({ payloadEncrypted: null }),
        attempts: [],
        esimOrders: [],
      } as unknown as EsimDelivery);

      const res = await app.inject({ method: 'GET', url: '/deliveries/del-001', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(res.json().esimPayload).toBeNull();
    });
  });

  // ── POST /deliveries/:id/retry ──────────────────────────────────────────

  describe('POST /deliveries/:id/retry', () => {
    it('returns 404 when delivery not found', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/deliveries/bad-id/retry',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 409 when delivery is already delivered', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(
        makeDelivery({ status: 'delivered' }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/deliveries/del-001/retry',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('already completed');
    });

    it('resets status to pending and re-enqueues job', async () => {
      const delivery = makeDelivery({ status: 'failed' });
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(delivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue({
        ...delivery,
        status: 'pending',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/deliveries/del-001/retry',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true });

      expect(vi.mocked(prisma.esimDelivery.update)).toHaveBeenCalledWith({
        where: { id: 'del-001' },
        data: { status: 'pending', lastError: null },
      });

      expect(adminMocks.mockJobSend).toHaveBeenCalledWith(
        'provision-esim',
        expect.objectContaining({ deliveryId: 'del-001', orderId: 'order-123' }),
        expect.any(Object),
      );
    });

    it('re-enqueues pending delivery as well (not only failed)', async () => {
      const delivery = makeDelivery({ status: 'pending' });
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(delivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(delivery);

      const res = await app.inject({
        method: 'POST',
        url: '/deliveries/del-001/retry',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(adminMocks.mockJobSend).toHaveBeenCalled();
    });
  });

  // ── POST /deliveries/:id/cancel ─────────────────────────────────────────

  describe('POST /deliveries/:id/cancel', () => {
    it('returns 404 when delivery not found', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/deliveries/bad-id/cancel',
        headers: JSON_HEADERS,
        payload: { refund: false },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 409 when delivery is already cancelled', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(
        makeDelivery({ status: 'cancelled' }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/deliveries/del-001/cancel',
        headers: JSON_HEADERS,
        payload: { refund: false },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('already cancelled');
    });

    it('enqueues cancel-esim job without refund when refund=false', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(
        makeDelivery({ status: 'pending' }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/deliveries/del-001/cancel',
        headers: JSON_HEADERS,
        payload: { refund: false },
      });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ ok: true });
      expect(adminMocks.mockJobSend).toHaveBeenCalledWith(
        'cancel-esim',
        expect.objectContaining({ deliveryId: 'del-001', orderId: 'order-123', refund: false }),
        expect.any(Object),
      );
    });

    it('enqueues cancel-esim job with refund=true when requested', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(
        makeDelivery({ status: 'delivered' }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/deliveries/del-001/cancel',
        headers: JSON_HEADERS,
        payload: { refund: true },
      });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ ok: true });
      expect(adminMocks.mockJobSend).toHaveBeenCalledWith(
        'cancel-esim',
        expect.objectContaining({ deliveryId: 'del-001', orderId: 'order-123', refund: true }),
        expect.any(Object),
      );
    });
  });

  // ── POST /deliveries/:id/resend-email ───────────────────────────────────

  describe('POST /deliveries/:id/resend-email', () => {
    it('returns 404 when delivery not found', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/deliveries/bad-id/resend-email',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 409 when delivery is not in delivered status', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(
        makeDelivery({ status: 'pending' }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/deliveries/del-001/resend-email',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain("status is 'pending'");
    });

    it('returns 409 when no payloadEncrypted on the delivery', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(
        makeDelivery({ status: 'delivered', payloadEncrypted: null }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/deliveries/del-001/resend-email',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('No encrypted eSIM payload');
    });

    it('returns 409 when delivery has no customer email', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(
        makeDelivery({ status: 'delivered', payloadEncrypted: 'enc', customerEmail: null }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/deliveries/del-001/resend-email',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('No customer email');
    });

    it('returns 500 when decrypt throws', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(
        makeDelivery({ status: 'delivered', payloadEncrypted: 'enc', customerEmail: 'c@t.com' }),
      );
      adminMocks.mockDecrypt.mockRejectedValue(new Error('bad crypto'));

      const res = await app.inject({
        method: 'POST',
        url: '/deliveries/del-001/resend-email',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toContain('Failed to decrypt');
    });

    it('returns 502 when email send fails', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(
        makeDelivery({ status: 'delivered', payloadEncrypted: 'enc', customerEmail: 'c@t.com' }),
      );
      adminMocks.mockDecrypt.mockResolvedValue(encPayload);
      adminMocks.mockSendDeliveryEmail.mockResolvedValue({ success: false, error: 'SMTP error' });

      const res = await app.inject({
        method: 'POST',
        url: '/deliveries/del-001/resend-email',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toContain('SMTP error');
    });

    it('returns 200 and messageId on successful resend', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(
        makeDelivery({ status: 'delivered', payloadEncrypted: 'enc', customerEmail: 'c@t.com' }),
      );
      adminMocks.mockDecrypt.mockResolvedValue(encPayload);
      adminMocks.mockSendDeliveryEmail.mockResolvedValue({
        success: true,
        messageId: 'msg-abc-123',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/deliveries/del-001/resend-email',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, messageId: 'msg-abc-123' });
    });
  });

  // ── GET /providers ──────────────────────────────────────────────────────

  describe('GET /providers', () => {
    it('returns registered provider names from registry', async () => {
      const res = await app.inject({ method: 'GET', url: '/providers', headers: AUTH });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ providers: string[] }>();
      expect(Array.isArray(body.providers)).toBe(true);
      expect(body.providers).toContain('firoam');
      expect(body.providers).toContain('tgt');
    });

    it('returns 401 without admin key', async () => {
      const res = await app.inject({ method: 'GET', url: '/providers' });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── GET /sku-mappings ───────────────────────────────────────────────────

  describe('GET /sku-mappings', () => {
    it('returns list of SKU mappings with total', async () => {
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([makeMapping()]);
      vi.mocked(prisma.providerSkuMapping.count).mockResolvedValue(1);

      const res = await app.inject({ method: 'GET', url: '/sku-mappings', headers: AUTH });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.mappings).toHaveLength(1);
      expect(body.mappings[0].shopifySku).toBe('ESIM-USA-10GB');
    });

    it('filters by provider', async () => {
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      vi.mocked(prisma.providerSkuMapping.count).mockResolvedValue(0);

      await app.inject({ method: 'GET', url: '/sku-mappings?provider=firoam', headers: AUTH });

      expect(vi.mocked(prisma.providerSkuMapping.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ provider: 'firoam' }) }),
      );
    });

    it('filters by isActive=true', async () => {
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      vi.mocked(prisma.providerSkuMapping.count).mockResolvedValue(0);

      await app.inject({ method: 'GET', url: '/sku-mappings?isActive=true', headers: AUTH });

      expect(vi.mocked(prisma.providerSkuMapping.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isActive: true }) }),
      );
    });

    it('filters by isActive=false', async () => {
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      vi.mocked(prisma.providerSkuMapping.count).mockResolvedValue(0);

      await app.inject({ method: 'GET', url: '/sku-mappings?isActive=false', headers: AUTH });

      expect(vi.mocked(prisma.providerSkuMapping.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isActive: false }) }),
      );
    });

    it('caps limit at 500', async () => {
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      vi.mocked(prisma.providerSkuMapping.count).mockResolvedValue(0);

      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings?limit=99999',
        headers: AUTH,
      });

      expect(res.json().limit).toBe(10000);
    });
  });

  // ── GET /sku-mappings/:id ───────────────────────────────────────────────

  describe('GET /sku-mappings/:id', () => {
    it('returns 404 when mapping not found', async () => {
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/no-such-id',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'SKU mapping not found' });
    });

    it('returns the mapping when found', async () => {
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(makeMapping());

      const res = await app.inject({ method: 'GET', url: '/sku-mappings/map-001', headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json().shopifySku).toBe('ESIM-USA-10GB');
    });
  });

  // ── POST /sku-mappings ──────────────────────────────────────────────────

  describe('POST /sku-mappings', () => {
    const validBody = {
      shopifySku: 'ESIM-NEW-001',
      provider: 'firoam',
      providerSku: '120:apiCode:14094',
    };

    it('returns 400 when shopifySku is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings',
        headers: JSON_HEADERS,
        payload: { provider: 'firoam', providerSku: '120:code:123' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('shopifySku');
    });

    it('returns 400 when provider is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings',
        headers: JSON_HEADERS,
        payload: { shopifySku: 'TEST-SKU', providerSku: '120:code:123' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('provider');
    });

    it('returns 400 when providerSku is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings',
        headers: JSON_HEADERS,
        payload: { shopifySku: 'TEST-SKU', provider: 'firoam' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('providerSku');
    });

    it('returns 409 when shopifySku already exists', async () => {
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(makeMapping());

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings',
        headers: JSON_HEADERS,
        payload: validBody,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('already exists');
    });

    it('creates a mapping and returns 201', async () => {
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.providerSkuMapping.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.providerSkuMapping.create).mockResolvedValue(
        makeMapping({ shopifySku: 'ESIM-NEW-001', providerSku: '120:apiCode:14094' }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings',
        headers: JSON_HEADERS,
        payload: validBody,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().shopifySku).toBe('ESIM-NEW-001');
    });

    it('creates a daypass mapping with optional fields', async () => {
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.providerSkuMapping.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.providerSkuMapping.create).mockResolvedValue(
        makeMapping({ packageType: 'daypass', daysCount: 7 }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings',
        headers: JSON_HEADERS,
        payload: {
          ...validBody,
          name: 'Turkey 7-Day Pass',
          region: 'Turkey',
          dataAmount: '1GB/day',
          validity: '7 days',
          packageType: 'daypass',
          daysCount: 7,
          isActive: true,
        },
      });
      expect(res.statusCode).toBe(201);

      expect(vi.mocked(prisma.providerSkuMapping.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            packageType: 'daypass',
            daysCount: 7,
            name: 'Turkey 7-Day Pass',
            region: 'Turkey',
          }),
        }),
      );
    });

    it('defaults isActive to true when not specified', async () => {
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.providerSkuMapping.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.providerSkuMapping.create).mockResolvedValue(makeMapping());

      await app.inject({
        method: 'POST',
        url: '/sku-mappings',
        headers: JSON_HEADERS,
        payload: validBody,
      });

      expect(vi.mocked(prisma.providerSkuMapping.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isActive: true }),
        }),
      );
    });

    it('sets isActive=false when explicitly passed', async () => {
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.providerSkuMapping.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.providerSkuMapping.create).mockResolvedValue(
        makeMapping({ isActive: false }),
      );

      await app.inject({
        method: 'POST',
        url: '/sku-mappings',
        headers: JSON_HEADERS,
        payload: { ...validBody, isActive: false },
      });

      expect(vi.mocked(prisma.providerSkuMapping.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isActive: false }),
        }),
      );
    });
  });

  // ── PUT /sku-mappings/:id ───────────────────────────────────────────────

  describe('PUT /sku-mappings/:id', () => {
    it('returns 404 when mapping not found', async () => {
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);

      const res = await app.inject({
        method: 'PUT',
        url: '/sku-mappings/no-such-id',
        headers: JSON_HEADERS,
        payload: { isActive: false },
      });
      expect(res.statusCode).toBe(404);
    });

    it('updates only the provided fields', async () => {
      const existing = makeMapping();
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(existing);
      vi.mocked(prisma.providerSkuMapping.update).mockResolvedValue({
        ...existing,
        isActive: false,
      });

      const res = await app.inject({
        method: 'PUT',
        url: '/sku-mappings/map-001',
        headers: JSON_HEADERS,
        payload: { isActive: false },
      });

      expect(res.statusCode).toBe(200);
      expect(vi.mocked(prisma.providerSkuMapping.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'map-001' },
          data: { isActive: false },
        }),
      );
    });

    it('updates provider and providerSku fields', async () => {
      const existing = makeMapping();
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(existing);
      vi.mocked(prisma.providerSkuMapping.update).mockResolvedValue({
        ...existing,
        provider: 'airalo',
        providerSku: 'new-sku',
      });

      await app.inject({
        method: 'PUT',
        url: '/sku-mappings/map-001',
        headers: JSON_HEADERS,
        payload: { provider: 'airalo', providerSku: 'new-sku' },
      });

      expect(vi.mocked(prisma.providerSkuMapping.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { provider: 'airalo', providerSku: 'new-sku' },
        }),
      );
    });

    it('accepts daysCount and packageType update', async () => {
      const existing = makeMapping();
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(existing);
      vi.mocked(prisma.providerSkuMapping.update).mockResolvedValue({
        ...existing,
        packageType: 'daypass',
        daysCount: 5,
      });

      await app.inject({
        method: 'PUT',
        url: '/sku-mappings/map-001',
        headers: JSON_HEADERS,
        payload: { packageType: 'daypass', daysCount: 5 },
      });

      expect(vi.mocked(prisma.providerSkuMapping.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ packageType: 'daypass', daysCount: 5 }),
        }),
      );
    });

    it('sets providerConfig to Prisma.JsonNull when null is provided', async () => {
      const existing = makeMapping();
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(existing);
      vi.mocked(prisma.providerSkuMapping.update).mockResolvedValue(existing);

      await app.inject({
        method: 'PUT',
        url: '/sku-mappings/map-001',
        headers: JSON_HEADERS,
        payload: { providerConfig: null },
      });

      expect(vi.mocked(prisma.providerSkuMapping.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ providerConfig: expect.anything() }),
        }),
      );
    });

    it('sets providerConfig to object when object is provided', async () => {
      const existing = makeMapping();
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(existing);
      vi.mocked(prisma.providerSkuMapping.update).mockResolvedValue({
        ...existing,
        providerConfig: { extra: 'value' },
      });

      await app.inject({
        method: 'PUT',
        url: '/sku-mappings/map-001',
        headers: JSON_HEADERS,
        payload: { providerConfig: { extra: 'value' } },
      });

      expect(vi.mocked(prisma.providerSkuMapping.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ providerConfig: { extra: 'value' } }),
        }),
      );
    });
  });

  // ── DELETE /sku-mappings (clear all) ───────────────────────────────────

  describe('DELETE /sku-mappings', () => {
    it('deletes all mappings when no provider filter', async () => {
      vi.mocked(prisma.providerSkuMapping.deleteMany).mockResolvedValue({ count: 42 });
      const res = await app.inject({ method: 'DELETE', url: '/sku-mappings', headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: 42 });
      expect(prisma.providerSkuMapping.deleteMany).toHaveBeenCalledWith({ where: {} });
    });

    it('deletes only provider mappings when provider filter supplied', async () => {
      vi.mocked(prisma.providerSkuMapping.deleteMany).mockResolvedValue({ count: 10 });
      const res = await app.inject({
        method: 'DELETE',
        url: '/sku-mappings?provider=firoam',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: 10 });
      expect(prisma.providerSkuMapping.deleteMany).toHaveBeenCalledWith({
        where: { provider: 'firoam' },
      });
    });

    it('returns 400 when provider is empty string', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/sku-mappings?provider=',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 500 when deleteMany throws', async () => {
      vi.mocked(prisma.providerSkuMapping.deleteMany).mockRejectedValue(new Error('db error'));
      const res = await app.inject({ method: 'DELETE', url: '/sku-mappings', headers: AUTH });
      expect(res.statusCode).toBe(500);
    });

    it('returns 401 without admin key', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/sku-mappings' });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── DELETE /sku-mappings/:id ────────────────────────────────────────────

  describe('DELETE /sku-mappings/:id', () => {
    it('returns 404 when mapping not found', async () => {
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);

      const res = await app.inject({
        method: 'DELETE',
        url: '/sku-mappings/no-such-id',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
    });

    it('soft-deletes by setting isActive=false (no hard delete)', async () => {
      const existing = makeMapping();
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(existing);
      vi.mocked(prisma.providerSkuMapping.update).mockResolvedValue({
        ...existing,
        isActive: false,
      });

      const res = await app.inject({
        method: 'DELETE',
        url: '/sku-mappings/map-001',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(vi.mocked(prisma.providerSkuMapping.update)).toHaveBeenCalledWith({
        where: { id: 'map-001' },
        data: { isActive: false },
      });
    });

    it('includes shopifySku in success message', async () => {
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(makeMapping());
      vi.mocked(prisma.providerSkuMapping.update).mockResolvedValue(
        makeMapping({ isActive: false }),
      );

      const res = await app.inject({
        method: 'DELETE',
        url: '/sku-mappings/map-001',
        headers: AUTH,
      });

      expect(res.json().message).toContain('ESIM-USA-10GB');
    });
  });

  // ── Provider catalog endpoints ──────────────────────────────────────────

  describe('GET /provider-catalog', () => {
    it('lists provider catalog items with pagination', async () => {
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([makeCatalogItem()]);
      vi.mocked(prismaCatalog.count).mockResolvedValue(1);

      const res = await app.inject({
        method: 'GET',
        url: '/provider-catalog?provider=tgt&limit=10&offset=0',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ total: 1, limit: 10, offset: 0 });
      expect(vi.mocked(prismaCatalog.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ provider: 'tgt' }),
        }),
      );
    });

    it('filters by isActive=true when provided', async () => {
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([]);
      vi.mocked(prismaCatalog.count).mockResolvedValue(0);

      const res = await app.inject({
        method: 'GET',
        url: '/provider-catalog?isActive=true',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(vi.mocked(prismaCatalog.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true }),
        }),
      );
    });
  });

  describe('POST /provider-catalog/sync', () => {
    it('rejects unsupported provider', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/sync',
        headers: JSON_HEADERS,
        payload: { provider: 'stripe' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('syncs TGT catalog items via upsert', async () => {
      adminMocks.mockTgtListProducts.mockResolvedValue({
        total: 1,
        products: [
          {
            productCode: 'A-002-ES-AU-T-30D/180D-3GB(A)',
            productName: 'Israel 3GB',
            productType: 'DATA_PACK',
            countryCodeList: ['IL'],
            netPrice: 1.1,
            validityPeriod: 180,
            dataTotal: 3,
            dataUnit: 'GB',
            cardType: 'M1',
            activeType: 'AUTO_ACTIVATE',
          },
        ],
      });
      vi.mocked(prismaCatalog.upsert).mockResolvedValue(makeCatalogItem());

      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/sync',
        headers: JSON_HEADERS,
        payload: { provider: 'tgt', pageSize: 100, maxPages: 1, lang: 'en' },
      });

      expect(res.statusCode).toBe(200);
      expect(vi.mocked(prismaCatalog.upsert)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(prismaCatalog.upsert)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            provider_skuId_productCode: {
              provider: 'tgt',
              skuId: '',
              productCode: 'A-002-ES-AU-T-30D/180D-3GB(A)',
            },
          },
        }),
      );
      expect(res.json()).toMatchObject({ ok: true, provider: 'tgt', processed: 1 });
    });

    // ── FiRoam sync tests ────────────────────────────────────────────────

    it('syncs FiRoam catalog: fetches SKUs + packages and upserts each', async () => {
      adminMocks.mockFiroamGetSkus.mockResolvedValue({
        skus: [{ skuid: 156, display: 'United States', countryCode: 'US' }],
      });
      adminMocks.mockFiroamGetPackages.mockResolvedValue({
        packageData: {
          skuid: 156,
          detailId: null,
          countrycode: 'US',
          imageUrl: '',
          display: '美国',
          displayEn: 'United States',
          supportCountry: ['US'],
          expirydate: null,
          countryImageUrlDtoList: [],
          esimPackageDtoList: [
            {
              flows: 10,
              days: 30,
              unit: 'GB',
              price: 5.99,
              priceid: 1,
              flowType: 1,
              countryImageUrlDtoList: null,
              showName: '10GB 30 Days',
              pid: 100,
              premark: '',
              expireDays: 0,
              networkDtoList: [],
              supportDaypass: 0,
              openCardFee: 0,
              minDay: 0,
              singleDiscountDay: 0,
              singleDiscount: 0,
              maxDiscount: 0,
              maxDay: 0,
              mustDate: 0,
              apiCode: 'US-10GB-30D',
            },
            {
              flows: 5,
              days: 15,
              unit: 'GB',
              price: 3.49,
              priceid: 2,
              flowType: 1,
              countryImageUrlDtoList: null,
              showName: '5GB 15 Days',
              pid: 101,
              premark: '',
              expireDays: 0,
              networkDtoList: [],
              supportDaypass: 0,
              openCardFee: 0,
              minDay: 0,
              singleDiscountDay: 0,
              singleDiscount: 0,
              maxDiscount: 0,
              maxDay: 0,
              mustDate: 0,
              apiCode: 'US-5GB-15D',
            },
          ],
        },
      });
      vi.mocked(prismaCatalog.upsert).mockResolvedValue(makeCatalogItem());

      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/sync',
        headers: JSON_HEADERS,
        payload: { provider: 'firoam' },
      });

      expect(res.statusCode).toBe(200);
      expect(vi.mocked(prismaCatalog.upsert)).toHaveBeenCalledTimes(2);
      expect(res.json()).toMatchObject({
        ok: true,
        provider: 'firoam',
        processedSkus: 1,
        processedPackages: 2,
        totalSkus: 1,
        skipsNoApiCode: 0,
      });
      // Verify upsert uses (provider, skuId, productCode) as unique key
      expect(vi.mocked(prismaCatalog.upsert)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            provider_skuId_productCode: {
              provider: 'firoam',
              skuId: '156',
              productCode: 'US-10GB-30D',
            },
          },
        }),
      );
    });

    it('returns 502 when FiRoam getSkus fails', async () => {
      adminMocks.mockFiroamGetSkus.mockResolvedValue({
        raw: { code: 500, message: 'Internal error' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/sync',
        headers: JSON_HEADERS,
        payload: { provider: 'firoam' },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: 'FiRoam getSkus failed' });
      expect(vi.mocked(prismaCatalog.upsert)).not.toHaveBeenCalled();
    });

    it('skips packages with no apiCode and counts them in skipsNoApiCode', async () => {
      adminMocks.mockFiroamGetSkus.mockResolvedValue({
        skus: [{ skuid: 200, display: 'Canada', countryCode: 'CA' }],
      });
      adminMocks.mockFiroamGetPackages.mockResolvedValue({
        packageData: {
          skuid: 200,
          detailId: null,
          countrycode: 'CA',
          imageUrl: '',
          display: '加拿大',
          displayEn: 'Canada',
          supportCountry: ['CA'],
          expirydate: null,
          countryImageUrlDtoList: [],
          esimPackageDtoList: [
            {
              flows: 3,
              days: 7,
              unit: 'GB',
              price: 2.0,
              priceid: 10,
              flowType: 1,
              countryImageUrlDtoList: null,
              showName: '3GB 7 Days',
              pid: 200,
              premark: '',
              expireDays: 0,
              networkDtoList: [],
              supportDaypass: 0,
              openCardFee: 0,
              minDay: 0,
              singleDiscountDay: 0,
              singleDiscount: 0,
              maxDiscount: 0,
              maxDay: 0,
              mustDate: 0,
              apiCode: '', // empty → should be skipped
            },
            {
              flows: 10,
              days: 30,
              unit: 'GB',
              price: 6.0,
              priceid: 11,
              flowType: 1,
              countryImageUrlDtoList: null,
              showName: '10GB 30 Days',
              pid: 201,
              premark: '',
              expireDays: 0,
              networkDtoList: [],
              supportDaypass: 0,
              openCardFee: 0,
              minDay: 0,
              singleDiscountDay: 0,
              singleDiscount: 0,
              maxDiscount: 0,
              maxDay: 0,
              mustDate: 0,
              apiCode: 'CA-10GB-30D',
            },
          ],
        },
      });
      vi.mocked(prismaCatalog.upsert).mockResolvedValue(makeCatalogItem());

      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/sync',
        headers: JSON_HEADERS,
        payload: { provider: 'firoam' },
      });

      expect(res.statusCode).toBe(200);
      expect(vi.mocked(prismaCatalog.upsert)).toHaveBeenCalledTimes(1);
      expect(res.json()).toMatchObject({
        ok: true,
        processedPackages: 1,
        skipsNoApiCode: 1,
      });
    });

    it('respects maxSkus cap and only processes that many SKUs', async () => {
      adminMocks.mockFiroamGetSkus.mockResolvedValue({
        skus: [
          { skuid: 1, display: 'Country A', countryCode: 'AA' },
          { skuid: 2, display: 'Country B', countryCode: 'BB' },
          { skuid: 3, display: 'Country C', countryCode: 'CC' },
        ],
      });
      const emptyPkg = {
        packageData: {
          skuid: 1,
          detailId: null,
          countrycode: 'AA',
          imageUrl: '',
          display: 'A',
          displayEn: 'Country A',
          supportCountry: ['AA'],
          expirydate: null,
          countryImageUrlDtoList: [],
          esimPackageDtoList: [],
        },
      };
      adminMocks.mockFiroamGetPackages.mockResolvedValue(emptyPkg);
      vi.mocked(prismaCatalog.upsert).mockResolvedValue(makeCatalogItem());

      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/sync',
        headers: JSON_HEADERS,
        payload: { provider: 'firoam', maxSkus: 2 },
      });

      expect(res.statusCode).toBe(200);
      expect(adminMocks.mockFiroamGetPackages).toHaveBeenCalledTimes(2);
      expect(res.json()).toMatchObject({ ok: true, processedSkus: 2, totalSkus: 3 });
    });

    // ── TGT sync tests ───────────────────────────────────────────────────────

    it('breaks when processed equals total even if page is full', async () => {
      adminMocks.mockTgtListProducts.mockResolvedValue({
        total: 1,
        products: [
          {
            productCode: 'BREAK-001',
            productName: 'Break Test',
            productType: 'DATA_PACK',
            netPrice: 1.0,
          },
        ],
      });
      vi.mocked(prismaCatalog.upsert).mockResolvedValue(makeCatalogItem());

      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/sync',
        headers: JSON_HEADERS,
        // pageSize=1 means products.length (1) >= pageSize (1), so left branch is false
        // but processed (1) >= total (1) triggers the break via right branch
        payload: { provider: 'tgt', pageSize: 1, maxPages: 5, lang: 'en' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, processed: 1 });
      // Only one page fetched despite maxPages=5
      expect(adminMocks.mockTgtListProducts).toHaveBeenCalledTimes(1);
    });

    it('increments pageNum and fetches second page when first page is full and total not reached', async () => {
      // Page 1: products.length (1) === pageSize (1), so left condition is FALSE
      // processed (1) < total (2), so right condition is also FALSE → no break → pageNum += 1
      // Page 2: processed (2) >= total (2) → break
      adminMocks.mockTgtListProducts
        .mockResolvedValueOnce({
          total: 2,
          products: [
            {
              productCode: 'P1-001',
              productName: 'Product 1',
              productType: 'DATA_PACK',
              netPrice: 1.0,
            },
          ],
        })
        .mockResolvedValueOnce({
          total: 2,
          products: [
            {
              productCode: 'P2-001',
              productName: 'Product 2',
              productType: 'DATA_PACK',
              netPrice: 2.0,
            },
          ],
        });
      vi.mocked(prismaCatalog.upsert).mockResolvedValue(makeCatalogItem());

      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/sync',
        headers: JSON_HEADERS,
        payload: { provider: 'tgt', pageSize: 1, maxPages: 5, lang: 'en' },
      });

      expect(res.statusCode).toBe(200);
      expect(adminMocks.mockTgtListProducts).toHaveBeenCalledTimes(2);
      expect(res.json()).toMatchObject({ ok: true, processed: 2, total: 2 });
    });

    it('stores embeddings after FiRoam sync when entries are returned', async () => {
      adminMocks.mockFiroamGetSkus.mockResolvedValue({
        skus: [{ skuid: 100, display: 'Japan', countryCode: 'JP' }],
      });
      adminMocks.mockFiroamGetPackages.mockResolvedValue({
        packageData: {
          skuid: 100,
          detailId: null,
          countrycode: 'JP',
          imageUrl: '',
          display: '日本',
          displayEn: 'Japan',
          supportCountry: ['JP'],
          expirydate: null,
          countryImageUrlDtoList: [],
          esimPackageDtoList: [
            {
              flows: 1,
              days: 7,
              unit: 'GB',
              price: 2.5,
              priceid: 50,
              flowType: 1,
              countryImageUrlDtoList: null,
              showName: '1GB 7 Days',
              pid: 100,
              premark: '',
              expireDays: 0,
              networkDtoList: [],
              supportDaypass: 0,
              openCardFee: 0,
              minDay: 0,
              singleDiscountDay: 0,
              singleDiscount: 0,
              maxDiscount: 0,
              maxDay: 0,
              mustDate: 0,
              apiCode: 'JP-1GB-7D',
            },
          ],
        },
      });
      vi.mocked(prismaCatalog.upsert).mockResolvedValue(makeCatalogItem({ id: 'cat-jp-1' }));
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({ id: 'cat-jp-1', productName: 'Japan 1GB', region: 'JP' }),
      ]);
      adminMocks.mockEmbedBatch.mockResolvedValue([[0.1, 0.2, 0.3]]);

      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/sync',
        headers: JSON_HEADERS,
        payload: { provider: 'firoam' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, embedded: 1 });
      expect(adminMocks.mockStoreEmbedding).toHaveBeenCalledTimes(1);
    });

    it('stores parsedJson after FiRoam sync when parseCatalogEntry returns a result', async () => {
      adminMocks.mockFiroamGetSkus.mockResolvedValue({
        skus: [{ skuid: 200, display: 'EU', countryCode: 'EU' }],
      });
      adminMocks.mockFiroamGetPackages.mockResolvedValue({
        packageData: {
          skuid: 200,
          detailId: null,
          countrycode: 'EU',
          imageUrl: '',
          display: 'Europe',
          displayEn: 'Europe',
          supportCountry: ['DE', 'FR'],
          expirydate: null,
          countryImageUrlDtoList: [],
          esimPackageDtoList: [
            {
              flows: 1,
              days: 7,
              unit: 'GB',
              price: 3.0,
              priceid: 60,
              flowType: 1,
              countryImageUrlDtoList: null,
              showName: '1GB 7 Days',
              pid: 200,
              premark: '',
              expireDays: 0,
              networkDtoList: [],
              supportDaypass: 0,
              openCardFee: 0,
              minDay: 0,
              singleDiscountDay: 0,
              singleDiscount: 0,
              maxDiscount: 0,
              maxDay: 0,
              mustDate: 0,
              apiCode: 'EU-1GB-7D',
            },
          ],
        },
      });
      vi.mocked(prismaCatalog.upsert).mockResolvedValue(makeCatalogItem({ id: 'cat-eu-1' }));
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({ id: 'cat-eu-1', productName: 'Europe 1GB', region: 'EU' }),
      ] as unknown as []);
      adminMocks.mockEmbedBatch.mockResolvedValue([[0.1, 0.2, 0.3]]);
      adminMocks.mockStoreEmbedding.mockResolvedValue(undefined);
      adminMocks.mockParseCatalogEntry.mockResolvedValueOnce({
        regionCodes: ['EU'],
        dataMb: 1024,
        validityDays: 7,
      });
      vi.mocked(prisma.$executeRaw).mockResolvedValue(1 as never);

      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/sync',
        headers: JSON_HEADERS,
        payload: { provider: 'firoam' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, provider: 'firoam' });
      expect(vi.mocked(prisma.$executeRaw)).toHaveBeenCalled();
    });

    it('stores embeddings after TGT sync when entries are returned', async () => {
      adminMocks.mockTgtListProducts.mockResolvedValue({
        total: 1,
        products: [{ productCode: 'JP-1GB', productName: 'Japan 1GB', netPrice: 2.0 }],
      });
      vi.mocked(prismaCatalog.upsert).mockResolvedValue(makeCatalogItem({ id: 'cat-tgt-jp' }));
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({ id: 'cat-tgt-jp', productName: 'Japan 1GB', region: null }),
      ]);
      adminMocks.mockEmbedBatch.mockResolvedValue([[0.1, 0.2]]);

      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/sync',
        headers: JSON_HEADERS,
        payload: { provider: 'tgt' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, embedded: 1 });
      expect(adminMocks.mockStoreEmbedding).toHaveBeenCalledTimes(1);
    });

    it('stores parsedJson after TGT sync when parseCatalogEntry returns a result', async () => {
      adminMocks.mockTgtListProducts.mockResolvedValue({
        total: 1,
        products: [
          {
            productCode: 'TGT-EU-1GB-7D',
            productName: 'EU 1GB 7D',
            productType: 'DATA_PACK',
            countryCodeList: ['DE'],
            netPrice: 1.0,
            validityPeriod: 7,
            dataTotal: 1,
            dataUnit: 'GB',
            cardType: null,
            activeType: null,
          },
        ],
      });
      vi.mocked(prismaCatalog.upsert).mockResolvedValue(makeCatalogItem({ id: 'tgt-cat-1' }));
      // Embedding skipped (no OPENAI_API_KEY check for embedding, just return empty for findMany)
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({
          id: 'tgt-cat-1',
          productName: 'EU 1GB 7D',
          region: null,
          dataAmount: '1GB',
          validity: '7 days',
        }),
      ] as unknown as []);
      adminMocks.mockEmbedBatch.mockResolvedValue([[0.1, 0.2]]);
      adminMocks.mockStoreEmbedding.mockResolvedValue(undefined);
      // parseCatalogEntry returns a result
      adminMocks.mockParseCatalogEntry.mockResolvedValueOnce({
        regionCodes: ['EU'],
        dataMb: 1024,
        validityDays: 7,
      });
      vi.mocked(prisma.$executeRaw).mockResolvedValue(1 as never);

      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/sync',
        headers: JSON_HEADERS,
        payload: { provider: 'tgt', pageSize: 100, maxPages: 1 },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, provider: 'tgt' });
      // parsedJson was stored
      expect(vi.mocked(prisma.$executeRaw)).toHaveBeenCalled();
    });
  });

  // ── Catalog-linked SKU mapping flows ──────────────────────────────────────

  describe('POST /sku-mappings with providerCatalogId', () => {
    const catalogFindUnique = (
      prisma as unknown as { providerSkuCatalog: { findUnique: ReturnType<typeof vi.fn> } }
    ).providerSkuCatalog.findUnique;

    it('auto-derives firoam providerSku from catalog rawPayload (skuId:productCode:priceid)', async () => {
      catalogFindUnique.mockResolvedValue(
        makeCatalogItem({
          id: 'cat-firoam-001',
          provider: 'firoam',
          productCode: '826-0-3-1-G-D',
          rawPayload: { skuId: 120, priceid: 14094 },
        }),
      );
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.providerSkuMapping.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.providerSkuMapping.create).mockResolvedValue(
        makeMapping({
          providerCatalogId: 'cat-firoam-001',
          providerSku: '120:826-0-3-1-G-D:14094',
        }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings',
        headers: JSON_HEADERS,
        payload: {
          shopifySku: 'ESIM-US-5GB',
          provider: 'firoam',
          providerCatalogId: 'cat-firoam-001',
        },
      });

      expect(res.statusCode).toBe(201);
      expect(vi.mocked(prisma.providerSkuMapping.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            providerCatalogId: 'cat-firoam-001',
            providerSku: '120:826-0-3-1-G-D:14094',
          }),
        }),
      );
    });

    it('returns 400 when catalog entry not found', async () => {
      catalogFindUnique.mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings',
        headers: JSON_HEADERS,
        payload: { shopifySku: 'ESIM-US-5GB', provider: 'firoam', providerCatalogId: 'no-such-id' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Catalog entry not found');
    });

    it('returns 400 when firoam catalog entry rawPayload is missing skuId', async () => {
      catalogFindUnique.mockResolvedValue(
        makeCatalogItem({
          id: 'cat-firoam-empty',
          provider: 'firoam',
          productCode: '826-0-3-1-G-D',
          rawPayload: { priceid: 14094 },
        }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings',
        headers: JSON_HEADERS,
        payload: {
          shopifySku: 'ESIM-US-5GB',
          provider: 'firoam',
          providerCatalogId: 'cat-firoam-empty',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('missing required firoam fields');
    });
  });

  describe('PUT /sku-mappings/:id with providerCatalogId', () => {
    const catalogFindUnique = (
      prisma as unknown as { providerSkuCatalog: { findUnique: ReturnType<typeof vi.fn> } }
    ).providerSkuCatalog.findUnique;

    it('auto-populates derived validity and other metadata when not explicitly supplied', async () => {
      // existing mapping is 'tgt' so it matches the catalog entry provider
      const existing = makeMapping({ provider: 'tgt' });
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(existing);
      catalogFindUnique.mockResolvedValue(
        makeCatalogItem({
          id: 'cat-tgt-001',
          provider: 'tgt',
          productCode: 'A-001',
          productName: 'Israel 3GB',
          region: 'Middle East',
          dataAmount: '3GB',
          validity: '180 days',
        }),
      );
      vi.mocked(prisma.providerSkuMapping.update).mockResolvedValue(
        makeMapping({ providerCatalogId: 'cat-tgt-001', name: 'Israel 3GB', validity: '180 days' }),
      );

      await app.inject({
        method: 'PUT',
        url: '/sku-mappings/map-001',
        headers: JSON_HEADERS,
        // No name/region/dataAmount/validity in payload → derived from catalog
        payload: { providerCatalogId: 'cat-tgt-001' },
      });

      expect(vi.mocked(prisma.providerSkuMapping.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            providerCatalogId: 'cat-tgt-001',
            name: 'Israel 3GB',
            validity: '180 days',
          }),
        }),
      );
    });

    it('returns 400 when firoam catalog entry rawPayload is missing priceid', async () => {
      const existing = makeMapping({ provider: 'firoam' });
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(existing);
      catalogFindUnique.mockResolvedValue(
        makeCatalogItem({
          id: 'cat-firoam-empty',
          provider: 'firoam',
          productCode: '826-0-3-1-G-D',
          rawPayload: { skuId: 120 },
        }),
      );

      const res = await app.inject({
        method: 'PUT',
        url: '/sku-mappings/map-001',
        headers: JSON_HEADERS,
        payload: { providerCatalogId: 'cat-firoam-empty' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('missing required firoam fields');
    });

    it('sets providerCatalogId to null when null is passed (unlink)', async () => {
      const existing = makeMapping({ providerCatalogId: 'cat-old-001' });
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(existing);
      vi.mocked(prisma.providerSkuMapping.update).mockResolvedValue(
        makeMapping({ providerCatalogId: null }),
      );

      await app.inject({
        method: 'PUT',
        url: '/sku-mappings/map-001',
        headers: JSON_HEADERS,
        payload: { providerCatalogId: null },
      });

      expect(vi.mocked(prisma.providerSkuMapping.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ providerCatalogId: null }),
        }),
      );
    });
  });

  describe('GET /provider-catalog with search', () => {
    it('applies OR search filter across productCode, productName, and region', async () => {
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([]);
      vi.mocked(prismaCatalog.count).mockResolvedValue(0);

      const res = await app.inject({
        method: 'GET',
        url: '/provider-catalog?search=israel',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(vi.mocked(prismaCatalog.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ productName: expect.anything() }),
            ]),
          }),
        }),
      );
    });
  });

  // ── PUT /sku-mappings/reorder ─────────────────────────────────────────────

  describe('PUT /sku-mappings/reorder', () => {
    it('reorders mappings by assigning priority = index + 1', async () => {
      vi.mocked(prisma.providerSkuMapping.update).mockResolvedValue(makeMapping());
      // $transaction mock — prisma.$transaction is not mocked yet; add it dynamically
      const prismaMock = prisma as unknown as { $transaction: ReturnType<typeof vi.fn> };
      prismaMock.$transaction = vi.fn().mockResolvedValue([]);

      const res = await app.inject({
        method: 'PUT',
        url: '/sku-mappings/reorder',
        headers: JSON_HEADERS,
        payload: { shopifySku: 'ESIM-USA-10GB', orderedIds: ['map-001', 'map-002'] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('returns 400 when shopifySku is missing', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/sku-mappings/reorder',
        headers: JSON_HEADERS,
        payload: { orderedIds: ['map-001'] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when orderedIds is not an array', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/sku-mappings/reorder',
        headers: JSON_HEADERS,
        payload: { shopifySku: 'ESIM-USA-10GB', orderedIds: 'map-001' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── POST /sku-mappings/smart-pricing ────────────────────────────────────────

  describe('POST /sku-mappings/smart-pricing', () => {
    it('returns ok with updated/skipped counts', async () => {
      // m1 is currently priority 1 (higher priority) but is MORE expensive —
      // smart pricing should reorder so the cheaper m2 becomes priority 1
      const m1 = makeMapping({
        id: 'map-001',
        provider: 'firoam',
        priority: 1,
        providerCatalogId: 'cat-1',
      });
      const m2 = makeMapping({
        id: 'map-002',
        provider: 'tgt',
        priority: 2,
        providerCatalogId: 'cat-2',
      });
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([
        { ...m1, catalogEntry: { netPrice: 5.0 } },
        { ...m2, catalogEntry: { netPrice: 3.0 } },
      ] as never);
      const prismaMock = prisma as unknown as { $transaction: ReturnType<typeof vi.fn> };
      prismaMock.$transaction = vi.fn().mockResolvedValue([]);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/smart-pricing',
        headers: JSON_HEADERS,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(typeof res.json().updated).toBe('number');
    });

    it('skips all groups with only one unlocked mapping', async () => {
      const m = makeMapping({ providerCatalogId: 'cat-1' });
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([
        { ...m, catalogEntry: { netPrice: 5.0 } },
      ] as never);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/smart-pricing',
        headers: JSON_HEADERS,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().skipped).toBe(1);
      expect(res.json().updated).toBe(0);
    });
  });

  // ── GET /shopify-skus ────────────────────────────────────────────────────

  describe('GET /shopify-skus', () => {
    beforeEach(() => {
      vi.mocked(prisma.shopifyVariant.count).mockResolvedValue(0);
      vi.mocked(prisma.shopifyVariant.findMany).mockResolvedValue([]);
    });

    it('returns variants from DB', async () => {
      vi.mocked(prisma.shopifyVariant.count).mockResolvedValue(2);
      vi.mocked(prisma.shopifyVariant.findMany).mockResolvedValue([
        {
          variantId: 'gid://shopify/ProductVariant/1',
          sku: 'ESIM-US-1GB',
          productTitle: 'US eSIM',
          variantTitle: '1GB',
          price: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          variantId: 'gid://shopify/ProductVariant/2',
          sku: 'ESIM-JP-5GB',
          productTitle: 'Japan eSIM',
          variantTitle: '5GB',
          price: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ] as never);

      const res = await app.inject({ method: 'GET', url: '/shopify-skus', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(res.json().skus).toHaveLength(2);
      expect(res.json().total).toBe(2);
    });

    it('filters out already-mapped SKUs when unmappedOnly=true', async () => {
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([
        makeMapping({ shopifySku: 'ESIM-US-1GB' }),
      ]);
      vi.mocked(prisma.shopifyVariant.count).mockResolvedValue(1);
      vi.mocked(prisma.shopifyVariant.findMany).mockResolvedValue([
        {
          variantId: 'gid://shopify/ProductVariant/2',
          sku: 'ESIM-JP-5GB',
          productTitle: 'JP',
          variantTitle: '5GB',
          price: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ] as never);

      const res = await app.inject({
        method: 'GET',
        url: '/shopify-skus?unmappedOnly=true',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().skus).toHaveLength(1);
      expect(res.json().skus[0].sku).toBe('ESIM-JP-5GB');
    });

    it('returns empty list when no variants have been synced yet', async () => {
      const res = await app.inject({ method: 'GET', url: '/shopify-skus', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(res.json().skus).toHaveLength(0);
      expect(res.json().total).toBe(0);
    });
  });

  // ── POST /sku-mappings/ai-map ─────────────────────────────────────────────

  describe('POST /sku-mappings/ai-map', () => {
    beforeEach(() => {
      // Multi-provider discovery: return a single provider so the per-provider loop
      // behaves identically to the old single-provider path in existing tests.
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ provider: 'firoam' }]);
    });

    it('returns draft mappings from OpenAI', async () => {
      adminMocks.mockGetAllVariants.mockResolvedValue([
        { sku: 'ESIM-JP-1GB', variantId: 'gid://1', productTitle: 'Japan', variantTitle: '1GB' },
      ]);
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({ id: 'cat-jp-1gb', productName: 'Japan 1GB 3 Days', region: 'JP' }),
      ]);
      adminMocks.mockOpenAiCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mappings: [
                  {
                    shopifySku: 'ESIM-JP-1GB',
                    catalogId: 'cat-jp-1gb',
                    confidence: 0.9,
                    reason: 'Exact match',
                  },
                ],
              }),
            },
          },
        ],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().drafts).toHaveLength(1);
      expect(res.json().drafts[0].shopifySku).toBe('ESIM-JP-1GB');
      expect(res.json().drafts[0].confidence).toBe(0.9);
    });

    it('returns empty drafts when no SKUs to map', async () => {
      adminMocks.mockGetAllVariants.mockResolvedValue([]);
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().drafts).toHaveLength(0);
    });

    it('returns 500 when OPENAI_API_KEY is not set', async () => {
      const savedKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { shopifySkus: ['ESIM-JP-1GB'] },
      });

      expect(res.statusCode).toBe(500);
      process.env.OPENAI_API_KEY = savedKey;
    });

    it('uses provided shopifySkus list instead of fetching from Shopify', async () => {
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({ id: 'cat-jp-1gb', productName: 'Japan 1GB' }),
      ]);
      adminMocks.mockOpenAiCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ mappings: [] }) } }],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { shopifySkus: ['ESIM-JP-1GB', 'ESIM-US-5GB'] },
      });

      expect(res.statusCode).toBe(200);
      // Shopify getAllVariants should NOT have been called
      expect(adminMocks.mockGetAllVariants).not.toHaveBeenCalled();
    });

    it('returns empty drafts when catalog has no entries', async () => {
      adminMocks.mockGetAllVariants.mockResolvedValue([
        { sku: 'ESIM-JP-1GB', variantId: 'gid://1', productTitle: 'Japan', variantTitle: '1GB' },
      ]);
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([]);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().drafts).toHaveLength(0);
    });

    it('returns 502 when OpenAI throws and no drafts were produced', async () => {
      adminMocks.mockGetAllVariants.mockResolvedValue([
        { sku: 'ESIM-JP-1GB', variantId: 'gid://1', productTitle: 'Japan', variantTitle: '1GB' },
      ]);
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({ id: 'cat-jp', productName: 'Japan 1GB' }),
      ]);
      adminMocks.mockOpenAiCreate.mockRejectedValue(new Error('OpenAI rate limit'));

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toMatch(/OpenAI error/);
    });

    it('short-circuits immediately on fatal OpenAI quota error (429)', async () => {
      // Use >50 SKUs so there would be 2 batches if not short-circuited
      const manySkus = Array.from({ length: 55 }, (_, i) => ({
        sku: `ESIM-JP-${i}GB`,
        variantId: `gid://${i}`,
        productTitle: 'Japan',
        variantTitle: `${i}GB`,
      }));
      adminMocks.mockGetAllVariants.mockResolvedValue(manySkus);
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({ id: 'cat-jp', productName: 'Japan 1GB' }),
      ]);
      // First batch throws a fatal quota error; a second call should never happen
      adminMocks.mockOpenAiCreate.mockRejectedValueOnce(
        new OpenAI.APIError(429, undefined, 'You exceeded your current quota', undefined),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toMatch(/OpenAI error.*quota/);
      // Handler must have broken after the first batch — not called a second time
      expect(adminMocks.mockOpenAiCreate).toHaveBeenCalledTimes(1);
    });

    it('short-circuits immediately on fatal error identified by error code', async () => {
      // >50 SKUs → 2 batches; error code path (status ≠ 401/429) must still be fatal
      const manySkus = Array.from({ length: 55 }, (_, i) => ({
        sku: `ESIM-JP-${i}GB`,
        variantId: `gid://${i}`,
        productTitle: 'Japan',
        variantTitle: `${i}GB`,
      }));
      adminMocks.mockGetAllVariants.mockResolvedValue(manySkus);
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({ id: 'cat-jp', productName: 'Japan 1GB' }),
      ]);
      const codeErr = Object.assign(
        new OpenAI.APIError(200, undefined, 'insufficient quota', undefined),
        { code: 'insufficient_quota' },
      );
      adminMocks.mockOpenAiCreate.mockRejectedValueOnce(codeErr);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      expect(res.statusCode).toBe(502);
      expect(adminMocks.mockOpenAiCreate).toHaveBeenCalledTimes(1);
    });

    it('returns 502 when Shopify fetch fails', async () => {
      adminMocks.mockGetAllVariants.mockRejectedValue(new Error('Shopify timeout'));

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('shopify_unavailable');
    });

    it('returns partial drafts with warning when fatal OpenAI error occurs after first batch succeeds', async () => {
      // 55 SKUs → 2 batches; first batch succeeds, second batch gets fatal error
      const manySkus = Array.from({ length: 55 }, (_, i) => ({
        sku: `ESIM-JP-${i}GB`,
        variantId: `gid://${i}`,
        productTitle: 'Japan',
        variantTitle: `${i}GB`,
      }));
      adminMocks.mockGetAllVariants.mockResolvedValue(manySkus);
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({ id: 'cat-jp', productName: 'Japan 1GB' }),
      ]);
      // First batch succeeds with a match; second batch throws fatal quota error
      adminMocks.mockOpenAiCreate
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  mappings: [
                    {
                      shopifySku: 'ESIM-JP-0GB',
                      catalogId: 'cat-jp',
                      confidence: 0.9,
                      reason: 'Match',
                    },
                  ],
                }),
              },
            },
          ],
        })
        .mockRejectedValueOnce(
          new OpenAI.APIError(429, undefined, 'You exceeded your current quota', undefined),
        );

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      // Partial drafts exist from first batch → 200 with warning, not 502
      expect(res.statusCode).toBe(200);
      expect(res.json().drafts.length).toBeGreaterThan(0);
      expect(res.json().warning).toBeDefined();
    });
  });

  // ── POST /sku-mappings/ai-map — vector path ───────────────────────────────

  describe('POST /sku-mappings/ai-map — vector path', () => {
    beforeEach(() => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ provider: 'firoam' }]);
    });

    it('uses findTopCandidates instead of full catalog when isVectorAvailable returns true', async () => {
      adminMocks.mockIsVectorAvailable.mockResolvedValue(true);
      adminMocks.mockEmbedBatch.mockResolvedValue([[0.1, 0.2, 0.3]]);
      adminMocks.mockFindTopCandidates.mockResolvedValue([
        makeCatalogItem({ id: 'cat-vector-1', productName: 'Japan 1GB 3 Days', region: 'JP' }),
      ]);

      adminMocks.mockGetAllVariants.mockResolvedValue([
        { sku: 'ESIM-JP-1GB', variantId: 'gid://1', productTitle: 'Japan', variantTitle: '1GB' },
      ]);
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({ id: 'cat-vector-1', productName: 'Japan 1GB 3 Days', region: 'JP' }),
      ]);
      adminMocks.mockOpenAiCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mappings: [
                  {
                    shopifySku: 'ESIM-JP-1GB',
                    catalogId: 'cat-vector-1',
                    confidence: 0.95,
                    reason: 'Vector match',
                  },
                ],
              }),
            },
          },
        ],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().drafts).toHaveLength(1);
      expect(adminMocks.mockFindTopCandidates).toHaveBeenCalledTimes(1);
    });

    it('falls back to full catalog when findTopCandidates returns empty results', async () => {
      adminMocks.mockIsVectorAvailable.mockResolvedValue(true);
      adminMocks.mockEmbedBatch.mockResolvedValue([[0.1, 0.2]]);
      adminMocks.mockFindTopCandidates.mockResolvedValue([]); // empty → fallback to full catalog

      adminMocks.mockGetAllVariants.mockResolvedValue([
        { sku: 'ESIM-JP-1GB', variantId: 'gid://1', productTitle: 'Japan', variantTitle: '1GB' },
      ]);
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({ id: 'cat-jp', productName: 'Japan 1GB' }),
      ]);
      adminMocks.mockOpenAiCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ mappings: [] }) } }],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      expect(res.statusCode).toBe(200);
      // findTopCandidates was called but returned empty, so full catalog was used as fallback
      expect(adminMocks.mockFindTopCandidates).toHaveBeenCalledTimes(1);
    });

    it('falls back to full catalog when isVectorAvailable returns false', async () => {
      adminMocks.mockIsVectorAvailable.mockResolvedValue(false);

      adminMocks.mockGetAllVariants.mockResolvedValue([
        { sku: 'ESIM-JP-1GB', variantId: 'gid://1', productTitle: 'Japan', variantTitle: '1GB' },
      ]);
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({ id: 'cat-jp', productName: 'Japan 1GB' }),
      ]);
      adminMocks.mockOpenAiCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ mappings: [] }) } }],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      expect(res.statusCode).toBe(200);
      // findTopCandidates should NOT be called in fallback mode
      expect(adminMocks.mockFindTopCandidates).not.toHaveBeenCalled();
    });

    it('short-circuits immediately on fatal OpenAI error in vector path', async () => {
      adminMocks.mockIsVectorAvailable.mockResolvedValue(true);
      adminMocks.mockEmbedBatch.mockResolvedValue([[0.1, 0.2, 0.3]]);
      adminMocks.mockFindTopCandidates.mockResolvedValue([
        makeCatalogItem({ id: 'cat-firoam', productName: 'Japan 1GB', region: 'JP' }),
      ]);
      adminMocks.mockGetAllVariants.mockResolvedValue([
        { sku: 'ESIM-JP-1GB', variantId: 'gid://1', productTitle: 'Japan', variantTitle: '1GB' },
      ]);
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({ id: 'cat-firoam', productName: 'Japan 1GB', region: 'JP' }),
      ]);
      adminMocks.mockOpenAiCreate.mockRejectedValueOnce(
        new OpenAI.APIError(429, undefined, 'You exceeded your current quota', undefined),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toMatch(/OpenAI error.*quota/);
    });
  });

  // ── POST /sku-mappings/ai-map — packageType + daysCount derivation ─────────

  describe('POST /sku-mappings/ai-map — packageType/daysCount derivation', () => {
    beforeEach(() => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ provider: 'firoam' }]);
      adminMocks.mockIsVectorAvailable.mockResolvedValue(false);
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
    });

    it('sets packageType=daypass and daysCount from SKU when catalog productCode contains ?', async () => {
      adminMocks.mockGetAllVariants.mockResolvedValue([
        {
          sku: 'SA-1GB-3D-DAYPASS',
          variantId: 'gid://dp-1',
          productTitle: 'SA',
          variantTitle: 'Daypass',
        },
      ]);
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({
          id: 'cat-sa-dp',
          productName: 'SA 1GB Daily',
          region: 'SA',
          dataAmount: '1GB',
          productCode: 'SA-1GB-DAY?1',
          parsedJson: { regionCodes: ['SA'], dataMb: 1024, validityDays: 1 },
        }),
      ]);
      adminMocks.mockOpenAiCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mappings: [
                  {
                    shopifySku: 'SA-1GB-3D-DAYPASS',
                    catalogId: 'cat-sa-dp',
                    confidence: 0.95,
                    reason: 'daypass match',
                  },
                ],
              }),
            },
          },
        ],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { shopifySkus: ['SA-1GB-3D-DAYPASS'], unmappedOnly: false },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { drafts: Array<{ packageType: string; daysCount: number }> };
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0].packageType).toBe('daypass');
      expect(body.drafts[0].daysCount).toBe(3); // from SA-1GB-3D-DAYPASS
    });
  });

  // ── POST /sku-mappings/ai-map — relaxOptions post-filter ─────────────────

  describe('POST /sku-mappings/ai-map — relaxOptions post-filter', () => {
    beforeEach(() => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ provider: 'firoam' }]);
      adminMocks.mockIsVectorAvailable.mockResolvedValue(false);
      adminMocks.mockGetAllVariants.mockResolvedValue([]);
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
    });

    it('drops data-mismatched draft when requireData is true (default)', async () => {
      // SA-2GB-7D-FIXED parses to dataMb=2048; catalog has dataMb=5120 → mismatch
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({
          id: 'cat-sa-5gb',
          productName: 'SA 5GB 7D',
          region: 'SA',
          dataAmount: '5GB',
          parsedJson: { regionCodes: ['SA'], dataMb: 5120, validityDays: 7 },
        }),
      ]);
      adminMocks.mockOpenAiCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mappings: [
                  {
                    shopifySku: 'SA-2GB-7D-FIXED',
                    catalogId: 'cat-sa-5gb',
                    confidence: 0.9,
                    reason: 'GPT match',
                  },
                ],
              }),
            },
          },
        ],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { shopifySkus: ['SA-2GB-7D-FIXED'], unmappedOnly: false },
      });

      expect(res.statusCode).toBe(200);
      // Data mismatch → filtered out despite GPT returning it
      expect(res.json().drafts).toHaveLength(0);
    });

    it('drops validity-mismatched draft when requireValidity is true (default)', async () => {
      // SA-2GB-1D-FIXED parses to validityDays=1; catalog has validityDays=7 → mismatch
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({
          id: 'cat-sa-2gb-7d',
          productName: 'SA 2GB 7D',
          region: 'SA',
          dataAmount: '2GB',
          parsedJson: { regionCodes: ['SA'], dataMb: 2048, validityDays: 7 },
        }),
      ]);
      adminMocks.mockOpenAiCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mappings: [
                  {
                    shopifySku: 'SA-2GB-1D-FIXED',
                    catalogId: 'cat-sa-2gb-7d',
                    confidence: 0.9,
                    reason: 'GPT match',
                  },
                ],
              }),
            },
          },
        ],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { shopifySkus: ['SA-2GB-1D-FIXED'], unmappedOnly: false },
      });

      expect(res.statusCode).toBe(200);
      // Validity mismatch (1D SKU vs 7D catalog) → filtered out
      expect(res.json().drafts).toHaveLength(0);
    });

    it('keeps DAYPASS draft regardless of catalog validityDays', async () => {
      // DAYPASS: validity is always ignored — catalog entry is a daily plan (validityDays=1)
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({
          id: 'cat-sa-2gb-daypass',
          productName: 'SA 2GB Daypass',
          region: 'SA',
          dataAmount: '2GB',
          productCode: 'SA-2GB-DAILY?1',
          parsedJson: { regionCodes: ['SA'], dataMb: 2048, validityDays: 1 },
        }),
      ]);
      adminMocks.mockOpenAiCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mappings: [
                  {
                    shopifySku: 'SA-2GB-1D-DAYPASS',
                    catalogId: 'cat-sa-2gb-daypass',
                    confidence: 0.9,
                    reason: 'DAYPASS match',
                  },
                ],
              }),
            },
          },
        ],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { shopifySkus: ['SA-2GB-1D-DAYPASS'], unmappedOnly: false },
      });

      expect(res.statusCode).toBe(200);
      // Validity is ignored for DAYPASS — draft always kept when region+data match
      expect(res.json().drafts).toHaveLength(1);
      expect(res.json().drafts[0].shopifySku).toBe('SA-2GB-1D-DAYPASS');
    });

    it('keeps validity-mismatched draft when requireValidity=false', async () => {
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({
          id: 'cat-sa-2gb-7d',
          productName: 'SA 2GB 7D',
          region: 'SA',
          dataAmount: '2GB',
          parsedJson: { regionCodes: ['SA'], dataMb: 2048, validityDays: 7 },
        }),
      ]);
      adminMocks.mockOpenAiCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mappings: [
                  {
                    shopifySku: 'SA-2GB-1D-FIXED',
                    catalogId: 'cat-sa-2gb-7d',
                    confidence: 0.9,
                    reason: 'GPT match',
                  },
                ],
              }),
            },
          },
        ],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: {
          shopifySkus: ['SA-2GB-1D-FIXED'],
          unmappedOnly: false,
          relaxOptions: { requireValidity: false },
        },
      });

      expect(res.statusCode).toBe(200);
      // requireValidity=false → validity mismatch is allowed
      expect(res.json().drafts).toHaveLength(1);
    });

    it('drops region-mismatched draft when regionCodes does not include SKU region', async () => {
      // SA-2GB-7D-FIXED parses to regionCode=SA; catalog has regionCodes=['EU'] → mismatch
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({
          id: 'cat-eu-2gb-7d',
          productName: 'EU 2GB 7D',
          region: 'EU',
          dataAmount: '2GB',
          parsedJson: { regionCodes: ['EU'], dataMb: 2048, validityDays: 7 },
        }),
      ]);
      adminMocks.mockOpenAiCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mappings: [
                  {
                    shopifySku: 'SA-2GB-7D-FIXED',
                    catalogId: 'cat-eu-2gb-7d',
                    confidence: 0.8,
                    reason: 'GPT region mismatch',
                  },
                ],
              }),
            },
          },
        ],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { shopifySkus: ['SA-2GB-7D-FIXED'], unmappedOnly: false },
      });

      expect(res.statusCode).toBe(200);
      // Region mismatch (SA SKU vs EU catalog) → filtered out
      expect(res.json().drafts).toHaveLength(0);
    });
  });

  // ── POST /sku-mappings/ai-map — multi-provider mode ───────────────────────

  describe('POST /sku-mappings/ai-map — multi-provider mode', () => {
    it('runs one matching pass per provider and returns drafts from all providers', async () => {
      // Two active providers discovered via $queryRaw
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ provider: 'firoam' }, { provider: 'tgt' }]);
      adminMocks.mockIsVectorAvailable.mockResolvedValue(false);
      adminMocks.mockGetAllVariants.mockResolvedValue([
        { sku: 'ESIM-JP-1GB', variantId: 'gid://1', productTitle: 'Japan', variantTitle: '1GB' },
      ]);
      // unmappedOnly=false → no filter calls; prismaCatalog.findMany called twice (once per provider)
      vi.mocked(prismaCatalog.findMany)
        .mockResolvedValueOnce([
          makeCatalogItem({ id: 'firoam-jp', productName: 'Japan 1GB', provider: 'firoam' }),
        ])
        .mockResolvedValueOnce([
          makeCatalogItem({ id: 'tgt-jp', productName: 'Japan 1GB TGT', provider: 'tgt' }),
        ]);
      adminMocks.mockOpenAiCreate
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  mappings: [
                    {
                      shopifySku: 'ESIM-JP-1GB',
                      catalogId: 'firoam-jp',
                      confidence: 0.9,
                      reason: 'FiRoam match',
                    },
                  ],
                }),
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  mappings: [
                    {
                      shopifySku: 'ESIM-JP-1GB',
                      catalogId: 'tgt-jp',
                      confidence: 0.85,
                      reason: 'TGT match',
                    },
                  ],
                }),
              },
            },
          ],
        });

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      expect(res.statusCode).toBe(200);
      const { drafts } = res.json();
      // Both providers should produce a draft
      expect(drafts).toHaveLength(2);
      expect(drafts.map((d: { provider: string }) => d.provider).sort()).toEqual(['firoam', 'tgt']);
      // GPT called once per provider
      expect(adminMocks.mockOpenAiCreate).toHaveBeenCalledTimes(2);
    });

    it('skips provider with empty catalog and still processes remaining providers', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ provider: 'firoam' }, { provider: 'tgt' }]);
      adminMocks.mockIsVectorAvailable.mockResolvedValue(false);
      adminMocks.mockGetAllVariants.mockResolvedValue([
        { sku: 'ESIM-JP-1GB', variantId: 'gid://1', productTitle: 'Japan', variantTitle: '1GB' },
      ]);
      // firoam catalog empty → skipped; tgt has entries
      vi.mocked(prismaCatalog.findMany)
        .mockResolvedValueOnce([]) // firoam catalog empty
        .mockResolvedValueOnce([
          makeCatalogItem({ id: 'tgt-jp', productName: 'Japan TGT', provider: 'tgt' }),
        ]);
      adminMocks.mockOpenAiCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mappings: [
                  {
                    shopifySku: 'ESIM-JP-1GB',
                    catalogId: 'tgt-jp',
                    confidence: 0.85,
                    reason: 'TGT',
                  },
                ],
              }),
            },
          },
        ],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      expect(res.statusCode).toBe(200);
      const { drafts } = res.json();
      expect(drafts).toHaveLength(1);
      expect(drafts[0].provider).toBe('tgt');
      expect(adminMocks.mockOpenAiCreate).toHaveBeenCalledTimes(1);
    });

    it('returns empty drafts when no active providers are in catalog', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([]); // no active providers
      adminMocks.mockGetAllVariants.mockResolvedValue([
        { sku: 'ESIM-JP-1GB', variantId: 'gid://1', productTitle: 'Japan', variantTitle: '1GB' },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().drafts).toHaveLength(0);
    });

    it('applies unmapped filter per-provider so SKUs mapped to one provider still get mapped to others', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ provider: 'firoam' }, { provider: 'tgt' }]);
      adminMocks.mockIsVectorAvailable.mockResolvedValue(false);
      adminMocks.mockGetAllVariants.mockResolvedValue([
        { sku: 'ESIM-JP-1GB', variantId: 'gid://1', productTitle: 'Japan', variantTitle: '1GB' },
      ]);
      // ESIM-JP-1GB is already mapped to firoam but NOT to tgt
      vi.mocked(prisma.providerSkuMapping.findMany)
        .mockResolvedValueOnce([{ shopifySku: 'ESIM-JP-1GB' } as never]) // firoam already mapped
        .mockResolvedValueOnce([]); // tgt not mapped
      // firoam is filtered out entirely (no SKUs remain), so catalog is only fetched for tgt
      vi.mocked(prismaCatalog.findMany).mockResolvedValueOnce([
        makeCatalogItem({ id: 'tgt-jp', productName: 'Japan 1GB TGT', provider: 'tgt' }),
      ]);
      adminMocks.mockOpenAiCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mappings: [
                  {
                    shopifySku: 'ESIM-JP-1GB',
                    catalogId: 'tgt-jp',
                    confidence: 0.85,
                    reason: 'TGT match',
                  },
                ],
              }),
            },
          },
        ],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map',
        headers: JSON_HEADERS,
        payload: {}, // unmappedOnly defaults to true
      });

      expect(res.statusCode).toBe(200);
      const { drafts } = res.json();
      // Only TGT draft — firoam was filtered out as already mapped
      expect(drafts).toHaveLength(1);
      expect(drafts[0].provider).toBe('tgt');
    });
  });

  // ── GET /sku-mappings/ai-map/stream ──────────────────────────────────────

  describe('GET /sku-mappings/ai-map/stream', () => {
    beforeEach(() => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ provider: 'firoam' }]);
    });

    it('returns SSE response with progress and done events', async () => {
      adminMocks.mockIsVectorAvailable.mockResolvedValue(false);
      adminMocks.mockGetAllVariants.mockResolvedValue([
        { sku: 'ESIM-JP-1GB', variantId: 'gid://1', productTitle: 'Japan', variantTitle: '1GB' },
      ]);
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({ id: 'cat-jp', productName: 'Japan 1GB' }),
      ]);
      adminMocks.mockOpenAiCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mappings: [
                  {
                    shopifySku: 'ESIM-JP-1GB',
                    catalogId: 'cat-jp',
                    confidence: 0.9,
                    reason: 'Match',
                  },
                ],
              }),
            },
          },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/ai-map/stream?unmappedOnly=false',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.body).toContain('event: progress');
      expect(res.body).toContain('event: done');
    });

    it('returns 401 when x-admin-key header is missing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/ai-map/stream',
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 401 when x-admin-key header is wrong', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/ai-map/stream',
        headers: { 'x-admin-key': 'wrong-key' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('accepts valid x-admin-key header', async () => {
      adminMocks.mockIsVectorAvailable.mockResolvedValue(false);
      adminMocks.mockGetAllVariants.mockResolvedValue([]);
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);

      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/ai-map/stream',
        headers: AUTH,
      });

      // No SKUs → generator returns immediately → done event only
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('event: done');
    });

    it('streams error event when OPENAI_API_KEY is missing', async () => {
      const savedKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/ai-map/stream',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('event: error');
      process.env.OPENAI_API_KEY = savedKey;
    });

    it('streams error event when Shopify fetch fails inside generator', async () => {
      adminMocks.mockIsVectorAvailable.mockResolvedValue(false);
      adminMocks.mockGetAllVariants.mockRejectedValue(new Error('Shopify down'));

      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/ai-map/stream?unmappedOnly=false',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('event: error');
    });

    it('streams error event when OpenAI throws a fatal error', async () => {
      adminMocks.mockIsVectorAvailable.mockResolvedValue(false);
      adminMocks.mockGetAllVariants.mockResolvedValue([
        { sku: 'ESIM-JP-1GB', variantId: 'gid://1', productTitle: 'Japan', variantTitle: '1GB' },
      ]);
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({ id: 'cat-jp', productName: 'Japan 1GB' }),
      ]);
      adminMocks.mockOpenAiCreate.mockRejectedValue(
        new OpenAI.APIError(429, undefined, 'quota exceeded', undefined),
      );

      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/ai-map/stream?unmappedOnly=false',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('event: error');
    });
  });

  // ── POST /provider-catalog/embed-backfill ─────────────────────────────────

  describe('POST /provider-catalog/embed-backfill', () => {
    it('calls backfillMissingEmbeddings and returns embedded count', async () => {
      adminMocks.mockBackfillMissingEmbeddings.mockResolvedValue(42);

      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/embed-backfill',
        headers: JSON_HEADERS,
        payload: { provider: 'tgt' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, embedded: 42 });
      expect(adminMocks.mockBackfillMissingEmbeddings).toHaveBeenCalledTimes(1);
    });

    it('returns 500 when OPENAI_API_KEY is not set', async () => {
      const savedKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/embed-backfill',
        headers: JSON_HEADERS,
        payload: {},
      });

      expect(res.statusCode).toBe(500);
      process.env.OPENAI_API_KEY = savedKey;
    });

    it('returns 401 without admin key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/embed-backfill',
        payload: {},
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ── POST /sku-mappings/bulk ───────────────────────────────────────────────

  describe('POST /sku-mappings/bulk', () => {
    const tgtCatalogEntry = makeCatalogItem({
      id: 'cat-tgt-1',
      provider: 'tgt',
      productCode: 'A-002-ES-AU-T-30D',
      productName: 'Australia 3GB',
    });

    it('creates multiple mappings and returns per-item results', async () => {
      vi.mocked(prismaCatalog.findUnique).mockResolvedValue(tgtCatalogEntry);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.providerSkuMapping.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.providerSkuMapping.create).mockResolvedValue(makeMapping());

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/bulk',
        headers: JSON_HEADERS,
        payload: {
          mappings: [
            { shopifySku: 'ESIM-AU-3GB', provider: 'tgt', providerCatalogId: 'cat-tgt-1' },
            { shopifySku: 'ESIM-AU-5GB', provider: 'tgt', providerCatalogId: 'cat-tgt-1' },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ created: number; failed: number }>();
      expect(body.created).toBe(2);
      expect(body.failed).toBe(0);
    });

    it('returns 400 when mappings array is missing or empty', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/bulk',
        headers: JSON_HEADERS,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('skips existing mapping idempotently', async () => {
      vi.mocked(prismaCatalog.findUnique).mockResolvedValue(tgtCatalogEntry);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(makeMapping());

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/bulk',
        headers: JSON_HEADERS,
        payload: {
          mappings: [
            { shopifySku: 'ESIM-AU-3GB', provider: 'tgt', providerCatalogId: 'cat-tgt-1' },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ created: number; skipped: number; failed: number }>();
      expect(body.created).toBe(0);
      expect(body.skipped).toBe(1);
      expect(body.failed).toBe(0);
      expect(prisma.providerSkuMapping.create).not.toHaveBeenCalled();
    });

    it('records per-item failure when catalog entry not found', async () => {
      vi.mocked(prismaCatalog.findUnique).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/bulk',
        headers: JSON_HEADERS,
        payload: {
          mappings: [
            { shopifySku: 'ESIM-AU-3GB', provider: 'tgt', providerCatalogId: 'cat-missing' },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ created: number; failed: number }>();
      expect(body.created).toBe(0);
      expect(body.failed).toBe(1);
    });

    it('records per-item failure when required fields are missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/bulk',
        headers: JSON_HEADERS,
        payload: {
          mappings: [{ shopifySku: 'ESIM-AU-3GB' }], // missing provider + catalogId
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ created: number; failed: number }>();
      expect(body.failed).toBe(1);
    });

    it('derives providerSku from firoam rawPayload', async () => {
      const firoamCatalogEntry = makeCatalogItem({
        id: 'cat-firoam-1',
        provider: 'firoam',
        productCode: '826-0-?-1-G-D',
        rawPayload: { skuId: '120', priceid: '14094' } as unknown,
      });
      vi.mocked(prismaCatalog.findUnique).mockResolvedValue(firoamCatalogEntry);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.providerSkuMapping.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.providerSkuMapping.create).mockResolvedValue(makeMapping());

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/bulk',
        headers: JSON_HEADERS,
        payload: {
          mappings: [
            { shopifySku: 'ESIM-US-10GB', provider: 'firoam', providerCatalogId: 'cat-firoam-1' },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ created: number }>();
      expect(body.created).toBe(1);
    });

    it('records failure when firoam catalog rawPayload is missing required fields', async () => {
      const badFiroamEntry = makeCatalogItem({
        id: 'cat-firoam-bad',
        provider: 'firoam',
        productCode: '826-0',
        rawPayload: {} as unknown,
      });
      vi.mocked(prismaCatalog.findUnique).mockResolvedValue(badFiroamEntry);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/bulk',
        headers: JSON_HEADERS,
        payload: {
          mappings: [
            { shopifySku: 'ESIM-US-10GB', provider: 'firoam', providerCatalogId: 'cat-firoam-bad' },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ created: number; failed: number }>();
      expect(body.failed).toBe(1);
    });

    it('replaces existing mapping when forceReplace=true', async () => {
      vi.mocked(prismaCatalog.findUnique).mockResolvedValue(tgtCatalogEntry);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(makeMapping());
      vi.mocked(prisma.providerSkuMapping.update).mockResolvedValue(makeMapping());

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/bulk',
        headers: JSON_HEADERS,
        payload: {
          forceReplace: true,
          mappings: [
            { shopifySku: 'ESIM-AU-3GB', provider: 'tgt', providerCatalogId: 'cat-tgt-1' },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ created: number; updated: number; failed: number }>();
      expect(body.created).toBe(0);
      expect(body.updated).toBe(1);
      expect(body.failed).toBe(0);
      expect(prisma.providerSkuMapping.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { shopifySku_provider: { shopifySku: 'ESIM-AU-3GB', provider: 'tgt' } },
        }),
      );
    });

    it('records failure when create throws a non-Error value', async () => {
      vi.mocked(prismaCatalog.findUnique).mockResolvedValue(tgtCatalogEntry);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.providerSkuMapping.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.providerSkuMapping.create).mockRejectedValue('db connection lost');

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/bulk',
        headers: JSON_HEADERS,
        payload: {
          mappings: [
            { shopifySku: 'ESIM-AU-3GB', provider: 'tgt', providerCatalogId: 'cat-tgt-1' },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ created: number; failed: number }>();
      expect(body.failed).toBe(1);
      expect(body.created).toBe(0);
    });

    it('records failure when catalog provider does not match requested provider', async () => {
      const wrongProviderEntry = makeCatalogItem({
        id: 'cat-firoam-wrong',
        provider: 'firoam', // catalog is firoam
      });
      vi.mocked(prismaCatalog.findUnique).mockResolvedValue(wrongProviderEntry);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/bulk',
        headers: JSON_HEADERS,
        payload: {
          mappings: [
            { shopifySku: 'ESIM-AU-3GB', provider: 'tgt', providerCatalogId: 'cat-firoam-wrong' }, // mismatch
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ created: number; failed: number }>();
      expect(body.failed).toBe(1);
      expect(body.created).toBe(0);
    });

    it('returns 401 without admin key', async () => {
      const res = await app.inject({ method: 'POST', url: '/sku-mappings/bulk', payload: {} });
      expect(res.statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // AI Map Jobs — persistent background job endpoints
  // ---------------------------------------------------------------------------

  describe('POST /sku-mappings/ai-map/jobs', () => {
    const prismaAiMapJob = (
      prisma as unknown as { aiMapJob: Record<string, ReturnType<typeof vi.fn>> }
    ).aiMapJob;

    beforeEach(() => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ provider: 'firoam' }]);
      adminMocks.mockGetAllVariants.mockResolvedValue([
        { sku: 'ESIM-EU-1GB', productTitle: 'EU 1GB', variantTitle: '1GB' },
      ]);
      adminMocks.mockOpenAiCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  shopify_sku: 'ESIM-EU-1GB',
                  catalog_id: 'cat-1',
                  confidence: 0.9,
                  reason: 'Good match',
                },
              ]),
            },
          },
        ],
      });
    });

    it('creates job record and returns 201 with jobId immediately', async () => {
      prismaAiMapJob.create.mockResolvedValue({ id: 'job-001', status: 'running' });
      prismaAiMapJob.update.mockResolvedValue({});

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map/jobs',
        headers: JSON_HEADERS,
        payload: { provider: 'firoam', unmappedOnly: true },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ jobId: string }>();
      expect(body.jobId).toBe('job-001');
      expect(prismaAiMapJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'running', provider: 'firoam' }),
        }),
      );
    });

    it('returns 500 when OPENAI_API_KEY is not set', async () => {
      const orig = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map/jobs',
        headers: JSON_HEADERS,
        payload: {},
      });
      process.env.OPENAI_API_KEY = orig;
      expect(res.statusCode).toBe(500);
    });

    it('returns 401 without admin key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map/jobs',
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /sku-mappings/ai-map/jobs', () => {
    const prismaAiMapJob = (
      prisma as unknown as { aiMapJob: Record<string, ReturnType<typeof vi.fn>> }
    ).aiMapJob;

    it('returns list of jobs without draftsJson', async () => {
      const mockJobs = [
        {
          id: 'job-1',
          status: 'done',
          provider: null,
          unmappedOnly: true,
          totalBatches: 2,
          completedBatches: 2,
          foundSoFar: 5,
          warning: null,
          error: null,
          createdAt: new Date(),
          completedAt: new Date(),
        },
      ];
      prismaAiMapJob.findMany.mockResolvedValue(mockJobs);

      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/ai-map/jobs',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ jobs: unknown[] }>();
      expect(body.jobs).toHaveLength(1);
      expect(body.jobs[0]).toMatchObject({ id: 'job-1', status: 'done' });
    });

    it('returns 401 without admin key', async () => {
      const res = await app.inject({ method: 'GET', url: '/sku-mappings/ai-map/jobs' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /sku-mappings/ai-map/jobs/:id', () => {
    const prismaAiMapJob = (
      prisma as unknown as { aiMapJob: Record<string, ReturnType<typeof vi.fn>> }
    ).aiMapJob;

    it('returns full job with draftsJson', async () => {
      const mockJob = { id: 'job-1', status: 'done', draftsJson: [{ shopifySku: 'ESIM-EU-1GB' }] };
      prismaAiMapJob.findUnique.mockResolvedValue(mockJob);

      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/ai-map/jobs/job-1',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ job: typeof mockJob }>();
      expect(body.job.id).toBe('job-1');
      expect(body.job.draftsJson).toHaveLength(1);
    });

    it('returns 404 when job not found', async () => {
      prismaAiMapJob.findUnique.mockResolvedValue(null);
      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/ai-map/jobs/missing',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 401 without admin key', async () => {
      const res = await app.inject({ method: 'GET', url: '/sku-mappings/ai-map/jobs/job-1' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('DELETE /sku-mappings/ai-map/jobs/:id', () => {
    const prismaAiMapJob = (
      prisma as unknown as { aiMapJob: Record<string, ReturnType<typeof vi.fn>> }
    ).aiMapJob;

    it('deletes job and returns ok', async () => {
      prismaAiMapJob.findUnique.mockResolvedValue({ status: 'done' });
      prismaAiMapJob.delete.mockResolvedValue({ id: 'job-1' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/sku-mappings/ai-map/jobs/job-1',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ ok: boolean }>().ok).toBe(true);
    });

    it('returns 409 when trying to delete a running job', async () => {
      prismaAiMapJob.findUnique.mockResolvedValue({ status: 'running' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/sku-mappings/ai-map/jobs/job-running',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(409);
    });

    it('returns 404 when job does not exist', async () => {
      prismaAiMapJob.findUnique.mockResolvedValue(null);
      const res = await app.inject({
        method: 'DELETE',
        url: '/sku-mappings/ai-map/jobs/missing',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when prisma.delete throws P2025 (race condition)', async () => {
      prismaAiMapJob.findUnique.mockResolvedValue({ status: 'done' });
      const p2025 = Object.assign(new Error('Record not found'), {
        code: 'P2025',
        name: 'PrismaClientKnownRequestError',
        clientVersion: '0',
        meta: {},
      });
      Object.setPrototypeOf(
        p2025,
        (await import('@prisma/client')).Prisma.PrismaClientKnownRequestError.prototype,
      );
      prismaAiMapJob.delete.mockRejectedValue(p2025);

      const res = await app.inject({
        method: 'DELETE',
        url: '/sku-mappings/ai-map/jobs/job-1',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 500 when prisma.delete throws unexpected error', async () => {
      prismaAiMapJob.findUnique.mockResolvedValue({ status: 'done' });
      prismaAiMapJob.delete.mockRejectedValue(new Error('DB connection lost'));

      const res = await app.inject({
        method: 'DELETE',
        url: '/sku-mappings/ai-map/jobs/job-1',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(500);
    });

    it('returns 401 without admin key', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/sku-mappings/ai-map/jobs/job-1' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /sku-mappings/ai-map/jobs/:id/stream', () => {
    const prismaAiMapJob = (
      prisma as unknown as { aiMapJob: Record<string, ReturnType<typeof vi.fn>> }
    ).aiMapJob;

    it('polls through running state then emits done', async () => {
      prismaAiMapJob.findUnique
        .mockResolvedValueOnce({
          status: 'running',
          totalBatches: 2,
          completedBatches: 1,
          foundSoFar: 2,
          error: null,
        })
        .mockResolvedValueOnce({
          status: 'done',
          totalBatches: 2,
          completedBatches: 2,
          foundSoFar: 4,
          error: null,
        });

      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/ai-map/jobs/job-running/stream',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('event: progress');
      expect(res.body).toContain('event: done');
    }, 10000);

    it('emits progress then done events for a completed job', async () => {
      prismaAiMapJob.findUnique.mockResolvedValue({
        status: 'done',
        totalBatches: 2,
        completedBatches: 2,
        foundSoFar: 3,
        error: null,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/ai-map/jobs/job-done/stream',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.body).toContain('event: progress');
      expect(res.body).toContain('event: done');
    });

    it('emits error event when job status is error', async () => {
      prismaAiMapJob.findUnique.mockResolvedValue({
        status: 'error',
        totalBatches: 1,
        completedBatches: 0,
        foundSoFar: 0,
        error: 'OpenAI quota exceeded',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/ai-map/jobs/job-err/stream',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('event: error');
      expect(res.body).toContain('OpenAI quota exceeded');
    });

    it('emits error event when job is not found', async () => {
      prismaAiMapJob.findUnique.mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/ai-map/jobs/missing/stream',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('event: error');
      expect(res.body).toContain('Job not found');
    });

    it('emits error event when DB read throws', async () => {
      prismaAiMapJob.findUnique.mockRejectedValue(new Error('DB connection lost'));

      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/ai-map/jobs/job-db-err/stream',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('event: error');
      expect(res.body).toContain('Failed to read job state');
    });

    it('returns 401 without admin key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sku-mappings/ai-map/jobs/job-1/stream',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /shopify-skus/bulk-delete
  // ---------------------------------------------------------------------------
  describe('POST /shopify-skus/bulk-delete', () => {
    beforeEach(() => {
      vi.mocked(prisma.shopifyVariant.deleteMany).mockResolvedValue({ count: 0 });
    });

    it('returns 400 when skus array is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/shopify-skus/bulk-delete',
        headers: JSON_HEADERS,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when skus array is empty', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/shopify-skus/bulk-delete',
        headers: JSON_HEADERS,
        payload: { skus: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('calls deleteProduct when all variants of a product are being deleted', async () => {
      adminMocks.mockGetVariantGidsBySkus.mockResolvedValue(
        new Map([
          [
            'ESIM-EU-1GB',
            {
              variantGid: 'gid://shopify/ProductVariant/1',
              productGid: 'gid://shopify/Product/10',
              productVariantCount: 1,
            },
          ],
        ]),
      );
      adminMocks.mockDeleteProduct.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/shopify-skus/bulk-delete',
        headers: JSON_HEADERS,
        payload: { skus: ['ESIM-EU-1GB'] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        deleted: number;
        skipped: number;
        deletedVariantIds: string[];
        errors: string[];
      }>();
      expect(body.deleted).toBe(1);
      expect(body.skipped).toBe(0);
      expect(body.errors).toHaveLength(0);
      expect(body.deletedVariantIds).toEqual(['gid://shopify/ProductVariant/1']);
      expect(adminMocks.mockDeleteProduct).toHaveBeenCalledWith('gid://shopify/Product/10');
      expect(adminMocks.mockDeleteVariants).not.toHaveBeenCalled();
    });

    it('calls deleteVariants when only some variants of a product are being deleted', async () => {
      adminMocks.mockGetVariantGidsBySkus.mockResolvedValue(
        new Map([
          [
            'ESIM-EU-1GB',
            {
              variantGid: 'gid://shopify/ProductVariant/1',
              productGid: 'gid://shopify/Product/10',
              productVariantCount: 3,
            },
          ],
        ]),
      );
      adminMocks.mockDeleteVariants.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/shopify-skus/bulk-delete',
        headers: JSON_HEADERS,
        payload: { skus: ['ESIM-EU-1GB'] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        deleted: number;
        skipped: number;
        deletedVariantIds: string[];
        errors: string[];
      }>();
      expect(body.deleted).toBe(1);
      expect(body.deletedVariantIds).toEqual(['gid://shopify/ProductVariant/1']);
      expect(adminMocks.mockDeleteVariants).toHaveBeenCalledWith('gid://shopify/Product/10', [
        'gid://shopify/ProductVariant/1',
      ]);
      expect(adminMocks.mockDeleteProduct).not.toHaveBeenCalled();
    });

    it('counts skipped SKUs not found in Shopify', async () => {
      adminMocks.mockGetVariantGidsBySkus.mockResolvedValue(new Map()); // nothing found

      const res = await app.inject({
        method: 'POST',
        url: '/shopify-skus/bulk-delete',
        headers: JSON_HEADERS,
        payload: { skus: ['ESIM-XX-MISSING', 'ESIM-YY-MISSING'] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ deleted: number; skipped: number; errors: string[] }>();
      expect(body.deleted).toBe(0);
      expect(body.skipped).toBe(2);
      expect(body.errors).toHaveLength(0);
    });

    it('accumulates errors from failed Shopify mutations (non-fatal)', async () => {
      adminMocks.mockGetVariantGidsBySkus.mockResolvedValue(
        new Map([
          [
            'ESIM-EU-1GB',
            {
              variantGid: 'gid://shopify/ProductVariant/1',
              productGid: 'gid://shopify/Product/10',
              productVariantCount: 1,
            },
          ],
        ]),
      );
      adminMocks.mockDeleteProduct.mockRejectedValue(
        new Error('Shopify productDelete errors: not found'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/shopify-skus/bulk-delete',
        headers: JSON_HEADERS,
        payload: { skus: ['ESIM-EU-1GB'] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ deleted: number; skipped: number; errors: string[] }>();
      expect(body.deleted).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toContain('not found');
    });

    it('returns 502 when getVariantGidsBySkus throws', async () => {
      adminMocks.mockGetVariantGidsBySkus.mockRejectedValue(
        new Error('Shopify GraphQL errors: network'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/shopify-skus/bulk-delete',
        headers: JSON_HEADERS,
        payload: { skus: ['ESIM-EU-1GB'] },
      });

      expect(res.statusCode).toBe(502);
    });

    it('returns deletedVariantIds empty when deletion fails', async () => {
      adminMocks.mockGetVariantGidsBySkus.mockResolvedValue(
        new Map([
          [
            'ESIM-EU-1GB',
            {
              variantGid: 'gid://shopify/ProductVariant/1',
              productGid: 'gid://shopify/Product/10',
              productVariantCount: 1,
            },
          ],
        ]),
      );
      adminMocks.mockDeleteProduct.mockRejectedValue(new Error('Shopify error'));

      const res = await app.inject({
        method: 'POST',
        url: '/shopify-skus/bulk-delete',
        headers: JSON_HEADERS,
        payload: { skus: ['ESIM-EU-1GB'] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ deletedVariantIds: string[]; errors: string[] }>();
      expect(body.deletedVariantIds).toHaveLength(0);
      expect(body.errors).toHaveLength(1);
    });

    it('returns 401 without admin key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/shopify-skus/bulk-delete',
        payload: { skus: ['ESIM-EU-1GB'] },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // runAiMapJobAsync — unmatched SKU tracking
  // ---------------------------------------------------------------------------
  describe('POST /sku-mappings/ai-map/jobs — unmatched SKU tracking', () => {
    const prismaAiMapJob = (
      prisma as unknown as { aiMapJob: Record<string, ReturnType<typeof vi.fn>> }
    ).aiMapJob;

    it('stores unmatched SKUs in job record when some SKUs have no draft', async () => {
      prismaAiMapJob.create.mockResolvedValue({ id: 'job-unmatched', status: 'running' });
      prismaAiMapJob.update.mockResolvedValue({});

      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ provider: 'firoam' }]);
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      vi.mocked(prismaCatalog.findMany).mockResolvedValue([
        makeCatalogItem({ id: 'cat-1', productName: 'EU 1GB' }),
      ]);
      adminMocks.mockGetAllVariants.mockResolvedValue([
        {
          sku: 'ESIM-EU-1GB',
          variantId: 'gid://shopify/ProductVariant/1',
          productTitle: 'EU 1GB',
          variantTitle: '1GB',
        },
        {
          sku: 'ESIM-EU-5GB',
          variantId: 'gid://shopify/ProductVariant/2',
          productTitle: 'EU 5GB',
          variantTitle: '5GB',
        },
      ]);
      // Only ESIM-EU-1GB gets a draft — ESIM-EU-5GB is unmatched
      adminMocks.mockOpenAiCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mappings: [
                  {
                    shopifySku: 'ESIM-EU-1GB',
                    catalogId: 'cat-1',
                    confidence: 0.9,
                    reason: 'match',
                  },
                ],
              }),
            },
          },
        ],
      });

      await app.inject({
        method: 'POST',
        url: '/sku-mappings/ai-map/jobs',
        headers: JSON_HEADERS,
        payload: { provider: 'firoam', unmappedOnly: false },
      });

      // Wait for background runner to complete
      const doneCall = await vi.waitFor(
        () => {
          const call = prismaAiMapJob.update.mock.calls.find(
            (c) => (c[0] as { data: { status?: string } }).data?.status === 'done',
          );
          expect(call).toBeDefined();
          return call;
        },
        { timeout: 2000 },
      );

      const unmatchedArg = (doneCall![0] as { data: { unmatchedSkusJson?: unknown[] } }).data
        ?.unmatchedSkusJson;
      expect(Array.isArray(unmatchedArg)).toBe(true);
      expect((unmatchedArg as Array<{ sku: string }>).some((v) => v.sku === 'ESIM-EU-5GB')).toBe(
        true,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // POST /provider-catalog/parse-all
  // ---------------------------------------------------------------------------

  describe('POST /provider-catalog/parse-all', () => {
    it('returns ok with parsed count when entries are processed', async () => {
      // Advisory lock acquired
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ acquired: true }]);
      // First batch: 1 row; second batch: empty (done)
      vi.mocked(prisma.$queryRaw)
        .mockResolvedValueOnce([
          {
            id: 'cat-1',
            productName: 'EU 1GB 7D',
            region: 'EU',
            countryCodes: null,
            dataAmount: '1GB',
            validity: '7 days',
          },
        ])
        .mockResolvedValueOnce([]);
      // parseCatalogEntry returns a result
      adminMocks.mockParseCatalogEntry.mockResolvedValueOnce({
        regionCodes: ['EU'],
        dataMb: 1024,
        validityDays: 7,
      });
      vi.mocked(prisma.$executeRaw).mockResolvedValue(1 as never);

      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/parse-all',
        headers: JSON_HEADERS,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { ok: boolean; started: boolean };
      expect(body.ok).toBe(true);
      expect(body.started).toBe(true);
    });

    it('returns 500 when OPENAI_API_KEY is not set', async () => {
      const saved = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/parse-all',
        headers: JSON_HEADERS,
        payload: {},
      });
      process.env.OPENAI_API_KEY = saved;
      expect(res.statusCode).toBe(500);
    });

    it('returns ok with started=false when advisory lock not acquired', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ acquired: false }]);
      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/parse-all',
        headers: JSON_HEADERS,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { ok: boolean; started: boolean };
      expect(body.ok).toBe(true);
      expect(body.started).toBe(false);
    });

    it('uses provider filter when specified', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ acquired: true }]);
      // Provider-filtered query returns empty (done immediately)
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([]);
      vi.mocked(prisma.$executeRaw).mockResolvedValue(undefined as never);

      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/parse-all',
        headers: JSON_HEADERS,
        payload: { provider: 'firoam' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { ok: boolean; started: boolean };
      expect(body.ok).toBe(true);
      expect(body.started).toBe(true);
    });

    it('returns 401 without admin key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/parse-all',
        headers: { 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /sku-mappings/structured-match
  // ---------------------------------------------------------------------------

  describe('POST /sku-mappings/structured-match', () => {
    it('returns parsed attributes and drafts for a parseable SKU', async () => {
      // JSONB query returns one matching catalog row
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        {
          id: 'cat-1',
          provider: 'firoam',
          productName: 'EU 1GB 7D Plan',
          region: 'EU',
          dataAmount: '1GB',
          validity: '7 days',
          netPrice: '1.50',
          productCode: 'EU-1GB-7D',
          parsedJson: { regionCodes: ['EU'], dataMb: 1024, validityDays: 7 },
        },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-match',
        headers: JSON_HEADERS,
        payload: { sku: 'ESIM-EU-1GB-7D' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        drafts: Array<{ shopifySku: string; confidence: number }>;
        parsed: { regionCode: string; dataMb: number; validityDays: number } | null;
      };
      expect(body.parsed).toEqual({
        regionCode: 'EU',
        dataMb: 1024,
        validityDays: 7,
        skuType: 'FIXED',
      });
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0].shopifySku).toBe('ESIM-EU-1GB-7D');
      expect(body.drafts[0].confidence).toBe(1.0);
    });

    it('returns empty drafts for an unparseable SKU', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-match',
        headers: JSON_HEADERS,
        payload: { sku: 'NOT-A-VALID-SKU' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { drafts: unknown[]; parsed: null };
      expect(body.parsed).toBeNull();
      expect(body.drafts).toHaveLength(0);
    });

    it('returns 400 when sku is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-match',
        headers: JSON_HEADERS,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without admin key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-match',
        headers: { 'content-type': 'application/json' },
        payload: { sku: 'ESIM-EU-1GB-7D' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('applies relaxData option — partial match returns 0.8 confidence', async () => {
      // Catalog has 2GB but we relax data matching
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        {
          id: 'cat-2',
          provider: 'firoam',
          productName: 'EU 2GB 7D Plan',
          region: 'EU',
          dataAmount: '2GB',
          validity: '7 days',
          netPrice: '2.00',
          productCode: 'EU-2GB-7D',
          parsedJson: { regionCodes: ['EU'], dataMb: 2048, validityDays: 7 },
        },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-match',
        headers: JSON_HEADERS,
        payload: { sku: 'ESIM-EU-1GB-7D', relaxOptions: { relaxData: true } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        drafts: Array<{ confidence: number }>;
      };
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0].confidence).toBe(0.8); // region + validity match, data relaxed
    });

    it('uses provider-filtered JSONB query when provider is specified', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        {
          id: 'cat-p1',
          provider: 'firoam',
          productName: 'EU 1GB 7D Plan',
          region: 'EU',
          dataAmount: '1GB',
          validity: '7 days',
          netPrice: '1.50',
          productCode: 'EU-1GB-7D',
          parsedJson: { regionCodes: ['EU'], dataMb: 1024, validityDays: 7 },
        },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-match',
        headers: JSON_HEADERS,
        payload: { sku: 'ESIM-EU-1GB-7D', provider: 'firoam' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { drafts: Array<{ confidence: number }> };
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0].confidence).toBe(1.0);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /sku-mappings/structured-map/jobs
  // ---------------------------------------------------------------------------

  describe('POST /sku-mappings/structured-map/jobs', () => {
    const prismaAiMapJobStructured = (
      prisma as unknown as {
        aiMapJob: {
          create: ReturnType<typeof vi.fn>;
          update: ReturnType<typeof vi.fn>;
        };
      }
    ).aiMapJob;

    it('creates a job and returns 201 with jobId', async () => {
      prismaAiMapJobStructured.create.mockResolvedValue({ id: 'struct-job-1' });
      adminMocks.mockGetAllVariants.mockResolvedValue([]);
      prismaAiMapJobStructured.update.mockResolvedValue({});

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-map/jobs',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { jobId: string };
      expect(body.jobId).toBe('struct-job-1');
    });

    it('returns 401 without admin key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-map/jobs',
        headers: { 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });

    it('marks job as error when Shopify fetch fails', async () => {
      prismaAiMapJobStructured.create.mockResolvedValue({ id: 'struct-job-err' });
      adminMocks.mockGetAllVariants.mockRejectedValue(new Error('shopify down'));
      prismaAiMapJobStructured.update.mockResolvedValue({});

      await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-map/jobs',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      await vi.waitFor(
        () => {
          const call = prismaAiMapJobStructured.update.mock.calls.find(
            (c) => (c[0] as { data: { status?: string } }).data?.status === 'error',
          );
          expect(call).toBeDefined();
        },
        { timeout: 2000 },
      );
    });

    it('handles updateErr catch branch when error state update fails', async () => {
      prismaAiMapJobStructured.create.mockResolvedValue({ id: 'struct-job-update-err' });
      adminMocks.mockGetAllVariants.mockRejectedValue(new Error('shopify down'));
      // Make the update itself throw — triggers the catch (updateErr) branch
      prismaAiMapJobStructured.update.mockRejectedValue(new Error('db connection lost'));

      await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-map/jobs',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: false },
      });

      // Give background runner time to hit both catch branches
      // Use vi.waitFor so CI timing doesn't cause flakiness
      await vi.waitFor(
        () => {
          expect(prismaAiMapJobStructured.update).toHaveBeenCalled();
        },
        { timeout: 2000 },
      );
    });

    it('runs unmapped filter and processes SKUs through the matching loop', async () => {
      prismaAiMapJobStructured.create.mockResolvedValue({ id: 'struct-job-loop' });
      adminMocks.mockGetAllVariants.mockResolvedValue([
        {
          sku: 'ESIM-EU-1GB-7D',
          title: 'EU 1GB',
          productTitle: 'EU Plan',
          variantId: '1',
          price: '5.00',
        },
        {
          sku: 'ESIM-JP-2GB-30D',
          title: 'JP 2GB',
          productTitle: 'JP Plan',
          variantId: '2',
          price: '8.00',
        },
      ]);
      // unmappedOnly defaults to true — filter path runs
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([]);
      // JSONB query returns no matches for both SKUs
      vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
      prismaAiMapJobStructured.update.mockResolvedValue({});

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-map/jobs',
        headers: JSON_HEADERS,
        payload: { unmappedOnly: true },
      });

      expect(res.statusCode).toBe(201);

      await vi.waitFor(
        () => {
          // At least one progress update call with completedBatches
          const progressCall = prismaAiMapJobStructured.update.mock.calls.find(
            (c) =>
              (c[0] as { data: { completedBatches?: number } }).data?.completedBatches !==
              undefined,
          );
          expect(progressCall).toBeDefined();
        },
        { timeout: 2000 },
      );
    });

    it('filters to SKUs with inactive catalog entries when inactiveOnly=true', async () => {
      prismaAiMapJobStructured.create.mockResolvedValue({ id: 'struct-job-inactive-1' });
      adminMocks.mockGetAllVariants.mockResolvedValue([
        {
          sku: 'ESIM-EU-1GB-30D',
          title: 'EU 1GB',
          productTitle: 'EU Plan',
          variantId: '1',
          price: '5.00',
        },
        {
          sku: 'ESIM-JP-2GB-30D',
          title: 'JP 2GB',
          productTitle: 'JP Plan',
          variantId: '2',
          price: '8.00',
        },
      ]);
      // inactiveOnly: EU has stale firoam + duplicate entry (dedup branch), JP is unknown SKU (variant-not-found branch)
      vi.mocked(prisma.providerSkuMapping.findMany).mockResolvedValue([
        { shopifySku: 'ESIM-EU-1GB-30D', provider: 'firoam' } as never,
        { shopifySku: 'ESIM-EU-1GB-30D', provider: 'firoam' } as never, // duplicate → seen.has() true
        { shopifySku: 'ESIM-EU-1GB-30D', provider: 'tgt' } as never, // same sku, different provider
        { shopifySku: 'ESIM-MISSING', provider: 'firoam' } as never, // not in shopify list → skipped
      ]);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
      prismaAiMapJobStructured.update.mockResolvedValue({});

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-map/jobs',
        headers: JSON_HEADERS,
        payload: { inactiveOnly: true },
      });

      expect(res.statusCode).toBe(201);

      await vi.waitFor(
        () => {
          const finalCall = prismaAiMapJobStructured.update.mock.calls.find(
            (c) => (c[0] as { data: { status?: string } }).data?.status === 'done',
          );
          expect(finalCall).toBeDefined();
        },
        { timeout: 2000 },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // POST /sku-mappings/structured-match — additional branch coverage
  // ---------------------------------------------------------------------------

  describe('POST /sku-mappings/structured-match — region-only match', () => {
    it('returns 0.6 confidence when both data and validity are relaxed', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        {
          id: 'cat-3',
          provider: 'firoam',
          productName: 'EU 2GB 30D Plan',
          region: 'EU',
          dataAmount: '2GB',
          validity: '30 days',
          netPrice: '3.00',
          productCode: 'EU-2GB-30D',
          parsedJson: { regionCodes: ['EU'], dataMb: 2048, validityDays: 30 },
        },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-match',
        headers: JSON_HEADERS,
        payload: {
          sku: 'ESIM-EU-1GB-7D',
          relaxOptions: { relaxData: true, relaxValidity: true },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { drafts: Array<{ confidence: number }> };
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0].confidence).toBe(0.6); // region only — data and validity both differ
    });
  });

  // ---------------------------------------------------------------------------
  // POST /sku-mappings/structured-match — DAYPASS confidence
  // ---------------------------------------------------------------------------

  describe('POST /sku-mappings/structured-match — DAYPASS SKU', () => {
    it('returns 1.0 confidence for DAYPASS when region+data match (validity ignored)', async () => {
      // Catalog entry is a daily plan (validityDays=1); SKU validity (7D) is ignored for DAYPASS
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        {
          id: 'cat-daypass-1',
          provider: 'firoam',
          productName: 'SA 2GB Daily',
          region: 'SA',
          dataAmount: '2GB',
          validity: '1 day',
          netPrice: '1.50',
          productCode: 'SA-2GB-DAILY?1',
          parsedJson: { regionCodes: ['SA'], dataMb: 2048, validityDays: 1 },
        },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-match',
        headers: JSON_HEADERS,
        payload: { sku: 'SA-2GB-7D-DAYPASS' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        drafts: Array<{ confidence: number; reason: string }>;
      };
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0].confidence).toBe(1.0);
      expect(body.drafts[0].reason).toContain('region');
      expect(body.drafts[0].reason).toContain('data');
    });

    it('returns 0.6 confidence for DAYPASS when data does not match', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        {
          id: 'cat-daypass-2',
          provider: 'firoam',
          productName: 'SA 5GB Daily',
          region: 'SA',
          dataAmount: '5GB',
          validity: '1 day',
          netPrice: '2.50',
          productCode: 'SA-5GB-DAILY?1',
          parsedJson: { regionCodes: ['SA'], dataMb: 5120, validityDays: 1 },
        },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-match',
        headers: JSON_HEADERS,
        payload: { sku: 'SA-2GB-7D-DAYPASS', relaxOptions: { relaxData: true } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { drafts: Array<{ confidence: number }> };
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0].confidence).toBe(0.6); // region only
    });

    it('returns empty drafts for DAYPASS when data mismatch and relaxData=false', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        {
          id: 'cat-daypass-3',
          provider: 'firoam',
          productName: 'SA 5GB Daily',
          region: 'SA',
          dataAmount: '5GB',
          validity: '1 day',
          netPrice: '2.50',
          productCode: 'SA-5GB-DAILY?3',
          parsedJson: { regionCodes: ['SA'], dataMb: 5120, validityDays: 1 },
        },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-match',
        headers: JSON_HEADERS,
        payload: { sku: 'SA-2GB-7D-DAYPASS' }, // relaxData defaults to false
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { drafts: unknown[] };
      expect(body.drafts).toHaveLength(0);
    });

    it('FIXED SKU with validity mismatch still returns 0.8 (unchanged behaviour)', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        {
          id: 'cat-fixed-1',
          provider: 'firoam',
          productName: 'EU 1GB 30D Plan',
          region: 'EU',
          dataAmount: '1GB',
          validity: '30 days',
          netPrice: '4.00',
          productCode: 'EU-1GB-30D',
          parsedJson: { regionCodes: ['EU'], dataMb: 1024, validityDays: 30 },
        },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-match',
        headers: JSON_HEADERS,
        payload: { sku: 'EU-1GB-7D-FIXED', relaxOptions: { relaxValidity: true } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { drafts: Array<{ confidence: number }> };
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0].confidence).toBe(0.8); // region+data, validity differs
    });
  });

  // ---------------------------------------------------------------------------
  // POST /sku-mappings/structured-match — best-match-per-provider dedup
  // ---------------------------------------------------------------------------

  describe('POST /sku-mappings/structured-match — best-match-per-provider dedup', () => {
    it('returns only the most specific match when same provider has multiple regionCode hits', async () => {
      // SA-only package (specific) + Middle East package (regional, also contains SA)
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        {
          id: 'cat-sa-specific',
          provider: 'firoam',
          productName: 'Saudi Arabia 2GB 7D',
          region: 'SA',
          dataAmount: '2GB',
          validity: '7 days',
          netPrice: '3.00',
          productCode: 'SA-2GB-7D',
          parsedJson: { regionCodes: ['SA'], dataMb: 2048, validityDays: 7 },
        },
        {
          id: 'cat-me-regional',
          provider: 'firoam',
          productName: 'Middle East 2GB 7D',
          region: 'Middle East',
          dataAmount: '2GB',
          validity: '7 days',
          netPrice: '4.00',
          productCode: 'ME-2GB-7D',
          parsedJson: { regionCodes: ['SA', 'AE', 'QA', 'KW'], dataMb: 2048, validityDays: 7 },
        },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-match',
        headers: JSON_HEADERS,
        payload: { sku: 'SA-2GB-7D-FIXED' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        drafts: Array<{ catalogId: string; provider: string; confidence: number }>;
      };
      // Only the most specific (SA-only, regionCodes.length=1) should survive
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0].catalogId).toBe('cat-sa-specific');
      expect(body.drafts[0].confidence).toBe(1.0);
    });

    it('returns one result per provider when both providers have a match', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        {
          id: 'cat-firoam',
          provider: 'firoam',
          productName: 'SA 2GB 7D FiRoam',
          region: 'SA',
          dataAmount: '2GB',
          validity: '7 days',
          netPrice: '3.00',
          productCode: 'SA-2GB-7D-FIROAM',
          parsedJson: { regionCodes: ['SA'], dataMb: 2048, validityDays: 7 },
        },
        {
          id: 'cat-tgt',
          provider: 'tgt',
          productName: 'SA 2GB 7D TGT',
          region: 'SA',
          dataAmount: '2GB',
          validity: '7 days',
          netPrice: '3.50',
          productCode: 'SA-2GB-7D-TGT',
          parsedJson: { regionCodes: ['SA'], dataMb: 2048, validityDays: 7 },
        },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-match',
        headers: JSON_HEADERS,
        payload: { sku: 'SA-2GB-7D-FIXED' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { drafts: Array<{ provider: string }> };
      expect(body.drafts).toHaveLength(2);
      const providers = body.drafts.map((d) => d.provider).sort();
      expect(providers).toEqual(['firoam', 'tgt']);
    });

    it('uses confidence as tiebreaker when two same-provider entries have equal specificity', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        {
          id: 'cat-high',
          provider: 'firoam',
          productName: 'SA 2GB 7D',
          region: 'SA',
          dataAmount: '2GB',
          validity: '7 days',
          netPrice: '3.00',
          productCode: 'SA-2GB-7D',
          // Exact match → confidence 1.0, regionCodes.length=1
          parsedJson: { regionCodes: ['SA'], dataMb: 2048, validityDays: 7 },
        },
        {
          id: 'cat-low',
          provider: 'firoam',
          productName: 'SA 2GB 30D',
          region: 'SA',
          dataAmount: '2GB',
          validity: '30 days',
          netPrice: '5.00',
          productCode: 'SA-2GB-30D',
          // Validity differs → confidence 0.8 with relaxValidity, regionCodes.length=1
          parsedJson: { regionCodes: ['SA'], dataMb: 2048, validityDays: 30 },
        },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/sku-mappings/structured-match',
        headers: JSON_HEADERS,
        payload: { sku: 'SA-2GB-7D-FIXED', relaxOptions: { relaxValidity: true } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        drafts: Array<{ catalogId: string; confidence: number }>;
      };
      // Same specificity (both regionCodes.length=1) → higher confidence wins
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0].catalogId).toBe('cat-high');
      expect(body.drafts[0].confidence).toBe(1.0);
    });
  });
});
