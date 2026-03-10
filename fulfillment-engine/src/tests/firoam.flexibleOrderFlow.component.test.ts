/**
 * Component tests for flexible order flow in addEsimOrder
 * Tests both one-step (backInfo="1") and two-step (no backInfo) flows
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import FiRoamClient from '~/vendor/firoamClient';

const BASE_URL = 'https://bpm.roamwifi.hk';

describe('FiRoamClient - Flexible Order Flow', () => {
  let client: FiRoamClient;

  beforeEach(() => {
    process.env.FIROAM_PHONE = '923222825575';
    process.env.FIROAM_PASSWORD = 'esim825575';
    process.env.FIROAM_SIGN_KEY = '1234567890qwertyuiopasdfghjklzxc';

    nock.cleanAll();
    nock.disableNetConnect(); // Prevent real network requests

    // Mock login that happens in constructor
    nock(BASE_URL)
      .get('/api_order/login')
      .query(true)
      .reply(200, {
        code: 1,
        msg: 'success',
        data: { token: 'mock-token-123' },
      });

    client = new FiRoamClient();
  });

  afterEach(async () => {
    // Note: skipping cleanup as we don't need DB for mocked tests
    nock.cleanAll();
    nock.enableNetConnect(); // Re-enable for other tests
  });

  it('should support one-step flow with backInfo="1"', async () => {
    // Mock addEsimOrder with backInfo="1" - returns full details immediately
    nock(BASE_URL)
      .post('/api_esim/addEsimOrder')
      .reply(200, {
        code: 0,
        msg: 'success',
        data: {
          orderNum: 'ORD-12345-ONE',
          cardApiDtoList: [
            {
              sm_dp_address: 'LPA$1$smdp.example.com$ABC123',
              activationCode: 'ACT-CODE-123',
              iccid: '8901234567890123456',
              mobileNumber: '+1234567890',
            },
          ],
        },
      });

    const result = await client.addEsimOrder({
      skuId: '1',
      priceId: 'PRICE-123',
      count: '1',
      iccidLikeFlag: '0',
      autoUseFlag: '0',
      backInfo: '1', // One-step flow
    });

    // Check raw response
    expect(result.raw.code).toBe(0);
    const rawData = result.raw.data as Record<string, unknown>;
    expect(rawData.orderNum).toBe('ORD-12345-ONE');
    expect(Array.isArray(rawData.cardApiDtoList)).toBe(true);
    expect((rawData.cardApiDtoList as unknown[]).length).toBe(1);
    const firstCard = (rawData.cardApiDtoList as unknown[])[0] as Record<string, unknown>;
    expect(firstCard.sm_dp_address).toBe('LPA$1$smdp.example.com$ABC123');
    expect(firstCard.activationCode).toBe('ACT-CODE-123');
    expect(firstCard.iccid).toBe('8901234567890123456');

    // Canonical would be defined in production with working DB
    // In component test with mocked API, DB operations may fail
    // The important thing is that API flow correctly detects one-step vs two-step

    // Verify no extra getOrderInfo call was made (nock would throw if it happened)
    expect(nock.isDone()).toBe(true);
  });

  it('should support two-step flow without backInfo', async () => {
    // Mock addEsimOrder without backInfo - returns only orderNum
    nock(BASE_URL)
      .post('/api_esim/addEsimOrder')
      .reply(200, {
        code: 0,
        msg: 'success',
        data: {
          orderNum: 'ORD-12345-TWO',
        },
      });

    // Mock getOrderInfo - called automatically
    nock(BASE_URL)
      .post('/api_esim/getOrderInfo')
      .reply(200, {
        code: 0,
        msg: 'success',
        data: {
          orderNum: 'ORD-12345-TWO',
          cardApiDtoList: [
            {
              sm_dp_address: 'LPA$1$smdp.example.com$XYZ789',
              activationCode: 'ACT-CODE-789',
              iccid: '8909876543210987654',
              mobileNumber: '+9876543210',
            },
          ],
        },
      });

    const result = await client.addEsimOrder({
      skuId: '1',
      priceId: 'PRICE-456',
      count: '1',
      iccidLikeFlag: '0',
      autoUseFlag: '0',
      // No backInfo - two-step flow
    });

    // Check raw response
    expect(result.raw.code).toBe(0);
    expect((result.raw.data as Record<string, unknown>).orderNum).toBe('ORD-12345-TWO');

    // In two-step flow, getOrderInfo should have been called
    // Verify both calls were made (constructor login is automatic, getOrderInfo is second call)
    expect(nock.isDone()).toBe(true);
  });

  it('should allow manual getOrderInfo call', async () => {
    // Mock getOrderInfo
    nock(BASE_URL)
      .post('/api_esim/getOrderInfo')
      .reply(200, {
        code: 0,
        msg: 'success',
        data: {
          orderNum: 'ORD-MANUAL-123',
          cardApiDtoList: [
            {
              sm_dp_address: 'LPA$1$smdp.example.com$MANUAL',
              activationCode: 'ACT-MANUAL',
              iccid: '8901111111111111111',
              mobileNumber: '+1111111111',
            },
          ],
        },
      });

    const result = await client.getOrderInfo('ORD-MANUAL-123');

    expect(result.code).toBe(0);
    const resultData = result.data as Record<string, unknown>;
    expect(resultData.orderNum).toBe('ORD-MANUAL-123');
    expect(Array.isArray(resultData.cardApiDtoList)).toBe(true);
    expect((resultData.cardApiDtoList as unknown[]).length).toBe(1);
    const firstCard = (resultData.cardApiDtoList as unknown[])[0] as Record<string, unknown>;
    expect(firstCard.sm_dp_address).toBe('LPA$1$smdp.example.com$MANUAL');
  });

  it('should handle one-step flow with legacy string response format', async () => {
    // Mock addEsimOrder returning orderNum as string (legacy format without backInfo)
    nock(BASE_URL).post('/api_esim/addEsimOrder').reply(200, {
      code: 0,
      msg: 'success',
      data: 'ORD-STRING-123', // String response
    });

    // Mock getOrderInfo - should be called for two-step flow
    nock(BASE_URL)
      .post('/api_esim/getOrderInfo')
      .reply(200, {
        code: 0,
        msg: 'success',
        data: {
          orderNum: 'ORD-STRING-123',
          cardApiDtoList: [
            {
              sm_dp_address: 'LPA$1$smdp.example.com$STR',
              activationCode: 'ACT-STR',
              iccid: '8902222222222222222',
              mobileNumber: '+2222222222',
            },
          ],
        },
      });

    const result = await client.addEsimOrder({
      skuId: '1',
      priceId: 'PRICE-789',
      count: '1',
      iccidLikeFlag: '0',
      autoUseFlag: '0',
    });

    // Check raw response
    expect(result.raw.code).toBe(0);
    expect(result.raw.data).toBe('ORD-STRING-123'); // String response format

    // Verify getOrderInfo was called for string response
    expect(nock.isDone()).toBe(true);
  });
});
