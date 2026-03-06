import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import FiRoamClient from '~/vendor/firoamClient';

const BASE_URL = 'https://bpm.roamwifi.hk';

describe('FiRoamClient.getSkus', () => {
  let client: FiRoamClient;
  const token = 'mock-token';

  beforeEach(() => {
    process.env.FIROAM_BASE_URL = BASE_URL;
    process.env.FIROAM_SIGN_KEY = '1234567890qwertyuiopasdfghjklzxc';
    process.env.FIROAM_PHONE = 'mock-phone';
    process.env.FIROAM_PASSWORD = 'mock-password';
    client = new FiRoamClient();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('returns normalized skus on success', async () => {
    // Mock login (uses GET per Python example in FiRoam docs)
    nock(BASE_URL).get('/api_order/login').query(true).reply(200, { code: 1, data: { token } });
    // Mock getSkus
    nock(BASE_URL)
      .post('/api_esim/getSkus')
      .reply(200, {
        code: '0',
        message: 'success',
        data: [
          { skuid: 156, display: 'Africa', countryCode: '99918' },
          { skuid: 124, display: 'Asia30', countryCode: '99115' },
        ],
      });

    const result = await client.getSkus();
    expect(result.raw.code).toBe('0');
    expect(result.skus).toBeDefined();
    expect(result.skus?.length).toBe(2);
    expect(result.skus?.[0]).toMatchObject({ skuid: 156, display: 'Africa', countryCode: '99918' });
  });

  it('handles validation error for malformed data', async () => {
    nock(BASE_URL).get('/api_order/login').query(true).reply(200, { code: 1, data: { token } });
    nock(BASE_URL)
      .post('/api_esim/getSkus')
      .reply(200, {
        code: '0',
        message: 'success',
        data: [{ skuid: null, display: 123, countryCode: 999 }],
      });
    const result = await client.getSkus();
    expect(result.raw.code).toBe('0');
    expect(result.skus).toBeUndefined();
    expect(result.error).toBeDefined();
  });

  it('returns raw response on API error', async () => {
    nock(BASE_URL).get('/api_order/login').query(true).reply(200, { code: 1, data: { token } });
    nock(BASE_URL)
      .post('/api_esim/getSkus')
      .reply(200, { code: -1, message: 'tokenexpire', data: '' });
    const result = await client.getSkus();
    expect(result.raw.code).toBe(-1);
    expect(result.skus).toBeUndefined();
  });
});
