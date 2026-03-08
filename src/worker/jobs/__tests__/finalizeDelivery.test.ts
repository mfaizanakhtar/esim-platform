import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('~/db/prisma', () => ({
  default: {
    esimDelivery: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('~/utils/crypto', () => ({
  encrypt: vi.fn(() => 'encrypted-payload'),
  decrypt: vi.fn(() => JSON.stringify({ lpa: 'LPA:1$h$a', activationCode: 'a', iccid: '1' })),
}));

vi.mock('~/services/email', () => ({
  sendDeliveryEmail: vi.fn(async () => ({ success: true, messageId: 'msg-1' })),
  recordDeliveryAttempt: vi.fn(async () => undefined),
}));

vi.mock('~/shopify/client', () => ({
  getShopifyClient: vi.fn(() => ({ createFulfillment: vi.fn(async () => undefined) })),
}));

import prisma from '~/db/prisma';
import { sendDeliveryEmail, recordDeliveryAttempt } from '~/services/email';
import { getShopifyClient } from '~/shopify/client';
import { finalizeDelivery, getDecryptedEsimPayload } from '~/worker/jobs/finalizeDelivery';
import { decrypt } from '~/utils/crypto';

describe('finalizeDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is idempotent when already delivered', async () => {
    vi.mocked(prisma.esimDelivery.updateMany).mockResolvedValue({ count: 0 });

    const result = await finalizeDelivery({
      deliveryId: 'd1',
      vendorOrderId: 'SE1',
      lpa: 'LPA:1$host$ACT',
      activationCode: 'ACT',
      iccid: '8999',
    });

    expect(result.alreadyDone).toBe(true);
    expect(vi.mocked(sendDeliveryEmail)).not.toHaveBeenCalled();
  });

  it('sends email and creates fulfillment when finalizing first time', async () => {
    vi.mocked(prisma.esimDelivery.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      id: 'd1',
      shop: 'test.myshopify.com',
      orderId: '123',
      orderName: '#1001',
      lineItemId: 'line-1',
      variantId: 'var-1',
      customerEmail: 'user@example.com',
      vendorReferenceId: 'ref-1',
      payloadEncrypted: null,
      status: 'pending',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await finalizeDelivery({
      deliveryId: 'd1',
      vendorOrderId: 'SE1',
      lpa: 'LPA:1$host$ACT',
      activationCode: 'ACT',
      iccid: '8999',
      metadata: {
        productName: 'Israel 3GB',
        region: 'Middle East',
      },
    });

    expect(vi.mocked(sendDeliveryEmail)).toHaveBeenCalled();
    expect(vi.mocked(recordDeliveryAttempt)).toHaveBeenCalled();
    expect(vi.mocked(getShopifyClient)).toHaveBeenCalled();
  });

  it('handles missing delivery after updateMany without throwing', async () => {
    vi.mocked(prisma.esimDelivery.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(null);

    const result = await finalizeDelivery({
      deliveryId: 'd-missing',
      vendorOrderId: 'SE2',
      lpa: 'LPA:1$host$ACT',
      activationCode: 'ACT',
      iccid: '8999',
    });

    expect(result.ok).toBe(true);
    expect(vi.mocked(sendDeliveryEmail)).not.toHaveBeenCalled();
  });

  it('continues when email provider fails', async () => {
    vi.mocked(prisma.esimDelivery.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      id: 'd2',
      shop: 'test.myshopify.com',
      orderId: '123',
      orderName: '#1002',
      lineItemId: 'line-2',
      variantId: 'var-2',
      customerEmail: 'user@example.com',
      vendorReferenceId: 'ref-2',
      payloadEncrypted: null,
      status: 'pending',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(sendDeliveryEmail).mockResolvedValue({ success: false, error: 'smtp down' });

    await finalizeDelivery({
      deliveryId: 'd2',
      vendorOrderId: 'SE2',
      lpa: 'LPA:1$host$ACT',
      activationCode: 'ACT',
      iccid: '8999',
    });

    expect(vi.mocked(recordDeliveryAttempt)).toHaveBeenCalled();
  });

  it('continues when Shopify fulfillment fails', async () => {
    vi.mocked(prisma.esimDelivery.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      id: 'd3',
      shop: 'test.myshopify.com',
      orderId: 'order-3',
      orderName: '#1003',
      lineItemId: 'line-3',
      variantId: 'var-3',
      customerEmail: null,
      vendorReferenceId: 'ref-3',
      payloadEncrypted: null,
      status: 'pending',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.mocked(getShopifyClient).mockReturnValue({
      createFulfillment: vi.fn(async () => {
        throw new Error('shopify down');
      }),
    } as unknown as ReturnType<typeof getShopifyClient>);

    const result = await finalizeDelivery({
      deliveryId: 'd3',
      vendorOrderId: 'SE3',
      lpa: 'LPA:1$host$ACT',
      activationCode: 'ACT',
      iccid: '8999',
    });

    expect(result.ok).toBe(true);
  });

  it('decrypts stored payload helper', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      id: 'd1',
      shop: 'test.myshopify.com',
      orderId: 'order-1',
      orderName: '#1001',
      lineItemId: 'line-1',
      variantId: 'var-1',
      customerEmail: 'test@example.com',
      vendorReferenceId: 'ref-1',
      payloadEncrypted: 'encrypted',
      status: 'pending',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const payload = await getDecryptedEsimPayload('d1');
    expect(payload?.lpa).toBe('LPA:1$h$a');
  });

  it('returns null when decrypt fails', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      id: 'd1',
      shop: 'test.myshopify.com',
      orderId: 'order-1',
      orderName: '#1001',
      lineItemId: 'line-1',
      variantId: 'var-1',
      customerEmail: 'test@example.com',
      vendorReferenceId: 'ref-1',
      payloadEncrypted: 'encrypted',
      status: 'pending',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(decrypt).mockRejectedValue(new Error('bad payload'));

    const payload = await getDecryptedEsimPayload('d1');
    expect(payload).toBeNull();
  });
});
