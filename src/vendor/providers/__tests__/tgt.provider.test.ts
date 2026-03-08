import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderMappingConfig, ProvisionContext } from '~/vendor/types';
import { TgtProvider } from '~/vendor/providers/tgt';

const createOrder = vi.fn();
const tryResolveOrderCredentials = vi.fn();

vi.mock('~/vendor/tgtClient', () => {
  return {
    default: class MockTgtClient {
      createOrder(...args: unknown[]) {
        return createOrder(...args);
      }
      tryResolveOrderCredentials(...args: unknown[]) {
        return tryResolveOrderCredentials(...args);
      }
    },
  };
});

describe('TgtProvider', () => {
  const config: ProviderMappingConfig = {
    providerSku: 'A-002-ES-AU-T-30D/180D-3GB(A)',
    providerConfig: null,
  };

  const ctx: ProvisionContext = {
    customerEmail: 'user@example.com',
    quantity: 1,
    deliveryId: 'delivery-123',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns pending result for callback mode', async () => {
    process.env.TGT_FULFILLMENT_MODE = 'callback';
    createOrder.mockResolvedValue({ orderNo: 'SE100' });

    const provider = new TgtProvider();
    const result = await provider.provision(config, ctx);

    expect(createOrder).toHaveBeenCalledOnce();
    expect(result.pending).toBe(true);
    expect(result.vendorOrderId).toBe('SE100');
  });

  it('returns ready result in polling mode when credentials resolve', async () => {
    process.env.TGT_FULFILLMENT_MODE = 'polling';
    process.env.TGT_POLL_INTERVAL_SECONDS = '1';
    process.env.TGT_POLL_MAX_ATTEMPTS = '2';

    createOrder.mockResolvedValue({ orderNo: 'SE200' });
    tryResolveOrderCredentials.mockResolvedValue({
      ready: true,
      lpa: 'LPA:1$host$ACT',
      activationCode: 'ACT',
      iccid: '8999',
    });

    const provider = new TgtProvider();
    const result = await provider.provision(config, ctx);

    expect(tryResolveOrderCredentials).toHaveBeenCalledWith('SE200');
    expect(result.pending).toBeUndefined();
    expect(result.lpa).toBe('LPA:1$host$ACT');
    expect(result.iccid).toBe('8999');
  });

  it('throws when polling mode cannot resolve credentials in max attempts', async () => {
    process.env.TGT_FULFILLMENT_MODE = 'polling';
    process.env.TGT_POLL_INTERVAL_SECONDS = '1';
    process.env.TGT_POLL_MAX_ATTEMPTS = '1';

    createOrder.mockResolvedValue({ orderNo: 'SE404' });
    tryResolveOrderCredentials.mockResolvedValue({ ready: false });

    const provider = new TgtProvider();
    await expect(provider.provision(config, ctx)).rejects.toThrow(
      'TGT order SE404 created but credentials not ready after polling',
    );
  });

  it('returns pending result for hybrid mode', async () => {
    process.env.TGT_FULFILLMENT_MODE = 'hybrid';
    createOrder.mockResolvedValue({ orderNo: 'SE300' });

    const provider = new TgtProvider();
    const result = await provider.provision(config, ctx);

    expect(result.pending).toBe(true);
    expect(result.vendorOrderId).toBe('SE300');
  });

  it('passes startDate string from providerConfig to createOrder', async () => {
    process.env.TGT_FULFILLMENT_MODE = 'callback';
    createOrder.mockResolvedValue({ orderNo: 'SE400' });

    const configWithDate: ProviderMappingConfig = {
      providerSku: 'A-002-ES-AU-T-30D/180D-3GB(A)',
      providerConfig: { startDate: '2026-06-01' },
    };

    const provider = new TgtProvider();
    await provider.provision(configWithDate, ctx);

    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-06-01' }));
  });

  it('sleeps between polling attempts when credentials not ready on first try', async () => {
    process.env.TGT_FULFILLMENT_MODE = 'polling';
    process.env.TGT_POLL_INTERVAL_SECONDS = '1';
    process.env.TGT_POLL_MAX_ATTEMPTS = '2';

    createOrder.mockResolvedValue({ orderNo: 'SE500' });
    tryResolveOrderCredentials.mockResolvedValueOnce({ ready: false }).mockResolvedValueOnce({
      ready: true,
      lpa: 'LPA:1$host$ACT2',
      activationCode: 'ACT2',
      iccid: '8888',
    });

    const provider = new TgtProvider();
    const result = await provider.provision(config, ctx);

    expect(tryResolveOrderCredentials).toHaveBeenCalledTimes(2);
    expect(result.lpa).toBe('LPA:1$host$ACT2');
  });
});
