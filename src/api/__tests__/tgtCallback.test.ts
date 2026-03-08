import Fastify from 'fastify';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import tgtCallbackRoutes from '~/api/tgtCallback';
import TgtClient, { createTgtSignature } from '~/vendor/tgtClient';

vi.mock('~/db/prisma', () => ({
  default: {
    esimDelivery: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('~/worker/jobs/finalizeDelivery', () => ({
  finalizeDelivery: vi.fn(),
}));

import prisma from '~/db/prisma';
import { finalizeDelivery } from '~/worker/jobs/finalizeDelivery';

describe('TGT callback route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TGT_CALLBACK_SECRET = 'callback-secret';
  });

  it('rejects invalid signature', async () => {
    const app = Fastify();
    app.register(tgtCallbackRoutes, { prefix: '/webhook/tgt' });

    const payload = {
      code: '0000',
      msg: 'success',
      timestamp: '2026-03-08T00:00:00Z',
      sign: 'invalid',
      data: {
        eventType: 1,
        businessType: 'ESIM',
        orderInfo: {
          orderNo: 'SE1',
          qrCode: 'LPA:1$host$ACT',
        },
      },
    };

    const response = await app.inject({
      method: 'POST',
      url: '/webhook/tgt/callback',
      payload,
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects invalid callback payload shape', async () => {
    const app = Fastify();
    app.register(tgtCallbackRoutes, { prefix: '/webhook/tgt' });

    const response = await app.inject({
      method: 'POST',
      url: '/webhook/tgt/callback',
      payload: { bad: 'payload' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('finalizes delivery for valid callback payload', async () => {
    vi.mocked(prisma.esimDelivery.findFirst).mockResolvedValue({
      id: 'delivery-1',
      shop: 'test.myshopify.com',
      orderId: 'order-1',
      orderName: '#1001',
      lineItemId: 'line-1',
      variantId: 'var-1',
      customerEmail: 'test@example.com',
      vendorReferenceId: 'SE2',
      payloadEncrypted: null,
      status: 'pending',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = Fastify();
    app.register(tgtCallbackRoutes, { prefix: '/webhook/tgt' });

    const unsigned = {
      code: '0000',
      msg: 'success',
      timestamp: '2026-03-08T00:00:00Z',
      data: {
        eventType: 1,
        businessType: 'ESIM',
        orderInfo: {
          orderNo: 'SE2',
          qrCode: 'LPA:1$esiminfra.toprsp.com$ACT123',
          iccid: '8999',
        },
      },
    };
    const sign = createTgtSignature(unsigned, process.env.TGT_CALLBACK_SECRET || '');

    const response = await app.inject({
      method: 'POST',
      url: '/webhook/tgt/callback',
      payload: {
        ...unsigned,
        sign,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ code: '0000', msg: 'success' });
    expect(vi.mocked(finalizeDelivery)).toHaveBeenCalledWith({
      deliveryId: 'delivery-1',
      vendorOrderId: 'SE2',
      lpa: 'LPA:1$esiminfra.toprsp.com$ACT123',
      activationCode: 'ACT123',
      iccid: '8999',
    });
  });

  it('returns 500 when callback secret is not configured', async () => {
    delete process.env.TGT_CALLBACK_SECRET;
    delete process.env.TGT_SECRET;

    const app = Fastify();
    app.register(tgtCallbackRoutes, { prefix: '/webhook/tgt' });

    const unsigned = {
      code: '0000',
      msg: 'success',
      timestamp: '2026-03-08T00:00:00Z',
      data: {
        eventType: 1,
        businessType: 'ESIM',
        orderInfo: {
          orderNo: 'SE2',
          qrCode: 'LPA:1$esiminfra.toprsp.com$ACT123',
          iccid: '8999',
        },
      },
    };

    const response = await app.inject({
      method: 'POST',
      url: '/webhook/tgt/callback',
      payload: {
        ...unsigned,
        sign: 'dummy',
      },
    });

    expect(response.statusCode).toBe(500);
  });

  it('accepts callback for unknown order and still returns success', async () => {
    vi.mocked(prisma.esimDelivery.findFirst).mockResolvedValue(null);

    const app = Fastify();
    app.register(tgtCallbackRoutes, { prefix: '/webhook/tgt' });

    const unsigned = {
      code: '0000',
      msg: 'success',
      timestamp: '2026-03-08T00:00:00Z',
      data: {
        eventType: 1,
        businessType: 'ESIM',
        orderInfo: {
          orderNo: 'SE-UNKNOWN',
        },
      },
    };

    const sign = createTgtSignature(unsigned, process.env.TGT_CALLBACK_SECRET || '');
    const response = await app.inject({
      method: 'POST',
      url: '/webhook/tgt/callback',
      payload: { ...unsigned, sign },
    });

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(finalizeDelivery)).not.toHaveBeenCalled();
  });

  it('verifies signature helper compatibility', () => {
    const payload = {
      code: '0000',
      msg: 'success',
      timestamp: '2026-03-08T00:00:00Z',
      data: { eventType: 1, orderInfo: { orderNo: 'SE10' } },
    };

    const sign = createTgtSignature(payload, 'abc');
    expect(TgtClient.verifyCallbackSignature(payload, sign, 'abc')).toBe(true);
    expect(TgtClient.verifyCallbackSignature(payload, sign, 'different')).toBe(false);
  });
});
