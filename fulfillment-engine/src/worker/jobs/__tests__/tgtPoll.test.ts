import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleTgtPoll } from '~/worker/jobs/tgtPoll';

const queueSendMock = vi.fn();

vi.mock('~/db/prisma', () => ({
  default: {
    esimDelivery: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('~/vendor/tgtClient', () => ({
  default: class MockTgtClient {
    async tryResolveOrderCredentials() {
      return { ready: false };
    }
  },
}));

vi.mock('~/worker/jobs/finalizeDelivery', () => ({
  finalizeDelivery: vi.fn(),
}));

vi.mock('~/queue/jobQueue', () => ({
  getJobQueue: vi.fn(() => ({
    send: queueSendMock,
  })),
}));

import prisma from '~/db/prisma';
import TgtClient from '~/vendor/tgtClient';
import { finalizeDelivery } from '~/worker/jobs/finalizeDelivery';

describe('handleTgtPoll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueSendMock.mockReset();
  });

  it('finalizes when credentials are ready', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      id: 'delivery-1',
      shop: 'test.myshopify.com',
      orderId: 'order-1',
      orderName: '#1001',
      lineItemId: 'line-1',
      variantId: 'var-1',
      customerEmail: 'test@example.com',
      vendorReferenceId: 'ref-1',
      provider: null,
      iccidHash: null,
      payloadEncrypted: null,
      accessToken: null,
      status: 'polling',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.spyOn(TgtClient.prototype, 'tryResolveOrderCredentials').mockResolvedValue({
      ready: true,
      lpa: 'LPA:1$host$ACT',
      activationCode: 'ACT',
      iccid: '8999',
    });

    const result = await handleTgtPoll({
      deliveryId: 'delivery-1',
      orderNo: 'SE123',
      attempt: 1,
      maxAttempts: 3,
      mode: 'hybrid',
    });

    expect(result.reason).toBe('resolved');
    expect(vi.mocked(finalizeDelivery)).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'tgt' }),
    );
  });

  it('requeues when not ready and attempts remain', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      id: 'delivery-1',
      shop: 'test.myshopify.com',
      orderId: 'order-1',
      orderName: '#1001',
      lineItemId: 'line-1',
      variantId: 'var-1',
      customerEmail: 'test@example.com',
      vendorReferenceId: 'ref-1',
      provider: null,
      iccidHash: null,
      payloadEncrypted: null,
      accessToken: null,
      status: 'polling',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.spyOn(TgtClient.prototype, 'tryResolveOrderCredentials').mockResolvedValue({
      ready: false,
    });

    const result = await handleTgtPoll({
      deliveryId: 'delivery-1',
      orderNo: 'SE123',
      attempt: 1,
      maxAttempts: 3,
      mode: 'hybrid',
    });

    expect(result.reason).toBe('requeued');
    expect(queueSendMock).toHaveBeenCalled();
  });

  it('fails delivery when attempts exhausted in polling mode', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      id: 'delivery-1',
      shop: 'test.myshopify.com',
      orderId: 'order-1',
      orderName: '#1001',
      lineItemId: 'line-1',
      variantId: 'var-1',
      customerEmail: 'test@example.com',
      vendorReferenceId: 'ref-1',
      provider: null,
      iccidHash: null,
      payloadEncrypted: null,
      accessToken: null,
      status: 'polling',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.spyOn(TgtClient.prototype, 'tryResolveOrderCredentials').mockResolvedValue({
      ready: false,
    });

    const result = await handleTgtPoll({
      deliveryId: 'delivery-1',
      orderNo: 'SE123',
      attempt: 3,
      maxAttempts: 3,
      mode: 'polling',
    });

    expect(result.reason).toBe('poll_exhausted');
    expect(vi.mocked(prisma.esimDelivery.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });

  it('returns early when delivery is missing', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(null);

    const result = await handleTgtPoll({
      deliveryId: 'missing',
      orderNo: 'SE123',
      attempt: 1,
      maxAttempts: 3,
      mode: 'hybrid',
    });

    expect(result.reason).toBe('delivery_not_found');
  });

  it('returns early when delivery already delivered', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      id: 'delivery-1',
      shop: 'test.myshopify.com',
      orderId: 'order-1',
      orderName: '#1001',
      lineItemId: 'line-1',
      variantId: 'var-1',
      customerEmail: 'test@example.com',
      vendorReferenceId: 'ref-1',
      provider: null,
      iccidHash: null,
      payloadEncrypted: null,
      accessToken: null,
      status: 'delivered',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await handleTgtPoll({
      deliveryId: 'delivery-1',
      orderNo: 'SE123',
      attempt: 1,
      maxAttempts: 3,
      mode: 'hybrid',
    });

    expect(result.reason).toBe('already_delivered');
  });

  it('falls back to awaiting_callback when hybrid attempts are exhausted', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      id: 'delivery-1',
      shop: 'test.myshopify.com',
      orderId: 'order-1',
      orderName: '#1001',
      lineItemId: 'line-1',
      variantId: 'var-1',
      customerEmail: 'test@example.com',
      vendorReferenceId: 'ref-1',
      provider: null,
      iccidHash: null,
      payloadEncrypted: null,
      accessToken: null,
      status: 'polling',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.spyOn(TgtClient.prototype, 'tryResolveOrderCredentials').mockResolvedValue({
      ready: false,
    });

    const result = await handleTgtPoll({
      deliveryId: 'delivery-1',
      orderNo: 'SE123',
      attempt: 3,
      maxAttempts: 3,
      mode: 'hybrid',
    });

    expect(result.reason).toBe('poll_exhausted');
    expect(vi.mocked(prisma.esimDelivery.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'awaiting_callback' }),
      }),
    );
  });
});
