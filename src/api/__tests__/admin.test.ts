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
  return {
    mockJobSend: vi.fn().mockResolvedValue('job-id-admin'),
    mockSendDeliveryEmail: vi.fn(),
    mockDecrypt: vi.fn(),
    mockTgtListProducts: vi.fn(),
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
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    providerSkuCatalog: {
      findMany: vi.fn(),
      count: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock('~/vendor/tgtClient', () => ({
  default: class MockTgtClient {
    async listProducts(...args: unknown[]) {
      return adminMocks.mockTgtListProducts(...args);
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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

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
      count: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
  }
).providerSkuCatalog as {
  findMany: ReturnType<typeof vi.fn>;
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
    payloadEncrypted: null,
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
    isActive: true,
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

      expect(res.json().limit).toBe(500);
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
  });

  describe('POST /provider-catalog/sync', () => {
    it('rejects unsupported provider', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/provider-catalog/sync',
        headers: JSON_HEADERS,
        payload: { provider: 'firoam' },
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
      expect(res.json()).toMatchObject({ ok: true, provider: 'tgt', processed: 1 });
    });
  });
});
