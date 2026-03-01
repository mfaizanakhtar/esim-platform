import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import type { EsimDelivery } from '@prisma/client';
import usageRoutes from '../usage';

// ── Module-level mock fn — reset per test in beforeEach ───────────────────────
type QueryEsimOrderParams = {
  orderNum?: string;
  iccid?: string;
  pageNo?: number;
  pageSize?: number;
};
const mockQueryEsimOrder = vi.fn<(params: QueryEsimOrderParams) => unknown>();

// ── Mocks hoisted before imports ─────────────────────────────────────────────
vi.mock('../../db/prisma', () => ({
  default: {
    esimDelivery: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../vendor/firoamClient', () => ({
  default: class MockFiRoamClient {
    queryEsimOrder(params: QueryEsimOrderParams) {
      return mockQueryEsimOrder(params);
    }
  },
}));

vi.mock('../../utils/crypto', () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
}));

import prisma from '../../db/prisma';
import { decrypt } from '../../utils/crypto';

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
    payloadEncrypted: null,
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
function makePayload(iccid: string): string {
  return `enc:${JSON.stringify({ iccid, lpa: 'LPA:1$test$code', activationCode: 'code' })}`;
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
    vi.clearAllMocks();

    // Default decrypt: strip our "enc:" prefix so JSON.parse works
    vi.mocked(decrypt).mockImplementation((val: string) => val.replace('enc:', ''));

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

  it('returns 404 when ICCID not found in FiRoam order packages', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-1',
        vendorReferenceId: 'EP-001',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#1001',
        customerEmail: 'a@b.com',
      }),
    ]);
    // FiRoam returns a different ICCID in the package
    mockQueryEsimOrder.mockResolvedValue(makeUsageResponse('0000000000000000000'));

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'Package not found' });
  });

  // ── 500 cases ───────────────────────────────────────────────────────────────

  it('returns 500 when FiRoam returns success: false', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-1',
        vendorReferenceId: 'EP-001',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#1001',
        customerEmail: 'a@b.com',
      }),
    ]);
    mockQueryEsimOrder.mockResolvedValue({ success: false, error: 'Order not found' });

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: 'Failed to fetch usage data' });
  });

  it('returns 500 when FiRoam returns empty orders array', async () => {
    vi.mocked(prisma.esimDelivery.findMany).mockResolvedValue([
      makeDelivery({
        id: 'del-1',
        vendorReferenceId: 'EP-001',
        payloadEncrypted: makePayload(ICCID),
        orderName: '#1001',
        customerEmail: 'a@b.com',
      }),
    ]);
    mockQueryEsimOrder.mockResolvedValue({ success: true, orders: [] });

    const res = await app.inject({ method: 'GET', url: `/api/esim/${ICCID}/usage` });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: 'Failed to fetch usage data' });
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
