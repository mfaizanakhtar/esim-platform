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
  hashIccid: vi.fn(() => 'hashed-iccid'),
}));

vi.mock('~/services/email', () => ({
  sendDeliveryEmail: vi.fn(async () => ({ success: true, messageId: 'msg-1' })),
  sendTopupEmail: vi.fn(async () => ({ success: true, messageId: 'topup-msg-1' })),
  recordDeliveryAttempt: vi.fn(async () => undefined),
}));

vi.mock('~/shopify/client', () => ({
  getShopifyClient: vi.fn(() => ({
    createFulfillment: vi.fn(async () => undefined),
    writeDeliveryMetafield: vi.fn(async () => undefined),
  })),
}));

import prisma from '~/db/prisma';
import { sendDeliveryEmail, sendTopupEmail, recordDeliveryAttempt } from '~/services/email';
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
      provider: null,
      iccidHash: null,
      topupIccid: null,
      sku: null,
      payloadEncrypted: null,
      accessToken: null,
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

  it('stores provider in updateMany when provided', async () => {
    vi.mocked(prisma.esimDelivery.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      id: 'd-tgt',
      shop: 'test.myshopify.com',
      orderId: '999',
      orderName: '#9001',
      lineItemId: 'line-tgt',
      variantId: 'var-tgt',
      customerEmail: null,
      vendorReferenceId: 'TGT-001',
      provider: null,
      iccidHash: null,
      topupIccid: null,
      sku: null,
      payloadEncrypted: null,
      accessToken: null,
      status: 'polling',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await finalizeDelivery({
      deliveryId: 'd-tgt',
      vendorOrderId: 'TGT-001',
      lpa: 'LPA:1$host$ACT',
      activationCode: 'ACT',
      iccid: '8999',
      provider: 'tgt',
    });

    expect(vi.mocked(prisma.esimDelivery.updateMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider: 'tgt' }),
      }),
    );
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
      provider: null,
      iccidHash: null,
      topupIccid: null,
      sku: null,
      payloadEncrypted: null,
      accessToken: null,
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
      provider: null,
      iccidHash: null,
      topupIccid: null,
      sku: null,
      payloadEncrypted: null,
      accessToken: null,
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
      provider: null,
      iccidHash: null,
      topupIccid: null,
      sku: null,
      payloadEncrypted: 'encrypted',
      accessToken: null,
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
      provider: null,
      iccidHash: null,
      topupIccid: null,
      sku: null,
      payloadEncrypted: 'encrypted',
      accessToken: null,
      status: 'pending',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(decrypt).mockRejectedValue(new Error('bad payload'));

    const payload = await getDecryptedEsimPayload('d1');
    expect(payload).toBeNull();
  });

  it('sends topupEmail and writes isTopup metafield for top-up delivery', async () => {
    // topupIccid is stored encrypted in DB; decrypt should return the plaintext ICCID
    vi.mocked(decrypt).mockImplementationOnce(() => '89001234567890');

    vi.mocked(prisma.esimDelivery.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      id: 'd-topup',
      shop: 'test.myshopify.com',
      orderId: 'order-topup',
      orderName: '#2001',
      lineItemId: 'line-topup',
      variantId: 'var-topup',
      customerEmail: 'user@example.com',
      vendorReferenceId: 'TGT-001',
      provider: 'tgt',
      iccidHash: null,
      topupIccid: 'enc:89001234567890',
      sku: 'ESIM-US-5GB',
      payloadEncrypted: null,
      accessToken: 'token-topup',
      status: 'polling',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const writeDeliveryMetafield = vi.fn(async () => undefined);
    vi.mocked(getShopifyClient).mockReturnValue({
      createFulfillment: vi.fn(async () => undefined),
      writeDeliveryMetafield,
    } as unknown as ReturnType<typeof getShopifyClient>);

    await finalizeDelivery({
      deliveryId: 'd-topup',
      vendorOrderId: 'TGT-001',
      lpa: '',
      activationCode: '',
      iccid: '89001234567890',
    });

    expect(vi.mocked(sendTopupEmail)).toHaveBeenCalled();
    expect(vi.mocked(sendDeliveryEmail)).not.toHaveBeenCalled();

    expect(writeDeliveryMetafield).toHaveBeenCalledWith(
      'order-topup',
      'line-topup',
      expect.objectContaining({ isTopup: true }),
    );
  });

  it('resolves ICCID from topupIccid pre-read when args.iccid is empty', async () => {
    // Simulate a renewal callback that arrives without an ICCID in args
    // The delivery has an encrypted topupIccid that should be used as fallback
    vi.mocked(decrypt).mockReturnValueOnce('89001234567890'); // pre-read decrypt call

    vi.mocked(prisma.esimDelivery.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.esimDelivery.findUnique)
      .mockResolvedValueOnce({ topupIccid: 'enc:89001234567890' } as never) // pre-read
      .mockResolvedValueOnce({
        id: 'd-renewal',
        shop: 'test.myshopify.com',
        orderId: 'order-renewal',
        orderName: '#2002',
        lineItemId: 'line-renewal',
        variantId: 'var-renewal',
        customerEmail: null,
        vendorReferenceId: 'RENEW-001',
        provider: 'tgt',
        iccidHash: null,
        topupIccid: 'enc:89001234567890',
        sku: 'ESIM-US-5GB',
        payloadEncrypted: null,
        accessToken: 'token-renewal',
        status: 'polling',
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never); // post-write read

    const result = await finalizeDelivery({
      deliveryId: 'd-renewal',
      vendorOrderId: 'RENEW-001',
      lpa: '',
      activationCode: '',
      iccid: '', // empty — should fall back to topupIccid
    });

    expect(result.ok).toBe(true);
    expect(vi.mocked(prisma.esimDelivery.updateMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ iccidHash: 'hashed-iccid' }),
      }),
    );
  });
});
