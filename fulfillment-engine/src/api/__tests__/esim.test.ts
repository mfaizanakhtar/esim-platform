import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import type { EsimDelivery } from '@prisma/client';
import esimRoutes from '~/api/esim';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockQueryEsimOrder = vi.fn();
const mockCancelOrder = vi.fn();
const mockQueryOrders = vi.fn();
const mockCancelShopifyOrder = vi.fn();

vi.mock('~/db/prisma', () => ({
  default: {
    esimDelivery: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('~/vendor/firoamClient', () => ({
  default: class MockFiRoamClient {
    queryEsimOrder(params: unknown) {
      return mockQueryEsimOrder(params);
    }
    cancelOrder(params: unknown) {
      return mockCancelOrder(params);
    }
  },
}));

vi.mock('~/vendor/tgtClient', () => ({
  default: class MockTgtClient {
    queryOrders(params: unknown) {
      return mockQueryOrders(params);
    }
  },
}));

vi.mock('~/shopify/client', () => ({
  getShopifyClient: () => ({
    cancelShopifyOrder: mockCancelShopifyOrder,
  }),
}));

vi.mock('~/utils/crypto', () => ({
  decrypt: vi.fn((v: string) => v.replace('enc:', '')),
  encrypt: vi.fn((v: string) => `enc:${v}`),
  hashIccid: vi.fn((v: string) => `hash:${v}`),
}));

import prisma from '~/db/prisma';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDelivery(overrides: Partial<EsimDelivery> = {}): EsimDelivery {
  return {
    id: 'del-1',
    shop: 'test.myshopify.com',
    orderId: '999',
    orderName: '#1001',
    lineItemId: '111',
    variantId: 'var-1',
    customerEmail: 'test@example.com',
    vendorReferenceId: 'vendor-ref-1',
    provider: 'firoam',
    iccidHash: 'hash:8901',
    payloadEncrypted: `enc:${JSON.stringify({ vendorId: 'vendor-ref-1', lpa: 'LPA:1$sm$code', activationCode: 'ACT123', iccid: '8901000000000001' })}`,
    accessToken: 'test-uuid-token',
    status: 'delivered',
    lastError: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

// ── Test suite ────────────────────────────────────────────────────────────────

describe('GET /esim/delivery/:token', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    app.register(esimRoutes);
    await app.ready();
  });

  it('returns 404 for unknown token', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(null);

    const res = await app.inject({ method: 'GET', url: '/esim/delivery/bad-token' });
    expect(res.statusCode).toBe(404);
  });

  it('returns status only for non-delivered eSIM', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(
      makeDelivery({ status: 'provisioning', payloadEncrypted: null }),
    );

    const res = await app.inject({ method: 'GET', url: '/esim/delivery/test-uuid-token' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'provisioning', canCancel: false });
  });

  it('returns credentials for delivered eSIM', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(makeDelivery());

    const res = await app.inject({ method: 'GET', url: '/esim/delivery/test-uuid-token' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'delivered',
      lpa: 'LPA:1$sm$code',
      activationCode: 'ACT123',
      iccid: '8901000000000001',
      canCancel: true,
    });
    expect(res.json().usageUrl).toContain('iccid=8901000000000001');
  });
});

describe('POST /esim/delivery/:token/cancel', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    app.register(esimRoutes);
    await app.ready();
  });

  it('returns 404 for unknown token', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(null);

    const res = await app.inject({
      method: 'POST',
      url: '/esim/delivery/bad-token/cancel',
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 if FiRoam eSIM is already activated (usedMb > 0)', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(makeDelivery());
    mockQueryEsimOrder.mockResolvedValue({
      success: true,
      orders: [
        {
          orderNum: 'vendor-ref-1',
          packages: [{ iccid: '8901000000000001', usedMb: 100, beginDate: '2026-01-01' }],
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/esim/delivery/test-uuid-token/cancel',
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'esim_already_activated' });
  });

  it('cancels successfully when FiRoam eSIM is not activated', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.esimDelivery.update).mockResolvedValue(makeDelivery({ status: 'cancelled' }));
    mockQueryEsimOrder.mockResolvedValue({
      success: true,
      orders: [
        {
          orderNum: 'vendor-ref-1',
          packages: [{ iccid: '8901000000000001', usedMb: 0, beginDate: null }],
        },
      ],
    });
    mockCancelOrder.mockResolvedValue({ success: true, message: 'ok' });
    mockCancelShopifyOrder.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/esim/delivery/test-uuid-token/cancel',
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(mockCancelOrder).toHaveBeenCalledWith({
      orderNum: 'vendor-ref-1',
      iccids: '8901000000000001',
    });
    expect(mockCancelShopifyOrder).toHaveBeenCalledWith('999');
    expect(vi.mocked(prisma.esimDelivery.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'cancelled' } }),
    );
  });

  it('returns 400 for non-delivered status', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(
      makeDelivery({ status: 'provisioning' }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/esim/delivery/test-uuid-token/cancel',
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'not_cancellable' });
  });

  it('returns 200 alreadyDone when already cancelled', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(
      makeDelivery({ status: 'cancelled' }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/esim/delivery/test-uuid-token/cancel',
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, alreadyDone: true });
  });

  it('returns 409 if TGT eSIM profileStatus is set', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(
      makeDelivery({ provider: 'tgt' }),
    );
    mockQueryOrders.mockResolvedValue({
      orders: [{ orderNo: 'vendor-ref-1', profileStatus: 'ACTIVE', activatedStartTime: null }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/esim/delivery/test-uuid-token/cancel',
      headers: JSON_HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'esim_already_activated' });
  });
});
