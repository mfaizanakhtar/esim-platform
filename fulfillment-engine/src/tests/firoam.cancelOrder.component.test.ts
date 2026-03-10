import { describe, it, expect, beforeEach } from 'vitest';
import nock from 'nock';
import FiRoamClient from '~/vendor/firoamClient';

/**
 * Component Tests for FiRoamClient.cancelOrder()
 *
 * These are component tests (not unit tests) because we're testing the FiRoamClient
 * component with mocked external dependencies (API calls). We verify the component's
 * behavior in isolation by mocking the network layer.
 *
 * Unit tests would test pure functions in complete isolation.
 * Component tests verify a component works correctly with mocked dependencies.
 * Integration tests verify actual API interactions.
 */
describe('FiRoamClient.cancelOrder() - Component Tests', () => {
  const base = process.env.FIROAM_BASE_URL || 'https://bpm.roamwifi.hk';

  beforeEach(() => {
    nock.cleanAll();
  });

  it('should successfully cancel an order with orderNum only', async () => {
    process.env.FIROAM_PHONE = process.env.FIROAM_PHONE || 'mock-phone';
    process.env.FIROAM_PASSWORD = process.env.FIROAM_PASSWORD || 'mock-pass';

    // Mock login
    nock(base)
      .get('/api_order/login')
      .query(true)
      .reply(200, {
        code: 1,
        data: { token: 'mock-token' },
      });

    // Mock successful cancellation
    nock(base).post('/api_esim/refundOrder').reply(200, {
      code: '0',
      message: 'success',
      data: null,
    });

    const client = new FiRoamClient();
    const result = await client.cancelOrder({
      orderNum: 'EP-TEST-123',
      iccids: '8901000000000000001',
    });

    expect(result.raw).toBeDefined();
    expect(result.raw.code).toBe('0');
    expect(result.success).toBe(true);
    expect(result.message).toBe('success');
  });

  it('should cancel order with specific ICCIDs (partial cancellation)', async () => {
    process.env.FIROAM_PHONE = 'mock-phone';
    process.env.FIROAM_PASSWORD = 'mock-pass';

    nock(base)
      .get('/api_order/login')
      .query(true)
      .reply(200, {
        code: 1,
        data: { token: 'mock-token' },
      });

    nock(base).post('/api_esim/refundOrder').reply(200, {
      code: 0,
      message: 'success',
      data: null,
    });

    const client = new FiRoamClient();
    const result = await client.cancelOrder({
      orderNum: 'EP-TEST-123',
      iccids: '8901000000000000001,8901000000000000002',
    });

    expect(result.success).toBe(true);
    expect(result.raw.code).toBe(0);
  });

  it('should handle token expiration error', async () => {
    process.env.FIROAM_PHONE = 'mock-phone';
    process.env.FIROAM_PASSWORD = 'mock-pass';

    nock(base)
      .get('/api_order/login')
      .query(true)
      .reply(200, {
        code: 1,
        data: { token: 'mock-token' },
      });

    nock(base).post('/api_esim/refundOrder').reply(200, {
      code: -1,
      message: 'token expire',
      data: '',
    });

    const client = new FiRoamClient();
    const result = await client.cancelOrder({
      orderNum: 'EP-TEST-123',
      iccids: '8901000000000000001',
    });

    expect(result.success).toBe(false);
    expect(result.raw.code).toBe(-1);
    expect(result.message).toBe('token expire');
  });

  it('should handle order not found error', async () => {
    process.env.FIROAM_PHONE = 'mock-phone';
    process.env.FIROAM_PASSWORD = 'mock-pass';

    nock(base)
      .get('/api_order/login')
      .query(true)
      .reply(200, {
        code: 1,
        data: { token: 'mock-token' },
      });

    nock(base).post('/api_esim/refundOrder').reply(200, {
      code: 3,
      message: 'data not exist',
      data: '',
    });

    const client = new FiRoamClient();
    const result = await client.cancelOrder({
      orderNum: 'EP-NONEXISTENT',
      iccids: '8901000000000000001',
    });

    expect(result.success).toBe(false);
    expect(result.raw.code).toBe(3);
    expect(result.message).toBe('data not exist');
  });

  it('should handle non-personal order error', async () => {
    process.env.FIROAM_PHONE = 'mock-phone';
    process.env.FIROAM_PASSWORD = 'mock-pass';

    nock(base)
      .get('/api_order/login')
      .query(true)
      .reply(200, {
        code: 1,
        data: { token: 'mock-token' },
      });

    nock(base).post('/api_esim/refundOrder').reply(200, {
      code: 22,
      message: 'Non-personal orders',
      data: '',
    });

    const client = new FiRoamClient();
    const result = await client.cancelOrder({
      orderNum: 'EP-TEST-123',
      iccids: '8901000000000000001',
    });

    expect(result.success).toBe(false);
    expect(result.raw.code).toBe(22);
    expect(result.message).toBe('Non-personal orders');
  });

  it('should handle signature error', async () => {
    process.env.FIROAM_PHONE = 'mock-phone';
    process.env.FIROAM_PASSWORD = 'mock-pass';

    nock(base)
      .get('/api_order/login')
      .query(true)
      .reply(200, {
        code: 1,
        data: { token: 'mock-token' },
      });

    nock(base).post('/api_esim/refundOrder').reply(200, {
      code: -30,
      message: 'sign wrong',
      data: 'sign wrong',
    });

    const client = new FiRoamClient();
    const result = await client.cancelOrder({
      orderNum: 'EP-TEST-123',
      iccids: '8901000000000000001',
    });

    expect(result.success).toBe(false);
    expect(result.raw.code).toBe(-30);
    expect(result.message).toBe('sign wrong');
  });

  it('should handle missing parameters error', async () => {
    process.env.FIROAM_PHONE = 'mock-phone';
    process.env.FIROAM_PASSWORD = 'mock-pass';

    nock(base)
      .get('/api_order/login')
      .query(true)
      .reply(200, {
        code: 1,
        data: { token: 'mock-token' },
      });

    nock(base).post('/api_esim/refundOrder').reply(200, {
      code: -2,
      message: 'params is not null',
      data: '',
    });

    const client = new FiRoamClient();
    const result = await client.cancelOrder({
      orderNum: '',
      iccids: '8901000000000000001',
    });

    expect(result.success).toBe(false);
    expect(result.raw.code).toBe(-2);
    expect(result.message).toBe('params is not null');
  });
});
