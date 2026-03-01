import { describe, it, expect, beforeEach, vi } from 'vitest';
import nock from 'nock';
import type { EsimOrder } from '@prisma/client';
import FiRoamClient from '../vendor/firoamClient';
import prisma from '../db/prisma';

// Mock Prisma - must match the import path in firoamClient.ts
vi.mock('../db/prisma', () => {
  const mockCreate = vi.fn().mockResolvedValue({ id: 'mock-db-id' });
  return {
    default: {
      esimOrder: {
        create: mockCreate,
      },
    },
  };
});

describe('FiRoamClient component test (mocked by default)', () => {
  const base = process.env.FIROAM_BASE_URL || 'https://bpm.roamwifi.hk';
  // signKey present in env; not used directly in the test

  beforeEach(() => {
    nock.cleanAll();
    vi.clearAllMocks();
    // Reset the mock implementation
    vi.mocked(prisma.esimOrder.create).mockResolvedValue({
      id: 'mock-db-id',
    } as Partial<EsimOrder> as EsimOrder);
    // Ensure ENCRYPTION_KEY is set before any tests run
    process.env.ENCRYPTION_KEY =
      process.env.ENCRYPTION_KEY || 'test-encryption-key-should-be-32-bytes!';
  });

  it('should login, place order and return canonical payload (mock)', async () => {
    // Ensure credentials are set for login flow (we mock network responses)
    process.env.FIROAM_PHONE = process.env.FIROAM_PHONE || 'mock-phone';
    process.env.FIROAM_PASSWORD = process.env.FIROAM_PASSWORD || 'mock-pass';

    // Mock login (uses GET per Python example in FiRoam docs)
    nock(base)
      .get('/api_order/login')
      .query(true)
      .reply(200, { code: 1, data: { token: 'mock-token' } });

    // Mock addEsimOrder -> returns orderNum
    nock(base)
      .post('/api_esim/addEsimOrder')
      .reply(200, { code: 0, data: { orderNum: 'EP-MOCK-1' } });

    // Mock getOrderInfo -> returns card info with proper field names
    // Note: This is called automatically by addEsimOrder in two-step flow
    nock(base)
      .post('/api_esim/getOrderInfo')
      .reply(200, {
        code: 0,
        data: {
          cards: [
            {
              lpa: 'lpa-mock',
              activation_code: 'ACT-MOCK',
              iccid: '8901000000000000001',
            },
          ],
        },
      });

    const client = new FiRoamClient();
    const result = await client.addEsimOrder({
      skuId: '156',
      priceId: '100',
      count: '1',
      otherOrderId: 'external-1',
    });

    // Debug: Check for any nock errors
    if (!nock.isDone()) {
      console.log('Pending mocks:', nock.pendingMocks());
    }
    if (result.error) {
      console.log('Error in result:', result.error);
    }

    // Verify the raw response
    expect(result.raw).toBeDefined();
    expect(result.raw.code).toBe(0);
    expect((result.raw.data as Record<string, unknown>).orderNum).toBe('EP-MOCK-1');

    // Verify the canonical payload
    expect(result.canonical).toBeDefined();
    expect(result.canonical?.vendorId).toBe('EP-MOCK-1');
    expect(result.canonical?.lpa).toBe('lpa-mock');
    expect(result.canonical?.activationCode).toBe('ACT-MOCK');
    expect(result.canonical?.iccid).toBe('8901000000000000001');

    // Verify db record was created
    expect(result.db).toBeDefined();
    expect(result.db?.id).toBe('mock-db-id');
  });

  it('should query eSIM order and return usage data (mock)', async () => {
    // Ensure credentials are set
    process.env.FIROAM_PHONE = process.env.FIROAM_PHONE || 'mock-phone';
    process.env.FIROAM_PASSWORD = process.env.FIROAM_PASSWORD || 'mock-pass';

    // Mock login
    nock(base)
      .get('/api_order/login')
      .query(true)
      .reply(200, { code: 1, data: { token: 'mock-token' } });

    // Mock queryEsimOrder response with usage data
    nock(base)
      .post('/api_esim/queryEsimOrder')
      .reply(200, {
        code: 0,
        message: 'success',
        data: {
          total: 1,
          page: 1,
          rows: [
            {
              orderNum: 'EP20241224002723',
              skuId: 114,
              skuName: 'Turkey',
              type: 1,
              daypassDay: 3,
              count: 1,
              createTime: '2024-12-24 17:30:14.0',
              status: 0,
              totle: '2.27',
              packageList: [
                {
                  id: 12345,
                  flows: 5,
                  unit: 'GB',
                  days: 7,
                  usedMb: 512.5,
                  name: 'Turkey 5GB 7Days',
                  beginDate: '2024-12-24',
                  endDate: '2024-12-31',
                  status: 1,
                  iccid: '8901000000000000001',
                  priceId: 100,
                },
              ],
            },
          ],
        },
      });

    const client = new FiRoamClient();
    const result = await client.queryEsimOrder({ iccid: '8901000000000000001' });

    // Verify response structure
    expect(result.success).toBe(true);
    expect(result.orders).toBeDefined();
    expect(result.orders?.length).toBe(1);

    // Verify order data
    const order = result.orders?.[0];
    expect(order?.orderNum).toBe('EP20241224002723');
    expect(order?.skuName).toBe('Turkey');

    // Verify package data with usage
    expect(order?.packages).toBeDefined();
    expect(order?.packages.length).toBe(1);

    const pkg = order?.packages[0];
    expect(pkg?.iccid).toBe('8901000000000000001');
    expect(pkg?.flows).toBe(5);
    expect(pkg?.unit).toBe('GB');
    expect(pkg?.usedMb).toBe(512.5);
    expect(pkg?.days).toBe(7);
    expect(pkg?.status).toBe(1);
  });

  it('should handle queryEsimOrder failure gracefully', async () => {
    // Ensure credentials are set
    process.env.FIROAM_PHONE = process.env.FIROAM_PHONE || 'mock-phone';
    process.env.FIROAM_PASSWORD = process.env.FIROAM_PASSWORD || 'mock-pass';

    // Mock login
    nock(base)
      .get('/api_order/login')
      .query(true)
      .reply(200, { code: 1, data: { token: 'mock-token' } });

    // Mock failed query
    nock(base).post('/api_esim/queryEsimOrder').reply(200, {
      code: -1,
      message: 'Order not found',
    });

    const client = new FiRoamClient();
    const result = await client.queryEsimOrder({ orderNum: 'INVALID' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
