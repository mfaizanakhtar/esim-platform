import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import crypto from 'crypto';
import TgtClient, { createTgtSignature, flattenParams } from '~/vendor/tgtClient';

describe('TgtClient', () => {
  const base = 'https://enterpriseapisandbox.tugegroup.com:8070/openapi';

  beforeEach(() => {
    nock.cleanAll();
    process.env.TGT_BASE_URL = base;
    process.env.TGT_ACCOUNT_ID = 'test-account';
    process.env.TGT_SECRET = 'test-secret';
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('flattens params excluding sign/empty values', () => {
    const payload = {
      b: '2',
      a: '1',
      sign: 'ignore-me',
      nested: { x: 'x1', y: '' },
      arr: ['v1', 'v2'],
      empty: '',
      nullVal: null,
    };

    const pairs = flattenParams(payload);
    expect(pairs).toContain('a1');
    expect(pairs).toContain('b2');
    expect(pairs).toContain('nested.xx1');
    expect(pairs).toContain('arr.0v1');
    expect(pairs).toContain('arr.1v2');
    expect(pairs.some((x) => x.includes('sign'))).toBe(false);
    expect(pairs.some((x) => x.includes('empty'))).toBe(false);
  });

  it('creates expected md5 signature', () => {
    const payload = { bar: '2', foo: '1' };
    const sign = createTgtSignature(payload, 's3');

    const source = 's3bar2foo1s3';
    const expected = crypto.createHash('md5').update(source, 'utf8').digest('hex');
    expect(sign).toBe(expected);
  });

  it('authenticates and creates an order', async () => {
    nock(base)
      .post('/oauth/token')
      .reply(200, {
        code: '0000',
        msg: 'success',
        data: { accessToken: 'token-1', expires: 86400 },
      });

    nock(base)
      .post('/eSIMApi/v2/order/create')
      .reply(200, { code: '0000', msg: 'success', data: { orderNo: 'SE123' } });

    const client = new TgtClient();
    const result = await client.createOrder({
      productCode: 'P1',
      channelOrderNo: 'ORDER-1',
      idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
      email: 'user@example.com',
    });

    expect(result.orderNo).toBe('SE123');
  });

  it('lists products successfully', async () => {
    nock(base)
      .post('/oauth/token')
      .reply(200, {
        code: '0000',
        msg: 'success',
        data: { accessToken: 'token-1', expires: 86400 },
      });

    nock(base)
      .post('/eSIMApi/v2/products/list')
      .reply(200, {
        code: '0000',
        msg: 'success',
        data: {
          total: 1,
          list: [
            {
              productCode: 'P1',
              productName: 'Plan One',
              productType: 'DATA_PACK',
              netPrice: 1.2,
            },
          ],
        },
      });

    const client = new TgtClient();
    const result = await client.listProducts({ pageNum: 1, pageSize: 10 });
    expect(result.total).toBe(1);
    expect(result.products[0]?.productCode).toBe('P1');
  });

  it('queryOrders retries on expired token', async () => {
    nock(base)
      .post('/oauth/token')
      .reply(200, { code: '0000', msg: 'success', data: { accessToken: 'token-1', expires: 1 } })
      .post('/oauth/token')
      .reply(200, {
        code: '0000',
        msg: 'success',
        data: { accessToken: 'token-2', expires: 86400 },
      });

    nock(base)
      .post('/eSIMApi/v2/order/orders')
      .reply(200, { code: '2003', msg: 'Token invalid' })
      .post('/eSIMApi/v2/order/orders')
      .reply(200, {
        code: '0000',
        msg: 'success',
        data: {
          list: [{ orderNo: 'SE1', qrCode: 'LPA:1$host$ACT', cardInfo: { iccid: '8999' } }],
        },
      });

    const client = new TgtClient();
    const result = await client.queryOrders({ orderNo: 'SE1' });
    expect(result.orders.length).toBe(1);
    expect(result.orders[0]?.orderNo).toBe('SE1');
  });

  it('resolves credentials from queryOrders response', async () => {
    nock(base)
      .post('/oauth/token')
      .reply(200, {
        code: '0000',
        msg: 'success',
        data: { accessToken: 'token-1', expires: 86400 },
      });

    nock(base)
      .post('/eSIMApi/v2/order/orders')
      .reply(200, {
        code: '0000',
        msg: 'success',
        data: {
          list: [
            {
              orderNo: 'SE42',
              qrCode: 'LPA:1$esiminfra.toprsp.com$ACT123',
              cardInfo: { iccid: '89852342714026530002' },
            },
          ],
        },
      });

    const client = new TgtClient();
    const resolved = await client.tryResolveOrderCredentials('SE42');

    expect(resolved.ready).toBe(true);
    expect(resolved.activationCode).toBe('ACT123');
    expect(resolved.iccid).toBe('89852342714026530002');
  });

  it('returns not-ready when order has no qrCode yet', async () => {
    nock(base)
      .post('/oauth/token')
      .reply(200, {
        code: '0000',
        msg: 'success',
        data: { accessToken: 'token-1', expires: 86400 },
      });

    nock(base)
      .post('/eSIMApi/v2/order/orders')
      .reply(200, {
        code: '0000',
        msg: 'success',
        data: {
          list: [{ orderNo: 'SE43' }],
        },
      });

    const client = new TgtClient();
    const resolved = await client.tryResolveOrderCredentials('SE43');
    expect(resolved.ready).toBe(false);
  });

  it('throws if required credentials are missing', async () => {
    delete process.env.TGT_ACCOUNT_ID;
    delete process.env.TGT_SECRET;

    const client = new TgtClient();
    await expect(client.listProducts({ pageNum: 1, pageSize: 10 })).rejects.toThrow(
      'TGT_ACCOUNT_ID/TGT_SECRET not set',
    );
  });

  it('returns usage data for order', async () => {
    nock(base)
      .post('/oauth/token')
      .reply(200, {
        code: '0000',
        msg: 'success',
        data: { accessToken: 'token-1', expires: 86400 },
      });

    nock(base)
      .post('/eSIMApi/v2/order/usage')
      .reply(200, {
        code: '0000',
        msg: 'success',
        data: {
          dataUsage: '100',
          dataTotal: '1000',
        },
      });

    const client = new TgtClient();
    const result = await client.getUsage('SE42');

    expect(result.usage?.dataUsage).toBe('100');
    expect(result.usage?.dataTotal).toBe('1000');
  });

  it('reuses cached token without re-authenticating on second call', async () => {
    // Only one auth request should be made
    nock(base)
      .post('/oauth/token')
      .once()
      .reply(200, {
        code: '0000',
        msg: 'success',
        data: { accessToken: 'token-cached', expires: 86400 },
      });

    nock(base)
      .post('/eSIMApi/v2/order/orders')
      .reply(200, { code: '0000', msg: 'success', data: { list: [] } });

    nock(base)
      .post('/eSIMApi/v2/order/orders')
      .reply(200, { code: '0000', msg: 'success', data: { list: [] } });

    const client = new TgtClient();
    await client.queryOrders({ orderNo: 'SE10' });
    await client.queryOrders({ orderNo: 'SE11' }); // reuses cached token

    // If auth was called a second time nock would throw since only one mock is registered
    expect(nock.isDone()).toBe(true);
  });

  it('throws VendorError when getUsage returns non-0000 code', async () => {
    nock(base)
      .post('/oauth/token')
      .reply(200, {
        code: '0000',
        msg: 'success',
        data: { accessToken: 'token-1', expires: 86400 },
      });

    nock(base).post('/eSIMApi/v2/order/usage').reply(200, {
      code: '4001',
      msg: 'Order not found',
    });

    const client = new TgtClient();
    await expect(client.getUsage('SE-MISSING')).rejects.toThrow('TGT usage failed');
  });

  it('retries on 2004 token expired code', async () => {
    nock(base)
      .post('/oauth/token')
      .reply(200, { code: '0000', msg: 'success', data: { accessToken: 'token-1', expires: 1 } })
      .post('/oauth/token')
      .reply(200, {
        code: '0000',
        msg: 'success',
        data: { accessToken: 'token-2', expires: 86400 },
      });

    nock(base)
      .post('/eSIMApi/v2/order/orders')
      .reply(200, { code: '2004', msg: 'Token expired' })
      .post('/eSIMApi/v2/order/orders')
      .reply(200, {
        code: '0000',
        msg: 'success',
        data: { list: [{ orderNo: 'SE99' }] },
      });

    const client = new TgtClient();
    const result = await client.queryOrders({ orderNo: 'SE99' });
    expect(result.orders.length).toBe(1);
  });
});
