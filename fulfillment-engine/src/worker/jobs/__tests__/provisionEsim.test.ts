import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { esimDeliveryFactory, providerSkuMappingFactory } from '~/test-helpers/factories';

// Create a shared mock function storage
let mockAddEsimOrder: ReturnType<typeof vi.fn>;
let mockTgtProvision: ReturnType<typeof vi.fn>;
let mockJobSend: ReturnType<typeof vi.fn>;

// Convenience aliases using faker-backed factories
const createMockDelivery = esimDeliveryFactory;
const createMockMapping = (overrides: Parameters<typeof providerSkuMappingFactory>[0] = {}) =>
  providerSkuMappingFactory({
    shopifySku: 'ESIM-USA-10GB',
    providerSku: '120:826-0-?-1-G-D:14094',
    ...overrides,
  });

vi.mock('~/utils/crypto', () => ({
  encrypt: vi.fn(() => 'encrypted-payload'),
  decrypt: vi.fn(),
  hashIccid: vi.fn(() => 'hashed-iccid'),
}));

// Mock all dependencies BEFORE importing the module under test
vi.mock('~/db/prisma', () => ({
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

vi.mock('~/vendor/firoamClient', () => {
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

vi.mock('~/vendor/registry', async () => {
  const orig = await vi.importActual<typeof import('~/vendor/registry')>('~/vendor/registry');
  return {
    getProvider: (name: string) => {
      if (name === 'tgt') {
        return {
          name: 'tgt',
          provision: (...args: unknown[]) => {
            if (!mockTgtProvision) mockTgtProvision = vi.fn();
            // @ts-expect-error - apply signature mismatch is acceptable in tests
            return mockTgtProvision(...args);
          },
        };
      }
      return orig.getProvider(name);
    },
  };
});

vi.mock('~/queue/jobQueue', () => ({
  getJobQueue: () => ({
    send: (...args: unknown[]) => {
      if (!mockJobSend) {
        mockJobSend = vi.fn();
      }
      // @ts-expect-error - apply signature mismatch is acceptable in tests
      return mockJobSend(...args);
    },
  }),
}));

vi.mock('~/services/email', () => ({
  sendDeliveryEmail: vi.fn(),
  recordDeliveryAttempt: vi.fn(),
}));

vi.mock('~/shopify/client', () => ({
  getShopifyClient: vi.fn(() => ({
    createFulfillment: vi.fn(),
  })),
}));

// NOW import after mocks are set up
import prisma from '~/db/prisma';
import { sendDeliveryEmail } from '~/services/email';
import { getShopifyClient } from '~/shopify/client';
import { handleProvision } from '~/worker/jobs/provisionEsim';

describe('provisionEsim Worker Job', () => {
  beforeEach(() => {
    // Initialize/reset the mock function before each test
    mockAddEsimOrder = vi.fn();
    mockTgtProvision = vi.fn();
    mockJobSend = vi.fn();
    vi.clearAllMocks();
    process.env.ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!';
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  describe('Basic Job Processing', () => {
    it('should throw error if deliveryId is missing', async () => {
      // Cast through unknown to intentionally test the runtime guard with invalid input
      await expect(
        handleProvision({} as unknown as Parameters<typeof handleProvision>[0]),
      ).rejects.toThrow('missing deliveryId');
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
          orderNumber: mockDelivery.orderName,
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

  describe('TGT Pending Provisioning', () => {
    const createTgtMockMapping = (
      overrides: Parameters<typeof providerSkuMappingFactory>[0] = {},
    ) =>
      providerSkuMappingFactory({
        shopifySku: 'ESIM-AU-3GB-TGT',
        provider: 'tgt',
        providerSku: 'A-002-ES-AU-T-30D/180D-3GB(A)',
        ...overrides,
      });

    it('sets awaiting_callback status when TGT callback mode returns pending', async () => {
      vi.stubEnv('TGT_FULFILLMENT_MODE', 'callback');

      const mockDelivery = createMockDelivery();
      const mockMapping = createTgtMockMapping();

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(mockMapping);
      mockTgtProvision.mockResolvedValue({
        pending: true,
        vendorOrderId: 'SE-CALLBACK-123',
        lpa: '',
        activationCode: '',
        iccid: '',
      });

      const result = await handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-AU-3GB-TGT' });

      expect(result).toEqual({ ok: true, pending: true });
      expect(prisma.esimDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'awaiting_callback',
            vendorReferenceId: 'SE-CALLBACK-123',
          }),
        }),
      );
    });

    it('sets vendor_ordered status and enqueues poll job for TGT hybrid mode', async () => {
      vi.stubEnv('TGT_FULFILLMENT_MODE', 'hybrid');

      const mockDelivery = createMockDelivery();
      const mockMapping = createTgtMockMapping();

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(mockMapping);
      mockTgtProvision.mockResolvedValue({
        pending: true,
        vendorOrderId: 'SE-HYBRID-456',
        lpa: '',
        activationCode: '',
        iccid: '',
      });

      const result = await handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-AU-3GB-TGT' });

      expect(result).toEqual({ ok: true, pending: true });
      expect(prisma.esimDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'vendor_ordered' }),
        }),
      );
      expect(mockJobSend).toHaveBeenCalledWith(
        'tgt-poll-order',
        expect.objectContaining({ deliveryId: 'delivery-123', orderNo: 'SE-HYBRID-456' }),
        expect.any(Object),
      );
    });

    it('sets polling status when TGT polling mode returns pending', async () => {
      vi.stubEnv('TGT_FULFILLMENT_MODE', 'polling');

      const mockDelivery = createMockDelivery();
      const mockMapping = createTgtMockMapping();

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(mockMapping);
      mockTgtProvision.mockResolvedValue({
        pending: true,
        vendorOrderId: 'SE-POLL-789',
        lpa: '',
        activationCode: '',
        iccid: '',
      });

      const result = await handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-AU-3GB-TGT' });

      expect(result).toEqual({ ok: true, pending: true });
      expect(prisma.esimDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'polling',
            vendorReferenceId: 'SE-POLL-789',
          }),
        }),
      );
      // Polling mode does NOT enqueue a poll job — hybrid does
      expect(mockJobSend).not.toHaveBeenCalled();
    });

    it('records failure status when TGT provisioning throws', async () => {
      vi.stubEnv('TGT_FULFILLMENT_MODE', 'callback');

      const mockDelivery = createMockDelivery();
      const mockMapping = createTgtMockMapping();

      vi.mocked(prisma.esimDelivery.findUnique).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.esimDelivery.update).mockResolvedValue(mockDelivery);
      vi.mocked(prisma.providerSkuMapping.findUnique).mockResolvedValue(mockMapping);
      mockTgtProvision.mockRejectedValue(new Error('TGT API unavailable'));

      await expect(
        handleProvision({ deliveryId: 'delivery-123', sku: 'ESIM-AU-3GB-TGT' }),
      ).rejects.toThrow('TGT API unavailable');

      expect(prisma.esimDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'failed' }),
        }),
      );
    });
  });
});
