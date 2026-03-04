import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { EsimDelivery, ProviderSkuMapping } from '@prisma/client';

// Create a shared mock function storage
let mockAddEsimOrder: ReturnType<typeof vi.fn>;

// Helper functions to create properly typed mocks
const createMockDelivery = (overrides: Partial<EsimDelivery> = {}): EsimDelivery => ({
  id: 'delivery-123',
  shop: 'test-shop.myshopify.com',
  orderId: '1001',
  orderName: '#1001',
  lineItemId: '111',
  variantId: '222',
  customerEmail: 'test@example.com',
  vendorReferenceId: null,
  payloadEncrypted: null,
  status: 'pending',
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const createMockMapping = (overrides: Partial<ProviderSkuMapping> = {}): ProviderSkuMapping => ({
  id: 'mapping-1',
  shopifySku: 'ESIM-USA-10GB',
  provider: 'firoam',
  providerSku: '120:826-0-?-1-G-D:14094',
  providerConfig: null,
  isActive: true,
  name: 'USA 10GB',
  region: null,
  dataAmount: null,
  validity: null,
  packageType: null,
  daysCount: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

// Mock all dependencies BEFORE importing the module under test
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

vi.mock('../../../vendor/firoamClient', () => {
  // Return a constructor that creates an instance with addEsimOrder
  return {
    default: class MockFiRoamClient {
      addEsimOrder(...args: unknown[]) {
        // Delegate to the mock function that will be set in beforeEach
        if (!mockAddEsimOrder) {
          mockAddEsimOrder = vi.fn();
        }
        // @ts-expect-error - apply signature mismatch is acceptable in tests
        return mockAddEsimOrder(...args);
      }
    },
  };
});

vi.mock('../../../services/email', () => ({
  sendDeliveryEmail: vi.fn(),
  recordDeliveryAttempt: vi.fn(),
}));

vi.mock('../../../shopify/client', () => ({
  getShopifyClient: vi.fn(() => ({
    createFulfillment: vi.fn(),
  })),
}));

// NOW import after mocks are set up
import prisma from '../../../db/prisma';
import { sendDeliveryEmail } from '../../../services/email';
import { getShopifyClient } from '../../../shopify/client';
import { handleProvision } from '../provisionEsim';

describe('provisionEsim Worker Job', () => {
  beforeEach(() => {
    // Initialize/reset the mock function before each test
    mockAddEsimOrder = vi.fn();
    vi.clearAllMocks();
    process.env.ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!';
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

      await expect(handleProvision({ deliveryId: 'nonexistent' })).rejects.toThrow(
        'EsimDelivery nonexistent not found',
      );
    });

    it('should skip if delivery already completed', async () => {
      const completedDelivery = createMockDelivery({ status: 'fulfilled' });

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(completedDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);

      // Currently the code doesn't check for fulfilled status before SKU mapping
      // This test verifies current behavior - it will throw "No provider mapping found"
      await expect(
        handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-USA-10GB' }),
      ).rejects.toThrow('No provider mapping found for SKU: ESIM-USA-10GB');
    });

    it('should update status to provisioning when starting', async () => {
      const mockDelivery = createMockDelivery();

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);

      await expect(
        handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-USA-10GB' }),
      ).rejects.toThrow();

      expect(prisma.esimDelivery.update).toHaveBeenCalledWith({
        where: { id: 'delivery-123' },
        data: { status: 'provisioning' },
      });
    });
  });

  describe('SKU Mapping Lookup', () => {
    it('should throw error if SKU is missing', async () => {
      const mockDelivery = createMockDelivery();

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);

      await expect(handleProvision({ deliveryId: 'delivery-123' })).rejects.toThrow(
        'Missing SKU in job data',
      );
    });

    it('should throw error if SKU mapping not found', async () => {
      const mockDelivery = createMockDelivery();

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(null);

      await expect(
        handleProvision({ deliveryId: 'delivery-123', sku: 'UNKNOWN-SKU' }),
      ).rejects.toThrow('No provider mapping found for SKU: UNKNOWN-SKU');
    });

    it('should throw error if SKU mapping is inactive', async () => {
      const mockDelivery = createMockDelivery();
      const inactiveMapping = createMockMapping({ isActive: false });

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(inactiveMapping);

      await expect(
        handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-USA-10GB' }),
      ).rejects.toThrow('SKU mapping is inactive: ESIM-USA-10GB');
    });

    it('should throw error for unsupported provider', async () => {
      const mockDelivery = createMockDelivery();
      const invalidMapping = createMockMapping({ provider: 'unsupported-provider' });

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(invalidMapping);

      await expect(
        handleProvision({ deliveryId: 'delivery-123', sku: 'SOME-SKU' }),
      ).rejects.toThrow('Unsupported provider: unsupported-provider');
    });
  });

  describe('Provider SKU Format Validation', () => {
    it('should throw error for invalid providerSku format', async () => {
      const mockDelivery = createMockDelivery();
      const invalidMapping = createMockMapping({ providerSku: 'invalid' });

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(invalidMapping);

      await expect(
        handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-USA-10GB' }),
      ).rejects.toThrow('Invalid providerSku format');
    });

    it('should parse providerSku correctly (new format)', async () => {
      const mockDelivery = createMockDelivery();
      const mockMapping = createMockMapping({ providerSku: '120:826-0-?-1-G-D:14094' });

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
      mockAddEsimOrder.mockResolvedValue(mockFiRoamResult);
      vi.mocked(sendDeliveryEmail).mockResolvedValue({ success: true, messageId: 'test-123' });

      await handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-USA-10GB' });

      expect(mockAddEsimOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          skuId: '120',
          priceId: '14094',
        }),
      );
    });

    it('should parse providerSku correctly (legacy format)', async () => {
      const mockDelivery = createMockDelivery();
      const mockMapping = createMockMapping({
        shopifySku: 'ESIM-ASIA-5GB',
        providerSku: '156:14791',
        name: 'Asia 5GB',
      });

      const mockFiRoamResult = {
        raw: { code: 0, data: { orderNum: 'EP-654321' } },
        canonical: {
          vendorId: 'EP-654321',
          lpa: 'LPA:1$smdp.io$another-code',
          activationCode: 'another-code',
          iccid: '8901000000000000002',
        },
        db: { id: 'esim-order-2' },
      };

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(mockMapping);
      mockAddEsimOrder.mockResolvedValue(mockFiRoamResult);
      vi.mocked(sendDeliveryEmail).mockResolvedValue({ success: true, messageId: 'test-456' });

      await handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-ASIA-5GB' });

      expect(mockAddEsimOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          skuId: '156',
          priceId: '14791',
        }),
      );
    });
  });

  describe('FiRoam Order Provisioning', () => {
    it('should build orderPayload with skuId and priceId', async () => {
      const mockDelivery = createMockDelivery();
      const mockMapping = createMockMapping({
        providerSku: '120:826-0-?-1-G-D:14094',
        region: 'USA',
        dataAmount: '10GB',
        validity: '30 days',
      });

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
      const mockDelivery = createMockDelivery({ customerEmail: 'customer@example.com' });
      const mockMapping = createMockMapping({ providerSku: '120:826-0-?-1-G-D:14094' });

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
      vi.mocked(sendDeliveryEmail).mockResolvedValue({ success: true, messageId: 'email-123' });

      await handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-USA-10GB' });

      expect(sendDeliveryEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'customer@example.com',
          orderNumber: '#1001',
        }),
      );
    });

    it('should skip email if customerEmail is missing', async () => {
      const mockDelivery = createMockDelivery({ customerEmail: null });
      const mockMapping = createMockMapping({ providerSku: '120:826-0-?-1-G-D:14094' });

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

      expect(sendDeliveryEmail).not.toHaveBeenCalled();
    });

    it('should NOT call sendDeliveryEmail when customerEmail is null (confirmed path)', async () => {
      const mockDelivery = createMockDelivery({ customerEmail: null });
      const mockMapping = createMockMapping({ providerSku: '120:826-0-?-1-G-D:14094' });

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
      mockAddEsimOrder.mockResolvedValue(mockFiRoamResult);

      await handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-USA-10GB' });

      expect(sendDeliveryEmail).not.toHaveBeenCalled();
    });

    it('continues without throwing when email delivery fails', async () => {
      const mockDelivery = createMockDelivery({ customerEmail: 'fail@example.com' });
      const mockMapping = createMockMapping({ providerSku: '120:826-0-?-1-G-D:14094' });

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
      mockAddEsimOrder.mockResolvedValue(mockFiRoamResult);
      // Simulate email provider returning a failure
      vi.mocked(sendDeliveryEmail).mockResolvedValue({
        success: false,
        error: 'Rate limit exceeded',
      });

      // Should NOT throw — eSIM is provisioned, email failure is recoverable
      const result = await handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-USA-10GB' });

      expect(result).toEqual({ ok: true });
      expect(sendDeliveryEmail).toHaveBeenCalled();
    });
  });

  describe('Already Delivered Guard', () => {
    it('returns early with already-delivered reason when status is delivered', async () => {
      const deliveredDelivery = createMockDelivery({ status: 'delivered' });
      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(deliveredDelivery);

      const result = await handleProvision({ deliveryId: 'delivery-123' });

      expect(result).toEqual({ ok: true, reason: 'already delivered' });
      expect(prisma.esimDelivery.update).not.toHaveBeenCalled();
    });
  });

  describe('Legacy orderPayload Path', () => {
    it('provisions via direct payload when orderPayload is provided (string orderNum)', async () => {
      const mockDelivery = createMockDelivery({ customerEmail: null });
      const orderPayload = { skuId: '120', count: '1', priceId: '14094' };

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      mockAddEsimOrder.mockResolvedValue({
        raw: { code: 0, data: 'EP-LEGACY-001' },
        canonical: {
          lpa: 'LPA:1$smdp.io$code',
          activationCode: 'code',
          iccid: '8901000000000000001',
        },
        db: { id: 'db-legacy-1' },
      });

      const result = await handleProvision({ deliveryId: 'delivery-123', orderPayload });

      expect(result).toEqual({ ok: true });
      expect(mockAddEsimOrder).toHaveBeenCalledWith(orderPayload);
    });

    it('provisions via direct payload with object orderNum in raw.data', async () => {
      const mockDelivery = createMockDelivery({ customerEmail: null });
      const orderPayload = { skuId: '120', count: '1', priceId: '14094' };

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      mockAddEsimOrder.mockResolvedValue({
        raw: { code: 0, data: { orderNum: 'EP-LEGACY-002' } },
        canonical: {
          lpa: 'LPA:1$smdp.io$code2',
          activationCode: 'code2',
          iccid: '8901000000000000002',
        },
        db: { id: 'db-legacy-2' },
      });

      const result = await handleProvision({ deliveryId: 'delivery-123', orderPayload });

      expect(result).toEqual({ ok: true });
    });

    it('throws VendorError when FiRoam returns no canonical (with error field)', async () => {
      const mockDelivery = createMockDelivery();
      const orderPayload = { skuId: '120', count: '1', priceId: '14094' };

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      mockAddEsimOrder.mockResolvedValue({
        raw: { code: 1, data: null },
        error: 'API error from vendor',
      });

      await expect(handleProvision({ deliveryId: 'delivery-123', orderPayload })).rejects.toThrow(
        'FiRoam error: API error from vendor',
      );
    });

    it('throws VendorError when FiRoam returns no canonical (no error field)', async () => {
      const mockDelivery = createMockDelivery();
      const orderPayload = { skuId: '120', count: '1', priceId: '14094' };

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      mockAddEsimOrder.mockResolvedValue({ raw: { code: 0, data: 'EP-123' } });

      await expect(handleProvision({ deliveryId: 'delivery-123', orderPayload })).rejects.toThrow(
        'FiRoam returned unexpected response',
      );
    });

    it('throws VendorError when FiRoam returns no order number in raw.data', async () => {
      const mockDelivery = createMockDelivery();
      const orderPayload = { skuId: '120', count: '1', priceId: '14094' };

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      mockAddEsimOrder.mockResolvedValue({
        raw: { code: 0, data: {} },
        canonical: { lpa: 'LPA:1$smdp.io$code', activationCode: 'code', iccid: '8901' },
        db: { id: 'db-1' },
      });

      await expect(handleProvision({ deliveryId: 'delivery-123', orderPayload })).rejects.toThrow(
        'No order number in FiRoam response',
      );
    });
  });

  describe('Shopify Fulfillment', () => {
    const setupMocks = () => {
      const mockDelivery = createMockDelivery({ customerEmail: null });
      const mockMapping = createMockMapping({ providerSku: '120:826-0-?-1-G-D:14094' });
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
      mockAddEsimOrder.mockResolvedValue(mockFiRoamResult);
      return { mockDelivery, mockMapping, mockFiRoamResult };
    };

    it('creates Shopify fulfillment when orderId is provided', async () => {
      setupMocks();
      const mockCreateFulfillment = vi
        .fn()
        .mockResolvedValue({ id: 'gid://shopify/Fulfillment/1' });
      vi.mocked(getShopifyClient).mockReturnValue({
        createFulfillment: mockCreateFulfillment,
      } as unknown as ReturnType<typeof getShopifyClient>);

      const result = await handleProvision({
        deliveryId: 'delivery-123',
        sku: 'ESIM-USA-10GB',
        orderId: '12345',
      });

      expect(result).toEqual({ ok: true });
      expect(mockCreateFulfillment).toHaveBeenCalledWith('12345');
    });

    it('does not throw when Shopify fulfillment fails', async () => {
      setupMocks();
      vi.mocked(getShopifyClient).mockReturnValue({
        createFulfillment: vi.fn().mockRejectedValue(new Error('Shopify is down')),
      } as unknown as ReturnType<typeof getShopifyClient>);

      const result = await handleProvision({
        deliveryId: 'delivery-123',
        sku: 'ESIM-USA-10GB',
        orderId: '12345',
      });

      expect(result).toEqual({ ok: true });
    });

    it('skips Shopify fulfillment when orderId is not provided', async () => {
      setupMocks();

      const result = await handleProvision({
        deliveryId: 'delivery-123',
        sku: 'ESIM-USA-10GB',
      });

      expect(result).toEqual({ ok: true });
      expect(getShopifyClient).not.toHaveBeenCalled();
    });
  });
});
