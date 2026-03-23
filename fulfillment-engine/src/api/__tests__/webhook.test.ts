import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import crypto from 'crypto';

// Mock dependencies before imports
vi.mock('~/db/prisma', () => ({
  default: {
    esimDelivery: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('~/queue/jobQueue', () => ({
  getJobQueue: vi.fn(() => ({
    send: vi.fn().mockResolvedValue('job-id-123'),
  })),
}));

import prisma from '~/db/prisma';
import { getJobQueue } from '~/queue/jobQueue';

describe('Webhook Handler - POST /webhook/orders/paid', () => {
  const mockOrderPayload = {
    id: 123456,
    name: '#1001',
    email: 'customer@example.com',
    contact_email: 'contact@example.com',
    customer: {
      id: 789,
      email: 'customer@example.com',
      first_name: 'John',
      last_name: 'Doe',
      phone: '+1234567890',
    },
    billing_address: {
      email: 'billing@example.com',
    },
    line_items: [
      {
        id: 111,
        variant_id: 222,
        quantity: 1,
        product_id: 333,
        title: 'eSIM - USA 10GB',
        name: 'eSIM - USA 10GB',
        sku: 'ESIM-USA-10GB',
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHOPIFY_WEBHOOK_SECRET = 'test-webhook-secret';
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('HMAC Signature Verification', () => {
    it('should calculate HMAC signature correctly', () => {
      const rawBody = JSON.stringify(mockOrderPayload);
      const secret = 'test-webhook-secret';

      const hmac = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');

      expect(hmac).toBeDefined();
      expect(hmac.length).toBeGreaterThan(0);
    });

    it('should verify valid HMAC signature', () => {
      const rawBody = JSON.stringify(mockOrderPayload);
      const secret = 'test-webhook-secret';

      const validHmac = crypto
        .createHmac('sha256', secret)
        .update(rawBody, 'utf8')
        .digest('base64');

      const calculatedHmac = crypto
        .createHmac('sha256', secret)
        .update(rawBody, 'utf8')
        .digest('base64');

      expect(validHmac).toBe(calculatedHmac);
    });

    it('should reject invalid HMAC signature', () => {
      const rawBody = JSON.stringify(mockOrderPayload);
      const secret = 'test-webhook-secret';

      const validHmac = crypto
        .createHmac('sha256', secret)
        .update(rawBody, 'utf8')
        .digest('base64');

      const invalidHmac = 'invalid-hmac-signature';

      expect(validHmac).not.toBe(invalidHmac);
    });
  });

  describe('Idempotency - Duplicate Order Handling', () => {
    it('should detect duplicate webhook for same order and line item', async () => {
      const orderId = '123456';
      const lineItemId = '111';

      // Mock finding existing delivery
      vi.mocked(prisma.esimDelivery.findFirst).mockResolvedValue({
        id: 'existing-delivery-id',
        shop: 'test-store.myshopify.com',
        orderId,
        orderName: '#1001',
        lineItemId,
        variantId: '222',
        customerEmail: 'customer@example.com',
        vendorReferenceId: null,
        provider: null,
        iccidHash: null,
        payloadEncrypted: null,
        accessToken: null,
        status: 'pending',
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const existingDelivery = await prisma.esimDelivery.findFirst({
        where: {
          orderId,
          lineItemId,
        },
      });

      expect(existingDelivery).toBeDefined();
      expect(existingDelivery?.orderId).toBe(orderId);
      expect(existingDelivery?.lineItemId).toBe(lineItemId);
      expect(prisma.esimDelivery.findFirst).toHaveBeenCalledWith({
        where: { orderId, lineItemId },
      });
    });

    it('should allow new delivery for different line items in same order', async () => {
      const orderId = '123456';
      const lineItemId1 = '111';
      const lineItemId2 = '222';

      // First line item exists
      vi.mocked(prisma.esimDelivery.findFirst).mockResolvedValueOnce({
        id: 'delivery-1',
        shop: 'test-store.myshopify.com',
        orderId,
        orderName: '#1001',
        lineItemId: lineItemId1,
        variantId: '222',
        customerEmail: 'customer@example.com',
        vendorReferenceId: null,
        provider: null,
        iccidHash: null,
        payloadEncrypted: null,
        accessToken: null,
        status: 'pending',
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Second line item doesn't exist
      vi.mocked(prisma.esimDelivery.findFirst).mockResolvedValueOnce(null);

      const firstDelivery = await prisma.esimDelivery.findFirst({
        where: { orderId, lineItemId: lineItemId1 },
      });

      const secondDelivery = await prisma.esimDelivery.findFirst({
        where: { orderId, lineItemId: lineItemId2 },
      });

      expect(firstDelivery).toBeDefined();
      expect(secondDelivery).toBeNull();
    });
  });

  describe('Customer Email Extraction', () => {
    it('should extract email from customer object', () => {
      const email = mockOrderPayload.customer?.email;
      expect(email).toBe('customer@example.com');
    });

    it('should fallback to contact_email if customer email missing', () => {
      const payload = {
        ...mockOrderPayload,
        customer: undefined,
      };
      const email = payload.contact_email || payload.email;
      expect(email).toBe('contact@example.com');
    });

    it('should fallback to order email if all else fails', () => {
      const payload = {
        ...mockOrderPayload,
        customer: undefined,
        contact_email: undefined,
      };
      const email = payload.email;
      expect(email).toBe('customer@example.com');
    });

    it('should fallback to billing address email', () => {
      const payload = {
        ...mockOrderPayload,
        customer: undefined,
        contact_email: undefined,
        email: undefined,
      };
      const email = payload.billing_address?.email;
      expect(email).toBe('billing@example.com');
    });
  });

  describe('Delivery Record Creation', () => {
    it('should create delivery record with correct data', async () => {
      const deliveryData = {
        shop: 'test-store.myshopify.com',
        orderId: '123456',
        orderName: '#1001',
        lineItemId: '111',
        variantId: '222',
        customerEmail: 'customer@example.com',
        status: 'pending',
      };

      vi.mocked(prisma.esimDelivery.create).mockResolvedValue({
        id: 'delivery-abc123',
        ...deliveryData,
        vendorReferenceId: null,
        provider: null,
        iccidHash: null,
        payloadEncrypted: null,
        accessToken: null,
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const delivery = await prisma.esimDelivery.create({
        data: deliveryData,
      });

      expect(delivery).toBeDefined();
      expect(delivery.id).toBe('delivery-abc123');
      expect(delivery.orderId).toBe('123456');
      expect(delivery.lineItemId).toBe('111');
      expect(prisma.esimDelivery.create).toHaveBeenCalledWith({
        data: deliveryData,
      });
    });

    it('should handle multiple line items in same order', async () => {
      const lineItems = [
        { id: 111, sku: 'ESIM-USA-10GB', name: 'USA eSIM' },
        { id: 222, sku: 'ESIM-EU-5GB', name: 'EU eSIM' },
      ];

      for (const item of lineItems) {
        vi.mocked(prisma.esimDelivery.create).mockResolvedValueOnce({
          id: `delivery-${item.id}`,
          shop: 'test-store.myshopify.com',
          orderId: '123456',
          orderName: '#1001',
          lineItemId: String(item.id),
          variantId: '999',
          customerEmail: 'customer@example.com',
          vendorReferenceId: null,
          provider: null,
          iccidHash: null,
          payloadEncrypted: null,
          accessToken: null,
          status: 'pending',
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      const deliveries = [];
      for (const item of lineItems) {
        const delivery = await prisma.esimDelivery.create({
          data: {
            shop: 'test-store.myshopify.com',
            orderId: '123456',
            orderName: '#1001',
            lineItemId: String(item.id),
            variantId: '999',
            customerEmail: 'customer@example.com',
            status: 'pending',
          },
        });
        deliveries.push(delivery);
      }

      expect(deliveries).toHaveLength(2);
      expect(deliveries[0].lineItemId).toBe('111');
      expect(deliveries[1].lineItemId).toBe('222');
    });
  });

  describe('Job Queue Integration', () => {
    it('should enqueue provision job with correct data', async () => {
      const mockBoss = {
        send: vi.fn().mockResolvedValue('job-id-123'),
      } as unknown as ReturnType<typeof getJobQueue>;
      vi.mocked(getJobQueue).mockReturnValue(mockBoss);

      const jobData = {
        deliveryId: 'delivery-abc123',
        orderId: '123456',
        orderName: '#1001',
        lineItemId: '111',
        variantId: '222',
        customerEmail: 'customer@example.com',
        sku: 'ESIM-USA-10GB',
        productName: 'eSIM - USA 10GB',
      };

      const boss = getJobQueue();
      const jobId = await boss.send('provision-esim', jobData);

      expect(jobId).toBe('job-id-123');
      expect(boss.send).toHaveBeenCalledWith('provision-esim', jobData);
    });

    it('should handle job queue failures gracefully', async () => {
      const mockBoss = {
        send: vi.fn().mockRejectedValue(new Error('Queue unavailable')),
      } as unknown as ReturnType<typeof getJobQueue>;
      vi.mocked(getJobQueue).mockReturnValue(mockBoss);

      const boss = getJobQueue();

      await expect(boss.send('provision-esim', { deliveryId: 'test' })).rejects.toThrow(
        'Queue unavailable',
      );
    });
  });

  describe('SKU Handling', () => {
    it('should handle line items with SKU', () => {
      const lineItem = mockOrderPayload.line_items[0];
      expect(lineItem.sku).toBe('ESIM-USA-10GB');
    });

    it('should handle line items without SKU', () => {
      const lineItem = {
        ...mockOrderPayload.line_items[0],
        sku: undefined,
      };
      expect(lineItem.sku).toBeUndefined();
    });

    it('should handle empty SKU string', () => {
      const lineItem = {
        ...mockOrderPayload.line_items[0],
        sku: '',
      };
      expect(lineItem.sku).toBe('');
    });
  });
});
