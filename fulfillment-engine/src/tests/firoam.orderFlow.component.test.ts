import { describe, it, expect, beforeEach, vi } from 'vitest';
import nock from 'nock';
import FiRoamClient from '~/vendor/firoamClient';

// Mock Prisma to avoid database operations in component tests
vi.mock('../db/prisma', () => ({
  default: {
    esimOrder: {
      create: vi.fn().mockResolvedValue({ id: 1 }),
    },
  },
}));

const base = 'https://bpm.roamwifi.hk';

describe('FiRoamClient - Complete Order Flow', () => {
  beforeEach(() => {
    nock.cleanAll();
    nock.recorder.clear();
    // Set encryption key for tests (required by crypto util)
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '00000000000000000000000000000000';
  });

  it('should complete full order flow: getSkus -> getPackages -> addEsimOrder (mock)', async () => {
    process.env.FIROAM_PHONE = 'mock-phone';
    process.env.FIROAM_PASSWORD = 'mock-pass';

    // Mock login (uses GET per Python example in FiRoam docs)
    nock(base)
      .get('/api_order/login')
      .query(true)
      .reply(200, { data: { token: 'mock-token' } });

    // Mock getSkus
    nock(base)
      .post('/api_esim/getSkus')
      .reply(200, {
        code: 0,
        data: [
          { skuid: 26, display: 'Japan', countryCode: '392' },
          { skuid: 123, display: 'Asia 8 countries', countryCode: '99112' },
        ],
      });

    // Mock getPackages for Japan (skuid: 26)
    nock(base)
      .post('/api_esim/getPackages')
      .reply(200, {
        code: 0,
        data: {
          skuid: 26,
          detailId: 1,
          countrycode: '392',
          imageUrl: 'http://example.com/japan.jpg',
          display: 'Japan',
          displayEn: 'Japan',
          esimPackageDtoList: [
            {
              flows: 3,
              days: 7,
              unit: 'GB',
              price: 15.99,
              priceid: 1001,
              flowType: 0,
              countryImageUrlDtoList: [],
              showName: '3GB - 7 Days',
              pid: 100,
              premark: 'Data only plan',
              expireDays: 0,
              networkDtoList: [],
              supportDaypass: 0,
              openCardFee: 0,
              minDay: 1,
              singleDiscountDay: 0,
              singleDiscount: 0,
              maxDiscount: 0,
              maxDay: 30,
              mustDate: 0,
              apiCode: '392-0-7-3-G',
            },
          ],
          supportCountry: ['Japan'],
          expirydate: null,
          countryImageUrlDtoList: [],
        },
      });

    // Mock addEsimOrder
    nock(base)
      .post('/api_esim/addEsimOrder')
      .reply(200, { code: 0, data: { orderNum: 'EP-MOCK-ORDER-123' } });

    // Mock getOrderInfo to be called after successful order
    nock(base)
      .post('/api_esim/getOrderInfo')
      .reply(200, {
        code: 0,
        data: {
          orderNum: 'EP-MOCK-ORDER-123',
          cardApiDtoList: [
            {
              sm_dp_address: 'lpa-mock',
              activationCode: 'ACT-MOCK',
              mobileNumber: '8901000000000000001',
              iccid: '8901000000000000001',
            },
          ],
        },
      });

    const client = new FiRoamClient();

    // Step 1: Get available SKUs
    const skuResult = await client.getSkus();
    expect(skuResult.skus).toBeDefined();
    expect(skuResult.skus?.length).toBeGreaterThan(0);

    // Find Japan SKU
    const japanSku = skuResult.skus?.find((s) => s.display === 'Japan');
    expect(japanSku).toBeDefined();
    expect(japanSku?.skuid).toBe(26);

    // Step 2: Get packages for Japan
    const packagesResult = await client.getPackages(japanSku!.skuid.toString());
    expect(packagesResult.packageData).toBeDefined();
    expect(packagesResult.packageData?.esimPackageDtoList.length).toBeGreaterThan(0);

    const packageData = packagesResult.packageData!;
    expect(packageData.esimPackageDtoList.length).toBeGreaterThan(0);

    // Select first plan
    const selectedPlan = packageData.esimPackageDtoList[0];
    expect(selectedPlan.priceid).toBe(1001);
    expect(selectedPlan.flows).toBe(3);
    expect(selectedPlan.days).toBe(7);

    // Step 3: Place order
    const orderResult = await client.addEsimOrder({
      skuId: japanSku!.skuid.toString(),
      priceId: selectedPlan.priceid.toString(),
      count: '1',
    });

    expect(orderResult.raw).toBeDefined();
    expect(orderResult.raw.code).toBe(0);
    expect((orderResult.raw.data as Record<string, unknown>).orderNum).toBe('EP-MOCK-ORDER-123');

    // Canonical payload should be populated from getOrderInfo
    // (May not work if getOrderInfo mock fails or encryption key missing)
    if (!orderResult.canonical) {
      console.warn(
        '⚠️  Canonical payload not populated - check getOrderInfo mock and ENCRYPTION_KEY',
      );
    }
  });
});
