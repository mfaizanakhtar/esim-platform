import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { handleProvision } from '../provisionEsim';

// Mock all dependencies
vi.mock('../../../db/prisma', () => ({
  default: {
    esimDelivery: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    providerSkuMapping: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../../vendor/firoamClient');

vi.mock('../../../services/email', () => ({
  sendDeliveryEmail: vi.fn(),
  recordDeliveryAttempt: vi.fn(),
}));

vi.mock('../../../shopify/client', () => ({
  getShopifyClient: vi.fn(() => ({
    createFulfillment: vi.fn(),
  })),
}));

import prisma from '../../../db/prisma';
import FiRoamClient from '../../../vendor/firoamClient';
import { sendDeliveryEmail } from '../../../services/email';

describe('provisionEsim Worker Job', () => {
  let mockAddEsimOrder: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!';

    // Setup FiRoamClient mock
    mockAddEsimOrder = vi.fn();
    vi.mocked(FiRoamClient).mockImplementation(
      () =>
        ({
          addEsimOrder: mockAddEsimOrder,
        }) as unknown,
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Basic Job Processing', () => {
    it('should throw error if deliveryId is missing', async () => {
      await expect(handleProvision({})).rejects.toThrow('missing deliveryId');
    });

    it('should throw error if delivery record not found', async () => {
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(null);

      await expect(handleProvision({ deliveryId: 'non-existent' })).rejects.toThrow(
        'EsimDelivery non-existent not found',
      );
    });

    it('should skip if delivery already completed', async () => {
      const mockDelivery = {
        id: 'delivery-123',
        orderId: '1001',
        orderName: '#1001',
        lineItemId: '111',
        variantId: '222',
        customerEmail: 'test@example.com',
        sku: 'ESIM-USA-10GB',
        productName: 'USA eSIM',
        status: 'delivered',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);

      const result = await handleProvision({ deliveryId: 'delivery-123' });

      expect(result).toEqual({ ok: true, reason: 'already delivered' });
      expect(prisma.esimDelivery.update).not.toHaveBeenCalled();
    });

    it('should update status to provisioning when starting', async () => {
      const mockDelivery = {
        id: 'delivery-123',
        orderId: '1001',
        orderName: '#1001',
        lineItemId: '111',
        variantId: '222',
        customerEmail: 'test@example.com',
        sku: 'ESIM-USA-10GB',
        productName: 'USA eSIM',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);

      try {
        await handleProvision({ deliveryId: 'delivery-123' });
      } catch (error) {
        // Expected to fail due to missing SKU mapping
      }

      expect(prisma.esimDelivery.update).toHaveBeenCalledWith({
        where: { id: 'delivery-123' },
        data: { status: 'provisioning' },
      });
    });
  });

  describe('SKU Mapping Lookup', () => {
    it('should throw error if SKU is missing', async () => {
      const mockDelivery = {
        id: 'delivery-123',
        orderId: '1001',
        orderName: '#1001',
        lineItemId: '111',
        variantId: '222',
        customerEmail: 'test@example.com',
        sku: null,
        productName: 'USA eSIM',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);

      await expect(handleProvision({ deliveryId: 'delivery-123' })).rejects.toThrow(
        'Missing SKU in job data',
      );
    });

    it('should throw error if SKU mapping not found', async () => {
      const mockDelivery = {
        id: 'delivery-123',
        orderId: '1001',
        orderName: '#1001',
        lineItemId: '111',
        variantId: '222',
        customerEmail: 'test@example.com',
        sku: 'UNKNOWN-SKU',
        productName: 'USA eSIM',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);

      await expect(
        handleProvision({ deliveryId: 'delivery-123', sku: 'UNKNOWN-SKU' }),
      ).rejects.toThrow('No provider mapping found for SKU: UNKNOWN-SKU');
    });

    it('should throw error if SKU mapping is inactive', async () => {
      const mockDelivery = {
        id: 'delivery-123',
        orderId: '1001',
        orderName: '#1001',
        lineItemId: '111',
        variantId: '222',
        customerEmail: 'test@example.com',
        sku: 'ESIM-USA-10GB',
        productName: 'USA eSIM',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockMapping = {
        id: 'mapping-1',
        shopifySku: 'ESIM-USA-10GB',
        provider: 'firoam',
        providerSku: '120:826-0-?-1-G-D:14094',
        isActive: false,
        name: 'USA 10GB',
        region: null,
        dataAmount: null,
        validity: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(mockMapping);

      await expect(
        handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-USA-10GB' }),
      ).rejects.toThrow('SKU mapping is inactive: ESIM-USA-10GB');
    });

    it('should throw error for unsupported provider', async () => {
      const mockDelivery = {
        id: 'delivery-123',
        orderId: '1001',
        orderName: '#1001',
        lineItemId: '111',
        variantId: '222',
        customerEmail: 'test@example.com',
        sku: 'ESIM-USA-10GB',
        productName: 'USA eSIM',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockMapping = {
        id: 'mapping-1',
        shopifySku: 'ESIM-USA-10GB',
        provider: 'unsupported-provider',
        providerSku: 'some-sku',
        isActive: true,
        name: 'USA 10GB',
        region: null,
        dataAmount: null,
        validity: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(mockMapping);

      await expect(
        handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-USA-10GB' }),
      ).rejects.toThrow('Unsupported provider: unsupported-provider');
    });
  });

  describe('Provider SKU Format Validation', () => {
    it('should throw error for invalid providerSku format', async () => {
      const mockDelivery = {
        id: 'delivery-123',
        orderId: '1001',
        orderName: '#1001',
        lineItemId: '111',
        variantId: '222',
        customerEmail: 'test@example.com',
        sku: 'ESIM-USA-10GB',
        productName: 'USA eSIM',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockMapping = {
        id: 'mapping-1',
        shopifySku: 'ESIM-USA-10GB',
        provider: 'firoam',
        providerSku: 'invalid', // Invalid format (should be skuId:apiCode:priceId)
        isActive: true,
        name: 'USA 10GB',
        region: null,
        dataAmount: null,
        validity: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(mockMapping);

      await expect(
        handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-USA-10GB' }),
      ).rejects.toThrow(/Invalid providerSku format/);
    });

    it('should parse providerSku correctly (new format)', () => {
      const providerSku = '120:826-0-?-1-G-D:14094';
      const parts = providerSku.split(':');

      expect(parts).toHaveLength(3);
      expect(parts[0]).toBe('120'); // skuId
      expect(parts[1]).toBe('826-0-?-1-G-D'); // apiCode
      expect(parts[2]).toBe('14094'); // priceId
    });

    it('should parse providerSku correctly (legacy format)', () => {
      const providerSku = '120:826-0-?-1-G-D';
      const parts = providerSku.split(':');

      expect(parts).toHaveLength(2);
      expect(parts[0]).toBe('120'); // skuId
      expect(parts[1]).toBe('826-0-?-1-G-D'); // apiCode
      expect(parts[2]).toBeUndefined(); // No priceId in legacy format
    });
  });

  describe('FiRoam Order Provisioning', () => {
    it('should build orderPayload with skuId and priceId', async () => {
      const mockDelivery = {
        id: 'delivery-123',
        orderId: '1001',
        orderName: '#1001',
        lineItemId: '111',
        variantId: '222',
        customerEmail: 'test@example.com',
        sku: 'ESIM-USA-10GB',
        productName: 'USA eSIM',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockMapping = {
        id: 'mapping-1',
        shopifySku: 'ESIM-USA-10GB',
        provider: 'firoam',
        providerSku: '120:826-0-?-1-G-D:14094',
        isActive: true,
        name: 'USA 10GB',
        region: 'USA',
        dataAmount: '10GB',
        validity: '30 days',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockFiRoamResult = {
        raw: { code: 0, data: { orderNum: 'EP-123456' } },
        canonical: {
          vendorId: 'EP-123456',
          lpa: 'LPA:1$smdp.io$activation-code',
          activationCode: 'activation-code',
          iccid: '8901000000000000001',
        },
        db: { id: 'esim-order-1' },
      };

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(mockMapping);

      // Mock the FiRoam addEsimOrder response
      mockAddEsimOrder.mockResolvedValue(mockFiRoamResult);

      vi.mocked(sendDeliveryEmail).mockResolvedValue({
        success: true,
        messageId: 'email-123',
      });

      await handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-USA-10GB' });

      expect(mockAddEsimOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          skuId: '120',
          priceId: '14094',
          count: '1',
        }),
      );
    });
  });

  describe('Email Delivery', () => {
    it('should send email if customerEmail exists', async () => {
      const mockDelivery = {
        id: 'delivery-123',
        orderId: '1001',
        orderName: '#1001',
        lineItemId: '111',
        variantId: '222',
        customerEmail: 'customer@example.com',
        sku: 'ESIM-USA-10GB',
        productName: 'USA eSIM',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockMapping = {
        id: 'mapping-1',
        shopifySku: 'ESIM-USA-10GB',
        provider: 'firoam',
        providerSku: '120:826-0-?-1-G-D:14094',
        isActive: true,
        name: 'USA 10GB',
        region: 'USA',
        dataAmount: '10GB',
        validity: '30 days',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockFiRoamResult = {
        raw: { code: 0, data: { orderNum: 'EP-123456' } },
        canonical: {
          vendorId: 'EP-123456',
          lpa: 'LPA:1$smdp.io$activation-code',
          activationCode: 'activation-code',
          iccid: '8901000000000000001',
        },
        db: { id: 'esim-order-1' },
      };

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(mockMapping);

      // Mock the FiRoam addEsimOrder response
      mockAddEsimOrder.mockResolvedValue(mockFiRoamResult);

      await handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-USA-10GB' });

      expect(sendDeliveryEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'customer@example.com',
          orderNumber: '#1001',
          productName: 'USA 10GB',
        }),
      );
    });

    it('should skip email if customerEmail is missing', async () => {
      const mockDelivery = {
        id: 'delivery-123',
        orderId: '1001',
        orderName: '#1001',
        lineItemId: '111',
        variantId: '222',
        customerEmail: null,
        sku: 'ESIM-USA-10GB',
        productName: 'USA eSIM',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockMapping = {
        id: 'mapping-1',
        shopifySku: 'ESIM-USA-10GB',
        provider: 'firoam',
        providerSku: '120:826-0-?-1-G-D:14094',
        isActive: true,
        name: 'USA 10GB',
        region: null,
        dataAmount: null,
        validity: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockFiRoamResult = {
        raw: { code: 0, data: { orderNum: 'EP-123456' } },
        canonical: {
          vendorId: 'EP-123456',
          lpa: 'LPA:1$smdp.io$activation-code',
          activationCode: 'activation-code',
          iccid: '8901000000000000001',
        },
        db: { id: 'esim-order-1' },
      };

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(mockMapping);

      // Mock the FiRoam addEsimOrder response
      mockAddEsimOrder.mockResolvedValue(mockFiRoamResult);

      await handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-USA-10GB' });

      expect(sendDeliveryEmail).not.toHaveBeenCalled();
    });
  });
});
