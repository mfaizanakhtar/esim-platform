import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderMappingConfig, ProvisionContext } from '~/vendor/types';
import { TgtProvider } from '~/vendor/providers/tgt';

const createOrder = vi.fn();
const tryResolveOrderCredentials = vi.fn();
const mockFindUnique = vi.fn();
const queryOrders = vi.fn();
const renewOrder = vi.fn();
const createTopup = vi.fn();

vi.mock('~/vendor/tgtClient', () => {
  return {
    default: class MockTgtClient {
      createOrder(...args: unknown[]) {
        return createOrder(...args);
      }
      tryResolveOrderCredentials(...args: unknown[]) {
        return tryResolveOrderCredentials(...args);
      }
      queryOrders(...args: unknown[]) {
        return queryOrders(...args);
      }
      renewOrder(...args: unknown[]) {
        return renewOrder(...args);
      }
      createTopup(...args: unknown[]) {
        return createTopup(...args);
      }
    },
  };
});

vi.mock('~/db/prisma', () => ({
  default: {
    providerSkuCatalog: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
  },
}));

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

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns pending result for callback mode', async () => {
    vi.stubEnv('TGT_FULFILLMENT_MODE', 'callback');
    createOrder.mockResolvedValue({ orderNo: 'SE100' });

    const provider = new TgtProvider();
    const result = await provider.provision(config, ctx);

    expect(createOrder).toHaveBeenCalledOnce();
    expect(result.pending).toBe(true);
    expect(result.vendorOrderId).toBe('SE100');
  });

  it('returns ready result in polling mode when credentials resolve', async () => {
    vi.stubEnv('TGT_FULFILLMENT_MODE', 'polling');
    vi.stubEnv('TGT_POLL_INTERVAL_SECONDS', '1');
    vi.stubEnv('TGT_POLL_MAX_ATTEMPTS', '2');

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
    vi.stubEnv('TGT_FULFILLMENT_MODE', 'polling');
    vi.stubEnv('TGT_POLL_INTERVAL_SECONDS', '1');
    vi.stubEnv('TGT_POLL_MAX_ATTEMPTS', '1');

    createOrder.mockResolvedValue({ orderNo: 'SE404' });
    tryResolveOrderCredentials.mockResolvedValue({ ready: false });

    const provider = new TgtProvider();
    await expect(provider.provision(config, ctx)).rejects.toThrow(
      'TGT order SE404 created but credentials not ready after polling',
    );
  });

  it('returns pending result for hybrid mode', async () => {
    vi.stubEnv('TGT_FULFILLMENT_MODE', 'hybrid');
    createOrder.mockResolvedValue({ orderNo: 'SE300' });

    const provider = new TgtProvider();
    const result = await provider.provision(config, ctx);

    expect(result.pending).toBe(true);
    expect(result.vendorOrderId).toBe('SE300');
  });

  it('generates channelOrderNo from randomUUID when deliveryId absent in context', async () => {
    vi.stubEnv('TGT_FULFILLMENT_MODE', 'callback');
    createOrder.mockResolvedValue({ orderNo: 'SE-RAND' });

    const ctxNoDelivery: ProvisionContext = {
      customerEmail: 'no-delivery@example.com',
      quantity: 1,
      // deliveryId omitted
    };

    const provider = new TgtProvider();
    await provider.provision(config, ctxNoDelivery);

    expect(createOrder).toHaveBeenCalledOnce();
  });

  it('falls back to empty strings when activationCode/iccid missing in polling response', async () => {
    vi.stubEnv('TGT_FULFILLMENT_MODE', 'polling');
    vi.stubEnv('TGT_POLL_INTERVAL_SECONDS', '1');
    vi.stubEnv('TGT_POLL_MAX_ATTEMPTS', '2');

    createOrder.mockResolvedValue({ orderNo: 'SE-SPARSE' });
    tryResolveOrderCredentials.mockResolvedValue({
      ready: true,
      lpa: 'LPA:1$host$ACT',
      activationCode: null,
      iccid: undefined,
    });

    const provider = new TgtProvider();
    const result = await provider.provision(config, ctx);

    expect(result.activationCode).toBe('');
    expect(result.iccid).toBe('');
  });

  it('passes undefined to createOrder email when customerEmail is empty string', async () => {
    vi.stubEnv('TGT_FULFILLMENT_MODE', 'callback');
    createOrder.mockResolvedValue({ orderNo: 'SE-NOEMAIL' });

    const ctxEmptyEmail: ProvisionContext = {
      customerEmail: '',
      quantity: 1,
    };

    const provider = new TgtProvider();
    await provider.provision(config, ctxEmptyEmail);

    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ email: undefined }));
  });

  it('passes startDate string from providerConfig to createOrder', async () => {
    vi.stubEnv('TGT_FULFILLMENT_MODE', 'callback');
    createOrder.mockResolvedValue({ orderNo: 'SE400' });

    const configWithDate: ProviderMappingConfig = {
      providerSku: 'A-002-ES-AU-T-30D/180D-3GB(A)',
      providerConfig: { startDate: '2026-06-01' },
    };

    const provider = new TgtProvider();
    await provider.provision(configWithDate, ctx);

    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-06-01' }));
  });

  // ── Catalog-linked path ──────────────────────────────────────────────

  it('uses productCode from catalog entry when providerCatalogId is set', async () => {
    vi.stubEnv('TGT_FULFILLMENT_MODE', 'callback');
    mockFindUnique.mockResolvedValue({ productCode: 'CATALOG-PRODUCT-CODE' });
    createOrder.mockResolvedValue({ orderNo: 'SE-CAT-001' });

    const catalogConfig: ProviderMappingConfig = {
      providerSku: 'ignored',
      providerCatalogId: 'cat-001',
    };

    const provider = new TgtProvider();
    const result = await provider.provision(catalogConfig, ctx);

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: 'cat-001' },
      select: { productCode: true },
    });
    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ productCode: 'CATALOG-PRODUCT-CODE' }),
    );
    expect(result.vendorOrderId).toBe('SE-CAT-001');
    expect(result.pending).toBe(true);
  });

  it('throws MappingError when catalog entry is not found (findUnique returns null)', async () => {
    vi.stubEnv('TGT_FULFILLMENT_MODE', 'callback');
    mockFindUnique.mockResolvedValue(null);

    const { MappingError: ME } = await import('~/utils/errors');
    const catalogConfig: ProviderMappingConfig = {
      providerSku: 'ignored',
      providerCatalogId: 'cat-nonexistent',
    };

    const provider = new TgtProvider();
    await expect(provider.provision(catalogConfig, ctx)).rejects.toThrow(ME);
  });

  it('throws MappingError when catalog entry has empty productCode', async () => {
    vi.stubEnv('TGT_FULFILLMENT_MODE', 'callback');
    mockFindUnique.mockResolvedValue({ productCode: '' });

    const { MappingError: ME } = await import('~/utils/errors');
    const catalogConfig: ProviderMappingConfig = {
      providerSku: 'ignored',
      providerCatalogId: 'cat-empty',
    };

    const provider = new TgtProvider();
    await expect(provider.provision(catalogConfig, ctx)).rejects.toThrow(ME);
  });

  it('sleeps between polling attempts when credentials not ready on first try', async () => {
    vi.stubEnv('TGT_FULFILLMENT_MODE', 'polling');
    vi.stubEnv('TGT_POLL_INTERVAL_SECONDS', '1');
    vi.stubEnv('TGT_POLL_MAX_ATTEMPTS', '2');

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

  // ── Top-up / Renewal path ─────────────────────────────────────────────────

  describe('top-up branch (topupIccid set)', () => {
    const topupCtx: ProvisionContext = {
      customerEmail: 'user@example.com',
      quantity: 1,
      deliveryId: 'delivery-topup-1',
      topupIccid: '89001234567890',
    };

    it('calls createTopup for C4 card type and returns sync result', async () => {
      vi.stubEnv('TGT_FULFILLMENT_MODE', 'callback');
      queryOrders.mockResolvedValue({
        orders: [{ orderNo: 'TGT-C4-001', productCode: 'A-C4-DAILY-5GB', profileStatus: null }],
      });
      createTopup.mockResolvedValue({ topupNumber: 'TOP-001' });

      const provider = new TgtProvider();
      const result = await provider.provision(config, topupCtx);

      expect(createTopup).toHaveBeenCalledWith(
        expect.objectContaining({ orderNo: 'TGT-C4-001', purchaseType: 1 }),
      );
      expect(result.vendorOrderId).toBe('TOP-001');
      expect(result.iccid).toBe('89001234567890');
      expect(result.lpa).toBe('');
      expect(result.pending).toBeUndefined();
    });

    it('uses tgtPurchaseType from providerConfig for C4 top-up', async () => {
      vi.stubEnv('TGT_FULFILLMENT_MODE', 'callback');
      queryOrders.mockResolvedValue({
        orders: [{ orderNo: 'TGT-C4-002', productCode: 'A-C4-DAILY-5GB' }],
      });
      createTopup.mockResolvedValue({ topupNumber: 'TOP-002' });

      const configWithPurchaseType: ProviderMappingConfig = {
        providerSku: 'A-002-ES-AU-T-30D/180D-3GB(A)',
        providerConfig: { tgtPurchaseType: 2 },
      };

      const provider = new TgtProvider();
      await provider.provision(configWithPurchaseType, topupCtx);

      expect(createTopup).toHaveBeenCalledWith(expect.objectContaining({ purchaseType: 2 }));
    });

    it('calls renewOrder for M1/C2 card type and returns pending result', async () => {
      vi.stubEnv('TGT_FULFILLMENT_MODE', 'callback');
      queryOrders.mockResolvedValue({
        orders: [{ orderNo: 'TGT-M1-001', productCode: 'A-M1-30D-3GB' }],
      });
      renewOrder.mockResolvedValue({ orderNo: 'RENEW-001' });

      const provider = new TgtProvider();
      const result = await provider.provision(config, topupCtx);

      expect(renewOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          iccid: '89001234567890',
          productCode: 'A-002-ES-AU-T-30D/180D-3GB(A)',
        }),
      );
      expect(result.vendorOrderId).toBe('RENEW-001');
      expect(result.pending).toBe(true);
      expect(result.iccid).toBe('');
    });

    it('throws VendorError when no existing order found for topupIccid', async () => {
      vi.stubEnv('TGT_FULFILLMENT_MODE', 'callback');
      queryOrders.mockResolvedValue({ orders: [] });

      const { VendorError: VE } = await import('~/utils/errors');
      const provider = new TgtProvider();
      await expect(provider.provision(config, topupCtx)).rejects.toThrow(VE);
    });
  });
});
