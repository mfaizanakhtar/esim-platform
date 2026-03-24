import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('~/db/prisma', () => ({
  default: {
    esimDelivery: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('~/utils/crypto', () => ({
  decrypt: vi.fn(() => JSON.stringify({ iccid: '89001234567890', vendorId: 'VENDOR-001' })),
}));

const mockAppendOrderNote = vi.fn(async () => undefined);
const mockAddOrderTags = vi.fn(async () => undefined);
const mockWriteDeliveryMetafield = vi.fn(async () => undefined);

vi.mock('~/shopify/client', () => ({
  getShopifyClient: vi.fn(() => ({
    appendOrderNote: mockAppendOrderNote,
    addOrderTags: mockAddOrderTags,
    writeDeliveryMetafield: mockWriteDeliveryMetafield,
  })),
}));

// FiRoam mock — expose method spies as module-level vars so tests can configure them
const mockQueryEsimOrder = vi.fn();
const mockFiroamCancelOrder = vi.fn();

vi.mock('~/vendor/firoamClient', () => ({
  default: class MockFiRoamClient {
    queryEsimOrder(...args: unknown[]) {
      return mockQueryEsimOrder(...args);
    }
    cancelOrder(...args: unknown[]) {
      return mockFiroamCancelOrder(...args);
    }
  },
}));

// TGT mock
const mockQueryOrders = vi.fn();

vi.mock('~/vendor/tgtClient', () => ({
  default: class MockTgtClient {
    queryOrders(...args: unknown[]) {
      return mockQueryOrders(...args);
    }
  },
}));

import prisma from '~/db/prisma';
import { handleCancelEsim } from '~/worker/jobs/cancelEsim';

const baseDelivery = {
  id: 'd1',
  shop: 'test.myshopify.com',
  orderId: 'order-1',
  orderName: '#1001',
  lineItemId: 'line-1',
  variantId: 'var-1',
  customerEmail: 'user@example.com',
  vendorReferenceId: 'VENDOR-001',
  provider: 'firoam' as string | null,
  iccidHash: null,
  payloadEncrypted: 'encrypted-payload',
  accessToken: 'token-abc',
  status: 'delivered',
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('handleCancelEsim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.esimDelivery.update).mockResolvedValue(baseDelivery as never);
  });

  it('skips when delivery not found', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(null);

    await handleCancelEsim({ deliveryId: 'd-missing', orderId: 'order-1' });

    expect(prisma.esimDelivery.update).not.toHaveBeenCalled();
  });

  it('skips when delivery already cancelled', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      ...baseDelivery,
      status: 'cancelled',
    } as never);

    await handleCancelEsim({ deliveryId: 'd1', orderId: 'order-1' });

    expect(prisma.esimDelivery.update).not.toHaveBeenCalled();
    expect(mockAppendOrderNote).not.toHaveBeenCalled();
  });

  it('is resilient when Shopify write fails for non-delivered delivery', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      ...baseDelivery,
      status: 'pending',
    } as never);
    mockAppendOrderNote.mockRejectedValueOnce(new Error('shopify down'));

    await expect(
      handleCancelEsim({ deliveryId: 'd1', orderId: 'order-1' }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(prisma.esimDelivery.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'cancelled' } }),
    );
  });

  it('cancels non-delivered delivery without vendor call', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      ...baseDelivery,
      status: 'pending',
    } as never);

    await handleCancelEsim({ deliveryId: 'd1', orderId: 'order-1' });

    expect(vi.mocked(prisma.esimDelivery.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'cancelled' } }),
    );
    expect(mockAppendOrderNote).toHaveBeenCalled();
    expect(mockAddOrderTags).toHaveBeenCalledWith('order-1', ['esim-cancelled']);
    expect(mockFiroamCancelOrder).not.toHaveBeenCalled();
  });

  it('marks failed when payload is missing on delivered delivery', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      ...baseDelivery,
      payloadEncrypted: null,
    } as never);

    await handleCancelEsim({ deliveryId: 'd1', orderId: 'order-1' });

    // writeOutcome called without tags for this case — just note + metafield
    expect(mockAppendOrderNote).toHaveBeenCalled();
    expect(mockFiroamCancelOrder).not.toHaveBeenCalled();
  });

  describe('FiRoam provider', () => {
    beforeEach(() => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(baseDelivery as never);
    });

    it('blocks cancel and writes note when eSIM already activated', async () => {
      mockQueryEsimOrder.mockResolvedValue({
        success: true,
        orders: [
          {
            packages: [{ iccid: '89001234567890', usedMb: '100', beginDate: '2026-01-01' }],
          },
        ],
      });

      await handleCancelEsim({ deliveryId: 'd1', orderId: 'order-1' });

      expect(mockFiroamCancelOrder).not.toHaveBeenCalled();
      expect(mockAddOrderTags).toHaveBeenCalledWith(
        'order-1',
        expect.arrayContaining(['esim-cancel-failed', 'esim-activated']),
      );
    });

    it('cancels successfully with FiRoam when not activated', async () => {
      mockQueryEsimOrder.mockResolvedValue({
        success: true,
        orders: [{ packages: [{ iccid: '89001234567890', usedMb: '0', beginDate: null }] }],
      });
      mockFiroamCancelOrder.mockResolvedValue({ success: true });

      await handleCancelEsim({ deliveryId: 'd1', orderId: 'order-1' });

      expect(mockFiroamCancelOrder).toHaveBeenCalledWith({
        orderNum: 'VENDOR-001',
        iccids: '89001234567890',
      });
      expect(vi.mocked(prisma.esimDelivery.update)).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'cancelled' } }),
      );
      expect(mockAddOrderTags).toHaveBeenCalledWith('order-1', ['esim-cancelled']);
    });

    it('writes failure note when FiRoam cancel fails', async () => {
      mockQueryEsimOrder.mockResolvedValue({ success: true, orders: [] });
      mockFiroamCancelOrder.mockResolvedValue({ success: false, message: 'Order not found' });

      await handleCancelEsim({ deliveryId: 'd1', orderId: 'order-1' });

      expect(mockAddOrderTags).toHaveBeenCalledWith('order-1', ['esim-cancel-failed']);
      expect(vi.mocked(prisma.esimDelivery.update)).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'cancelled' } }),
      );
    });
  });

  describe('TGT provider', () => {
    beforeEach(() => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
        ...baseDelivery,
        provider: 'tgt',
      } as never);
    });

    it('blocks cancel when TGT eSIM already activated', async () => {
      mockQueryOrders.mockResolvedValue({
        orders: [{ profileStatus: 'active', activatedStartTime: '2026-01-01' }],
      });

      await handleCancelEsim({ deliveryId: 'd1', orderId: 'order-1' });

      expect(mockAddOrderTags).toHaveBeenCalledWith(
        'order-1',
        expect.arrayContaining(['esim-cancel-failed', 'esim-activated']),
      );
    });

    it('marks cancelled and adds manual-cancel tag for unactivated TGT eSIM', async () => {
      mockQueryOrders.mockResolvedValue({
        orders: [{ profileStatus: null, activatedStartTime: null }],
      });

      await handleCancelEsim({ deliveryId: 'd1', orderId: 'order-1' });

      expect(vi.mocked(prisma.esimDelivery.update)).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'cancelled' } }),
      );
      expect(mockAddOrderTags).toHaveBeenCalledWith(
        'order-1',
        expect.arrayContaining(['esim-cancelled', 'esim-tgt-manual-cancel-needed']),
      );
    });
  });

  it('marks failed when decrypt throws', async () => {
    const { decrypt } = await import('~/utils/crypto');
    vi.mocked(decrypt).mockImplementationOnce(() => {
      throw new Error('bad key');
    });
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(baseDelivery as never);

    await handleCancelEsim({ deliveryId: 'd1', orderId: 'order-1' });

    expect(mockAppendOrderNote).toHaveBeenCalled();
    expect(mockFiroamCancelOrder).not.toHaveBeenCalled();
  });

  it('marks failed when iccid is missing from decrypted payload', async () => {
    const { decrypt } = await import('~/utils/crypto');
    vi.mocked(decrypt).mockReturnValueOnce(JSON.stringify({ iccid: undefined, vendorId: 'V1' }));
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      ...baseDelivery,
      vendorReferenceId: 'V1',
    } as never);

    await handleCancelEsim({ deliveryId: 'd1', orderId: 'order-1' });

    // iccid missing → writeOutcome called with 'failed'
    expect(mockAppendOrderNote).toHaveBeenCalled();
    expect(mockFiroamCancelOrder).not.toHaveBeenCalled();
  });

  describe('writeOutcome resilience (delivered FiRoam path)', () => {
    function setupSuccessfulFiroamCancel() {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(baseDelivery as never);
      mockQueryEsimOrder.mockResolvedValue({ success: true, orders: [] });
      mockFiroamCancelOrder.mockResolvedValue({ success: true });
    }

    it('is resilient when Shopify metafield write throws', async () => {
      setupSuccessfulFiroamCancel();
      mockWriteDeliveryMetafield.mockRejectedValueOnce(new Error('metafield error'));

      await expect(
        handleCancelEsim({ deliveryId: 'd1', orderId: 'order-1' }),
      ).resolves.toBeUndefined();
    });

    it('is resilient when Shopify note write throws', async () => {
      setupSuccessfulFiroamCancel();
      mockAppendOrderNote.mockRejectedValueOnce(new Error('note error'));

      await expect(
        handleCancelEsim({ deliveryId: 'd1', orderId: 'order-1' }),
      ).resolves.toBeUndefined();
    });

    it('is resilient when Shopify addOrderTags throws', async () => {
      setupSuccessfulFiroamCancel();
      mockAddOrderTags.mockRejectedValueOnce(new Error('tags error'));

      await expect(
        handleCancelEsim({ deliveryId: 'd1', orderId: 'order-1' }),
      ).resolves.toBeUndefined();
    });
  });

  it('writes unknown-provider note when provider is unrecognised', async () => {
    vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue({
      ...baseDelivery,
      provider: 'unknown-vendor',
    } as never);

    await handleCancelEsim({ deliveryId: 'd1', orderId: 'order-1' });

    expect(mockAddOrderTags).toHaveBeenCalledWith('order-1', ['esim-cancel-failed']);
  });
});
