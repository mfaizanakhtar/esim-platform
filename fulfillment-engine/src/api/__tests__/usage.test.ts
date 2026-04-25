import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import type { EsimDelivery } from '@prisma/client';
import usageRoutes from '~/api/usage';

// ── Module-level mock fn — reset per test in beforeEach ───────────────────────
type QueryEsimOrderParams = {
  orderNum?: string;
  iccid?: string;
  pageNo?: number;
  pageSize?: number;
};
const mockQueryEsimOrder = vi.fn<(params: QueryEsimOrderParams) => unknown>();
const mockGetUsage = vi.fn<(orderNo: string) => unknown>();

// ── Mocks hoisted before imports ─────────────────────────────────────────────
vi.mock('~/db/prisma', () => ({
  default: {
    esimDelivery: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('~/vendor/firoamClient', () => ({
  default: class MockFiRoamClient {
    queryEsimOrder(params: QueryEsimOrderParams) {
      return mockQueryEsimOrder(params);
    }
  },
}));

vi.mock('~/vendor/tgtClient', () => ({
  default: class MockTgtClient {
    getUsage(orderNo: string) {
      return mockGetUsage(orderNo);
    }
  },
}));

vi.mock('~/utils/crypto', () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  hashIccid: vi.fn((iccid: string) => `hash:${iccid}`),
}));

import prisma from '~/db/prisma';
import { decrypt } from '~/utils/crypto';

// ── Test helpers ─────────────────────────────────────────────────────────────
/** Build a full EsimDelivery row with sensible defaults for fields not under test */
function makeDelivery(overrides: Partial<EsimDelivery>): EsimDelivery {
  return {
    id: 'del-default',
    shop: 'test.myshopify.com',
    orderId: '123456',
    orderName: '#1001',
    lineItemId: '111',
    variantId: 'var-1',
    customerEmail: null,
    vendorReferenceId: null,
    provider: null,
    iccidHash: null,
    topupIccid: null,
    sku: null,
    payloadEncrypted: null,
    accessToken: null,
    status: 'delivered',
    lastError: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

// ── Test constants ────────────────────────────────────────────────────────────
const ICCID = '8901000000000000001';

/** Encode a delivery payload the same way usage.ts expects after decrypt + JSON.parse */
function makePayload(iccid: string, extra: Record<string, unknown> = {}): string {
  return `enc:${JSON.stringify({ iccid, lpa: 'LPA:1$test$code', activationCode: 'code', ...extra })}`;
}

/** Build a successful queryEsimOrder response with the given ICCID in packages */
function makeUsageResponse(
  iccid: string,
  overrides: { flows?: number; unit?: string; usedMb?: number } = {},
) {
  return {
    success: true as const,
    orders: [
      {
        orderNum: 'EP-001',
        skuId: 156,
        skuName: 'Turkey',
        createTime: '2026-01-01 10:00:00.0',
        status: 0,
        packages: [
          {
            iccid,
            flows: overrides.flows ?? 5,
            unit: overrides.unit ?? 'GB',
            usedMb: overrides.usedMb ?? 1024,
            days: 30,
            name: 'Turkey 5GB 30Days',
            beginDate: '2026-01-01',
            endDate: '2026-01-31',
            status: 1,
            priceId: 100,
          },
        ],
      },
    ],
    total: 1,
    page: 1,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────
describe('GET /api/esim/:iccid/usage', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockQueryEsimOrder.mockReset();
    mockGetUsage.mockReset();
    vi.clearAllMocks();

    // Default decrypt: strip our "enc:" prefix so JSON.parse works
    vi.mocked(decrypt).mockImplementation((val: string) => val.replace('enc:', ''));

    // Default TGT mock: return no usage (so fallback tests don't error unexpectedly)
    mockGetUsage.mockResolvedValue({ usage: null });

    // Hash lookup returns null by default → tests fall through to legacy findMany scan
    vi.mocked(prisma.esimDelivery.findFirst).mockResolvedValue(null);

    app = Fastify({ logger: false });
    app.register(usageRoutes);
    await app.ready();
  });

  afterEach(async () => {
    vi.resetAllMocks();
    await app.close();
  });

  // ── 404 cases ───────────────────────────────────────────────────────────────

  it('returns 404 when no deliveries exist', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([]);

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'ICCID not found' });
  });

  it('returns 404 when no delivery ICCID matches the requested ICCID', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-1',
        vendorReferenceId: 'EP-001',
        payloadEncrypted: makePayload('9999999'),
        orderName: '#1001',
        customerEmail: 'a@b.com',
      }),
    ]);

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'ICCID not found' });
  });

  it('falls back to TGT when ICCID not found in FiRoam order packages', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-1',
        vendorReferenceId: 'TGT-001',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#1001',
        customerEmail: 'a@b.com',
      }),
    ]);
    // FiRoam returns a different ICCID → triggers TGT fallback
    mockQueryEsimOrder.mockResolvedValue(makeUsageResponse('0000000000000000000'));
    mockGetUsage.mockResolvedValue({
      usage: { dataTotal: '5 GB', dataUsage: '1 GB', dataResidual: '4 GB', refuelingTotal: null },
    });

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(200);
    expect(mockQueryEsimOrder).toHaveBeenCalled();
    expect(res.json()).toMatchObject({ provider: 'tgt', iccid: ICCID });
    expect(mockGetUsage).toHaveBeenCalledWith('TGT-001');
  });

  it('falls back to TGT when FiRoam returns success: false', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-1',
        vendorReferenceId: 'TGT-001',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#1001',
        customerEmail: 'a@b.com',
      }),
    ]);
    mockQueryEsimOrder.mockResolvedValue({ success: false, error: 'Order not found' });
    mockGetUsage.mockResolvedValue({
      usage: { dataTotal: '3 GB', dataUsage: '0 GB', dataResidual: '3 GB', refuelingTotal: null },
    });

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(200);
    expect(mockQueryEsimOrder).toHaveBeenCalled();
    expect(res.json()).toMatchObject({ provider: 'tgt' });
  });

  it('falls back to TGT when FiRoam returns empty orders array', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-1',
        vendorReferenceId: 'TGT-001',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#1001',
        customerEmail: 'a@b.com',
      }),
    ]);
    mockQueryEsimOrder.mockResolvedValue({ success: true, orders: [] });
    mockGetUsage.mockResolvedValue({
      usage: { dataTotal: '3 GB', dataUsage: '0 GB', dataResidual: '3 GB', refuelingTotal: null },
    });

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(200);
    expect(mockQueryEsimOrder).toHaveBeenCalled();
    expect(res.json()).toMatchObject({ provider: 'tgt' });
  });

  it('returns 404 when FiRoam finds nothing and no vendorReferenceId for TGT', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-1',
        vendorReferenceId: null,
        payloadEncrypted: makePayload(ICCID),
        orderName: '#1001',
        customerEmail: 'a@b.com',
      }),
    ]);
    mockQueryEsimOrder.mockResolvedValue({ success: false, error: 'Order not found' });

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(404);
  });

  // ── TGT explicit provider ────────────────────────────────────────────────────

  it('skips FiRoam entirely when payload.provider is tgt', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-1',
        vendorReferenceId: 'TGT-123',
        payloadEncrypted: makePayload(ICCID, { provider: 'tgt' }),
        orderName: '#1001',
        customerEmail: 'a@b.com',
      }),
    ]);
    mockGetUsage.mockResolvedValue({
      usage: { dataTotal: '5120', dataUsage: '2048', dataResidual: '3072', refuelingTotal: null },
    });

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(200);
    expect(mockQueryEsimOrder).not.toHaveBeenCalled();
    expect(mockGetUsage).toHaveBeenCalledWith('TGT-123');
    const body = res.json();
    expect(body.provider).toBe('tgt');
    expect(body.iccid).toBe(ICCID);
    expect(body.orderNum).toBe('#1001');
    expect(body.vendorOrderNo).toBeUndefined();
    expect(body.status).toBe(0);
    expect(body.usage.totalMb).toBe(5120);
    expect(body.usage.usedMb).toBe(2048);
    expect(body.usage.remainingMb).toBe(3072);
    expect(body.usage.usagePercent).toBe(40);
  });

  it('returns 404 when TGT returns no usage data', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-1',
        vendorReferenceId: 'TGT-123',
        payloadEncrypted: makePayload(ICCID, { provider: 'tgt' }),
        orderName: '#1001',
        customerEmail: 'a@b.com',
      }),
    ]);
    mockGetUsage.mockResolvedValue({ usage: null });

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'Usage not found' });
  });

  // ── 200 success cases ───────────────────────────────────────────────────────

  it('returns 200 with correctly formatted usage data (GB unit)', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-1',
        vendorReferenceId: 'EP-001',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#1001',
        customerEmail: 'a@b.com',
      }),
    ]);
    mockQueryEsimOrder.mockResolvedValue(
      makeUsageResponse(ICCID, { flows: 5, unit: 'GB', usedMb: 1024 }),
    );

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.iccid).toBe(ICCID);
    expect(body.provider).toBe('firoam');
    expect(body.region).toBe('Turkey');
    expect(body.orderNum).toBe('#1001');
    expect(body.usage.total).toBe(5);
    expect(body.usage.unit).toBe('GB');
    expect(body.usage.totalMb).toBe(5120); // 5 * 1024
    expect(body.usage.usedMb).toBe(1024);
    expect(body.usage.remainingMb).toBe(4096);
    expect(body.usage.usagePercent).toBe(20); // 1024/5120 * 100
    expect(body.validity.days).toBe(30);
    expect(body.validity.beginDate).toBe('2026-01-01');
    expect(body.validity.endDate).toBe('2026-01-31');
  });

  it('returns 200 with correct totalMb when unit is MB (no *1024 conversion)', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-1',
        vendorReferenceId: 'EP-001',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#1001',
        customerEmail: 'a@b.com',
      }),
    ]);
    mockQueryEsimOrder.mockResolvedValue(
      makeUsageResponse(ICCID, { flows: 500, unit: 'MB', usedMb: 100 }),
    );

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.usage.totalMb).toBe(500); // MB unit: flows === totalMb directly
    expect(body.usage.usedMb).toBe(100);
    expect(body.usage.remainingMb).toBe(400);
  });

  // ── Resilience cases ────────────────────────────────────────────────────────

  it('skips deliveries where decrypt throws and continues to next', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-bad',
        payloadEncrypted: 'corrupt',
        orderName: '#1000',
        vendorReferenceId: null,
        customerEmail: null,
      }),
      makeDelivery({
        id: 'del-good',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#1001',
        vendorReferenceId: 'EP-001',
        customerEmail: 'a@b.com',
      }),
    ]);
    vi.mocked(decrypt)
      .mockImplementationOnce(() => {
        throw new Error('decryption failed');
      })
      .mockImplementationOnce((val: string) => val.replace('enc:', ''));
    mockQueryEsimOrder.mockResolvedValue(makeUsageResponse(ICCID));

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(200);
    expect(res.json().iccid).toBe(ICCID);
  });

  it('uses delivery.provider directly for tgt without FiRoam fallback', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-tgt',
        provider: 'tgt',
        vendorReferenceId: 'TGT-DIRECT',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#2001',
      }),
    ]);
    mockGetUsage.mockResolvedValue({
      usage: { dataTotal: '10 GB', dataUsage: '3 GB', dataResidual: '7 GB', refuelingTotal: null },
    });

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(200);
    expect(mockQueryEsimOrder).not.toHaveBeenCalled();
    expect(mockGetUsage).toHaveBeenCalledWith('TGT-DIRECT');
    expect(res.json()).toMatchObject({ provider: 'tgt', iccid: ICCID });
  });

  it('uses delivery.provider directly for firoam without TGT fallback', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-fi',
        provider: 'firoam',
        vendorReferenceId: 'EP-DIRECT',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#2002',
      }),
    ]);
    mockQueryEsimOrder.mockResolvedValue(makeUsageResponse(ICCID));

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(200);
    expect(mockGetUsage).not.toHaveBeenCalled();
    expect(res.json()).toMatchObject({ provider: 'firoam', iccid: ICCID });
  });

  it('skips deliveries where JSON.parse fails (bad decrypt output) and continues', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-bad',
        payloadEncrypted: 'bad-json',
        orderName: '#1000',
        vendorReferenceId: null,
        customerEmail: null,
      }),
      makeDelivery({
        id: 'del-good',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#1001',
        vendorReferenceId: 'EP-001',
        customerEmail: 'a@b.com',
      }),
    ]);
    vi.mocked(decrypt)
      .mockImplementationOnce(() => 'not-valid-json{{{') // JSON.parse throws
      .mockImplementationOnce((val: string) => val.replace('enc:', ''));
    mockQueryEsimOrder.mockResolvedValue(makeUsageResponse(ICCID));

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(200);
    expect(res.json().iccid).toBe(ICCID);
  });
});

