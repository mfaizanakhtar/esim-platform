import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nock from 'nock';
import type { EsimOrder } from '@prisma/client';

// ---------------------------------------------------------------------------
// Mock dependencies before importing the module under test
// ---------------------------------------------------------------------------
vi.mock('../../db/prisma', () => ({
  default: {
    esimOrder: {
      create: vi.fn(),
    },
  },
}));

import FiRoamClient from '../firoamClient';
import prisma from '../../db/prisma';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BASE_URL = 'https://bpm.roamwifi.hk';

const VALID_ORDER_PAYLOAD = { skuId: '120', count: '1', priceId: '14094' };

const CARD_WITH_ALL_FIELDS = {
  code: 'LPA:1$smdp.io$activation-code',
  activationCode: 'activation-code',
  iccid: '8901000000000000001',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mockLogin(token = 'test-token-xyz') {
  return nock(BASE_URL).get('/api_order/login').query(true).reply(200, {
    code: 0,
    data: { token },
  });
}

function mockApiPost(path: string, response: object) {
  return nock(BASE_URL).post(path).reply(200, response);
}

function makeMockDbOrder(overrides: Partial<EsimOrder> = {}): EsimOrder {
  return {
    id: 'db-order-1',
    vendorReferenceId: 'EP-001',
    payloadJson: {},
    payloadEncrypted: 'encrypted-payload',
    status: 'created',
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
  nock.cleanAll();
  vi.clearAllMocks();
  process.env.FIROAM_BASE_URL = BASE_URL;
  process.env.FIROAM_PHONE = 'test-phone';
  process.env.FIROAM_PASSWORD = 'test-password';
  process.env.FIROAM_SIGN_KEY = 'test-sign-key-1234567890abcdef';
  process.env.ENCRYPTION_KEY = 'test-encryption-key-32-bytes!!!';
});

afterEach(() => {
  nock.cleanAll();
});

// ---------------------------------------------------------------------------
// loginIfNeeded
// ---------------------------------------------------------------------------
describe('loginIfNeeded', () => {
  it('logs in and returns token on first call', async () => {
    const loginScope = mockLogin('fresh-token');
    mockApiPost('/api_esim/getOrderInfo', { code: 0, data: {} });

    const client = new FiRoamClient();
    await client.getOrderInfo('EP-001');

    expect(loginScope.isDone()).toBe(true);
  });

  it('reuses cached token within the validity window', async () => {
    // Login is mocked only once — second getOrderInfo call should reuse token
    mockLogin('cached-token');
    mockApiPost('/api_esim/getOrderInfo', { code: 0, data: {} });
    mockApiPost('/api_esim/getOrderInfo', { code: 0, data: {} });

    const client = new FiRoamClient();
    await client.getOrderInfo('EP-001');
    await client.getOrderInfo('EP-002');

    // If the second call tried to login again, nock would throw since login only intercepted once
    expect(nock.pendingMocks()).not.toContain(`GET ${BASE_URL}/api_order/login`);
  });

  it('throws VendorError when login API returns no token', async () => {
    nock(BASE_URL).get('/api_order/login').query(true).reply(200, { code: 1, data: null });

    const client = new FiRoamClient();
    await expect(client.getOrderInfo('EP-001')).rejects.toThrow('FiRoam login failed');
  });

  it('throws VendorError when login returns empty data', async () => {
    nock(BASE_URL).get('/api_order/login').query(true).reply(200, null);

    const client = new FiRoamClient();
    await expect(client.getOrderInfo('EP-001')).rejects.toThrow('FiRoam login failed');
  });

  it('throws MappingError when FIROAM_PHONE is not set', async () => {
    delete process.env.FIROAM_PHONE;
    delete process.env.FIROAM_PASSWORD;

    const client = new FiRoamClient();
    await expect(client.getOrderInfo('EP-001')).rejects.toThrow(
      'FIROAM_PHONE/FIROAM_PASSWORD not set',
    );
  });
});

// ---------------------------------------------------------------------------
// post: token expiry auto-retry
// ---------------------------------------------------------------------------
describe('post: token expiry retry', () => {
  it('retries with a fresh token when the API returns token-expired error', async () => {
    // Initial login
    mockLogin('old-token');

    // First attempt: token expired response
    nock(BASE_URL).post('/api_esim/getOrderInfo').once().reply(200, {
      code: '-1',
      message: 'token expire',
    });

    // Re-login with fresh token
    mockLogin('new-token');

    // Retry succeeds
    mockApiPost('/api_esim/getOrderInfo', { code: 0, data: { orderNum: 'EP-001' } });

    const client = new FiRoamClient();
    const result = await client.getOrderInfo('EP-001');

    expect(result).toMatchObject({ code: 0 });
  });

  it('does NOT retry a second time if the refresh also returns expired', async () => {
    mockLogin('old-token');
    // First attempt: token expired
    nock(BASE_URL).post('/api_esim/getOrderInfo').once().reply(200, {
      code: '-1',
      message: 'token expire',
    });
    // Re-login
    mockLogin('new-token');
    // Retry: token expired again → stop retrying, return the error response
    nock(BASE_URL).post('/api_esim/getOrderInfo').once().reply(200, {
      code: '-1',
      message: 'token expire',
    });

    const client = new FiRoamClient();
    const result = await client.getOrderInfo('EP-001');
    // Returns the second error response without throwing
    expect(result).toMatchObject({ code: '-1' });
  });
});

// ---------------------------------------------------------------------------
// addEsimOrder
// ---------------------------------------------------------------------------
describe('addEsimOrder', () => {
  it('throws ZodError when payload is invalid', async () => {
    const client = new FiRoamClient();
    // Missing required `skuId` and `count` fields
    await expect(client.addEsimOrder({ invalid: true })).rejects.toThrow();
  });

  it('returns { raw } when API returns an error response', async () => {
    mockLogin();
    mockApiPost('/api_esim/addEsimOrder', { code: 1, message: 'Insufficient balance' });

    const client = new FiRoamClient();
    const result = await client.addEsimOrder(VALID_ORDER_PAYLOAD);

    expect(result).toMatchObject({ raw: { code: 1, message: 'Insufficient balance' } });
    expect('canonical' in result).toBe(false);
  });

  it('returns { raw } when API returns null orderNum', async () => {
    mockLogin();
    mockApiPost('/api_esim/addEsimOrder', { code: 0, data: null });

    const client = new FiRoamClient();
    const result = await client.addEsimOrder(VALID_ORDER_PAYLOAD);

    expect(result).toMatchObject({ raw: { code: 0 } });
    expect('canonical' in result).toBe(false);
  });

  it('succeeds with one-step flow (backInfo=1, cardApiDtoList present)', async () => {
    mockLogin();
    vi.mocked(prisma.esimOrder.create).mockResolvedValue(makeMockDbOrder());

    mockApiPost('/api_esim/addEsimOrder', {
      code: 0,
      data: {
        orderNum: 'EP-ONESTEP-001',
        cardApiDtoList: [CARD_WITH_ALL_FIELDS],
      },
    });

    const client = new FiRoamClient();
    const result = await client.addEsimOrder(VALID_ORDER_PAYLOAD);

    expect(result).toMatchObject({
      canonical: expect.objectContaining({
        lpa: 'LPA:1$smdp.io$activation-code',
        activationCode: 'activation-code',
        iccid: '8901000000000000001',
      }),
      db: { id: 'db-order-1' },
    });
    expect(prisma.esimOrder.create).toHaveBeenCalledTimes(1);
  });

  it('succeeds with two-step flow (string orderNum, then getOrderInfo)', async () => {
    mockLogin();
    vi.mocked(prisma.esimOrder.create).mockResolvedValue(makeMockDbOrder({ id: 'db-order-2' }));

    // Step 1: addEsimOrder returns plain string orderNum
    mockApiPost('/api_esim/addEsimOrder', { code: 0, data: 'EP-TWOSTEP-001' });

    // Step 2: getOrderInfo returns full card details
    mockApiPost('/api_esim/getOrderInfo', {
      code: 0,
      data: {
        orderNum: 'EP-TWOSTEP-001',
        cardApiDtoList: [
          {
            lpa: 'LPA:1$smdp.io$two-step-code',
            activationCode: 'two-step-code',
            iccid: '8901000000000000002',
          },
        ],
      },
    });

    const client = new FiRoamClient();
    const result = await client.addEsimOrder(VALID_ORDER_PAYLOAD);

    expect(result).toMatchObject({
      canonical: expect.objectContaining({
        lpa: 'LPA:1$smdp.io$two-step-code',
        activationCode: 'two-step-code',
      }),
      db: { id: 'db-order-2' },
    });
  });

  it('uses `cards` field when cardApiDtoList is absent (two-step flow)', async () => {
    mockLogin();
    vi.mocked(prisma.esimOrder.create).mockResolvedValue(makeMockDbOrder());

    // Step 1: addEsimOrder returns plain string orderNum (triggers two-step flow)
    mockApiPost('/api_esim/addEsimOrder', { code: 0, data: 'EP-CARDS-001' });

    // Step 2: getOrderInfo returns response with `cards` instead of `cardApiDtoList`
    mockApiPost('/api_esim/getOrderInfo', {
      code: 0,
      data: {
        orderNum: 'EP-CARDS-001',
        cards: [
          {
            lpaString: 'LPA:1$smdp.io$cards-variant',
            activation_code: 'cards-code',
            mobileNumber: '8901000000000000099',
          },
        ],
      },
    });

    const client = new FiRoamClient();
    const result = await client.addEsimOrder(VALID_ORDER_PAYLOAD);

    expect(result).toMatchObject({
      canonical: expect.objectContaining({
        lpa: 'LPA:1$smdp.io$cards-variant',
        activationCode: 'cards-code',
        iccid: '8901000000000000099',
      }),
    });
  });

  it('returns { raw, canonical: undefined, error } when fetchOrderDetails throws', async () => {
    mockLogin();

    // addEsimOrder returns orderNum (two-step flow)
    mockApiPost('/api_esim/addEsimOrder', { code: 0, data: 'EP-ERR-001' });

    // getOrderInfo fails with a network error
    nock(BASE_URL).post('/api_esim/getOrderInfo').replyWithError('Network timeout');

    const client = new FiRoamClient();
    const result = await client.addEsimOrder(VALID_ORDER_PAYLOAD);

    expect(result).toMatchObject({ raw: { code: 0 } });
    expect(result.canonical).toBeUndefined();
    expect('error' in result).toBe(true);
  });

  it('persists order to database and encrypts payload', async () => {
    mockLogin();
    vi.mocked(prisma.esimOrder.create).mockResolvedValue(makeMockDbOrder());

    mockApiPost('/api_esim/addEsimOrder', {
      code: 0,
      data: {
        orderNum: 'EP-DB-001',
        cardApiDtoList: [CARD_WITH_ALL_FIELDS],
      },
    });

    const client = new FiRoamClient();
    await client.addEsimOrder(VALID_ORDER_PAYLOAD);

    expect(prisma.esimOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          vendorReferenceId: 'EP-DB-001',
          status: 'created',
          payloadEncrypted: expect.any(String),
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// getOrderInfo
// ---------------------------------------------------------------------------
describe('getOrderInfo', () => {
  it('returns the raw API response', async () => {
    mockLogin();
    mockApiPost('/api_esim/getOrderInfo', {
      code: 0,
      data: { orderNum: 'EP-001', status: 'active' },
    });

    const client = new FiRoamClient();
    const result = await client.getOrderInfo('EP-001');

    expect(result).toMatchObject({ code: 0, data: { orderNum: 'EP-001' } });
  });
});

// ---------------------------------------------------------------------------
// getSkus
// ---------------------------------------------------------------------------
describe('getSkus', () => {
  it('returns { raw, skus } when API succeeds and data passes Zod validation', async () => {
    mockLogin();
    mockApiPost('/api_esim/getSkus', {
      code: 0,
      data: [
        { skuid: 120, display: 'USA', countryCode: 'US' },
        { skuid: 156, display: 'China', countryCode: 'CN' },
      ],
    });

    const client = new FiRoamClient();
    const result = await client.getSkus();

    expect(result).toMatchObject({
      skus: [
        { skuid: 120, display: 'USA', countryCode: 'US' },
        { skuid: 156, display: 'China', countryCode: 'CN' },
      ],
    });
  });

  it('returns { raw } when API returns an error response', async () => {
    mockLogin();
    mockApiPost('/api_esim/getSkus', { code: 1, message: 'Unauthorized' });

    const client = new FiRoamClient();
    const result = await client.getSkus();

    expect('skus' in result).toBe(false);
    expect(result.raw).toMatchObject({ code: 1 });
  });

  it('returns { raw, error } when response data fails Zod validation', async () => {
    mockLogin();
    // Data is a string instead of an array — Zod will reject this
    mockApiPost('/api_esim/getSkus', { code: 0, data: 'not-an-array' });

    const client = new FiRoamClient();
    const result = await client.getSkus();

    expect('error' in result).toBe(true);
    expect('skus' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getSkuByGroup
// ---------------------------------------------------------------------------
describe('getSkuByGroup', () => {
  it('returns { raw, grouped } when API succeeds with valid data', async () => {
    mockLogin();
    mockApiPost('/api_esim/getSkuByGroup', {
      code: 0,
      data: {
        continent: ['NA', 'EU'],
        data: {
          NA: [
            {
              skuid: 120,
              countryCode: 1,
              imageUrl: 'https://example.com/us.png',
              display: 'USA',
              note: '',
              search: 'usa united states',
              continentCode: 1,
            },
          ],
          EU: [],
        },
      },
    });

    const client = new FiRoamClient();
    const result = await client.getSkuByGroup();

    expect(result).toMatchObject({
      grouped: expect.objectContaining({ continent: ['NA', 'EU'] }),
    });
  });

  it('returns { raw } when API returns error', async () => {
    mockLogin();
    mockApiPost('/api_esim/getSkuByGroup', { code: 1, message: 'Server error' });

    const client = new FiRoamClient();
    const result = await client.getSkuByGroup();

    expect('grouped' in result).toBe(false);
  });

  it('returns { raw, error } when Zod validation fails', async () => {
    mockLogin();
    // Missing required `continent` field — validation fails
    mockApiPost('/api_esim/getSkuByGroup', { code: 0, data: { invalid: 'structure' } });

    const client = new FiRoamClient();
    const result = await client.getSkuByGroup();

    expect('error' in result).toBe(true);
    expect('grouped' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getPackages
// ---------------------------------------------------------------------------
describe('getPackages', () => {
  it('returns { raw } when API returns error', async () => {
    mockLogin();
    mockApiPost('/api_esim/getPackages', { code: 1, message: 'SKU not found' });

    const client = new FiRoamClient();
    const result = await client.getPackages('999');

    expect('packageData' in result).toBe(false);
    expect(result.raw).toMatchObject({ code: 1 });
  });

  it('returns { raw, error } when API succeeds but data fails Zod validation', async () => {
    mockLogin();
    // Return success but with data that is missing required PackageItem fields
    mockApiPost('/api_esim/getPackages', { code: 0, data: { skuid: 'bad', missing: true } });

    const client = new FiRoamClient();
    const result = await client.getPackages('120');

    expect('error' in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cancelOrder
// ---------------------------------------------------------------------------
describe('cancelOrder', () => {
  it('returns success: true when API confirms the cancellation', async () => {
    mockLogin();
    mockApiPost('/api_esim/refundOrder', { code: 0, message: 'Refunded successfully' });

    const client = new FiRoamClient();
    const result = await client.cancelOrder({ orderNum: 'EP-001', iccids: '8901000000000000001' });

    expect(result).toMatchObject({ success: true, message: 'Refunded successfully' });
    expect(result.raw).toMatchObject({ code: 0 });
  });

  it('returns success: false when API returns error', async () => {
    mockLogin();
    mockApiPost('/api_esim/refundOrder', { code: 1, message: 'Cannot refund: already expired' });

    const client = new FiRoamClient();
    const result = await client.cancelOrder({ orderNum: 'EP-001', iccids: '8901000000000000001' });

    expect(result).toMatchObject({ success: false, message: 'Cannot refund: already expired' });
  });

  it('returns "Unknown error" when message is absent', async () => {
    mockLogin();
    mockApiPost('/api_esim/refundOrder', { code: 1 });

    const client = new FiRoamClient();
    const result = await client.cancelOrder({ orderNum: 'EP-001', iccids: '8901' });

    expect(result.message).toBe('Unknown error');
  });
});

// ---------------------------------------------------------------------------
// queryEsimOrder
// ---------------------------------------------------------------------------
describe('queryEsimOrder', () => {
  it('returns normalized usage data on success', async () => {
    mockLogin();
    mockApiPost('/api_esim/queryEsimOrder', {
      code: 0,
      data: {
        total: 1,
        page: 1,
        rows: [
          {
            orderNum: 'EP-001',
            skuId: '120',
            skuName: 'USA',
            createTime: '2024-01-01',
            status: 'active',
            packageList: [
              {
                iccid: '8901000000000000001',
                flows: 10,
                unit: 'GB',
                usedMb: 512,
                days: 30,
                name: 'USA 10GB 30 Days',
                beginDate: '2024-01-01',
                endDate: '2024-01-31',
                status: 'active',
                priceId: '14094',
              },
            ],
          },
        ],
      },
    });

    const client = new FiRoamClient();
    const result = await client.queryEsimOrder({ orderNum: 'EP-001' });

    expect(result).toMatchObject({
      success: true,
      total: 1,
      page: 1,
      orders: [
        expect.objectContaining({
          orderNum: 'EP-001',
          packages: [
            expect.objectContaining({
              iccid: '8901000000000000001',
              usedMb: 512,
              flows: 10,
            }),
          ],
        }),
      ],
    });
  });

  it('returns { success: false } when API returns an error', async () => {
    mockLogin();
    mockApiPost('/api_esim/queryEsimOrder', { code: 1, message: 'Order not found' });

    const client = new FiRoamClient();
    const result = await client.queryEsimOrder({ iccid: '8901000000000000001' });

    expect(result).toMatchObject({ success: false, error: 'Order not found' });
  });

  it('queries with orderNum and iccid filters', async () => {
    mockLogin();
    mockApiPost('/api_esim/queryEsimOrder', {
      code: 0,
      data: { total: 0, page: 1, rows: [] },
    });

    const client = new FiRoamClient();
    const result = await client.queryEsimOrder({
      orderNum: 'EP-001',
      iccid: '8901',
      pageNo: 2,
      pageSize: 10,
    });

    expect(result).toMatchObject({ success: true, orders: [], total: 0 });
  });

  it('handles response with missing rows gracefully', async () => {
    mockLogin();
    mockApiPost('/api_esim/queryEsimOrder', {
      code: 0,
      data: { total: 0, page: 1 }, // no `rows` field
    });

    const client = new FiRoamClient();
    const result = await client.queryEsimOrder({});

    expect(result).toMatchObject({ success: true, orders: [], total: 0 });
  });
});