// ── GET /api/esim/usage?q= search endpoint ────────────────────────────────────

describe('GET /api/esim/usage?q=', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockQueryEsimOrder.mockReset();
    mockGetUsage.mockReset();
    vi.clearAllMocks();

    vi.mocked(decrypt).mockImplementation((val: string) => val.replace('enc:', ''));
    mockGetUsage.mockResolvedValue({ usage: null });

    app = Fastify({ logger: false });
    app.register(usageRoutes);
    await app.ready();
  });

  afterEach(async () => {
    vi.resetAllMocks();
    await app.close();
  });

  it('returns 400 when q is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/esim/usage' });
    expect(res.statusCode).toBe(400);
  });

  it('searches by ICCID when q has no @ and is not numeric', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-1',
        provider: 'firoam',
        vendorReferenceId: 'EP-001',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#1001',
      }),
    ]);
    mockQueryEsimOrder.mockResolvedValue(makeUsageResponse(ICCID));

    const res = await app.inject({ method: 'GET', url: `/api/esim/usage?q=${ICCID}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ provider: 'firoam', iccid: ICCID });
  });

  it('searches by order number when q matches #NNN or NNN', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-order',
        provider: 'tgt',
        vendorReferenceId: 'TGT-999',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#1001',
      }),
    ]);
    mockGetUsage.mockResolvedValue({
      usage: { dataTotal: '5 GB', dataUsage: '1 GB', dataResidual: '4 GB', refuelingTotal: null },
    });

    const res = await app.inject({ method: 'GET', url: '/api/esim/usage?q=%231001' });

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(prisma.esimDelivery.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orderName: '#1001' }) }),
    );
    expect(res.json()).toMatchObject({ provider: 'tgt' });
  });

  it('normalises bare order number (no #) when q is numeric', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-order2',
        provider: 'firoam',
        vendorReferenceId: 'EP-002',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#2002',
      }),
    ]);
    mockQueryEsimOrder.mockResolvedValue(makeUsageResponse(ICCID));

    const res = await app.inject({ method: 'GET', url: '/api/esim/usage?q=2002' });

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(prisma.esimDelivery.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orderName: '#2002' }) }),
    );
  });

  it('returns 404 when order not found', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([]);

    const res = await app.inject({ method: 'GET', url: '/api/esim/usage?q=9999' });

    expect(res.statusCode).toBe(404);
  });

  it('returns results array for order with multiple eSIMs', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-multi-1',
        provider: 'firoam',
        vendorReferenceId: 'EP-M1',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#5001',
      }),
      makeDelivery({
        id: 'del-multi-2',
        provider: 'tgt',
        vendorReferenceId: 'TGT-M2',
        payloadEncrypted: makePayload('8901234567890123457'),
        orderName: '#5001',
      }),
    ]);
    mockQueryEsimOrder.mockResolvedValue(makeUsageResponse(ICCID));
    mockGetUsage.mockResolvedValue({
      usage: { dataTotal: '10 GB', dataUsage: '2 GB', dataResidual: '8 GB', refuelingTotal: null },
    });

    const res = await app.inject({ method: 'GET', url: '/api/esim/usage?q=%235001' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('results');
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBe(2);
  });

  it('searches by email and returns results array', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-a',
        provider: 'firoam',
        vendorReferenceId: 'EP-A',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#3001',
        customerEmail: 'user@test.com',
      }),
    ]);
    mockQueryEsimOrder.mockResolvedValue(makeUsageResponse(ICCID));

    const res = await app.inject({ method: 'GET', url: '/api/esim/usage?q=user%40test.com' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('results');
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results[0]).toMatchObject({ provider: 'firoam' });
  });

  it('returns 404 for email with no delivered eSIMs', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([]);

    const res = await app.inject({ method: 'GET', url: '/api/esim/usage?q=nobody%40test.com' });

    expect(res.statusCode).toBe(404);
  });
});
