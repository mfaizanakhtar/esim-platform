import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FiRoamProvider } from '~/vendor/providers/firoam';
import { MappingError, VendorError } from '~/utils/errors';
import type { ProviderMappingConfig, ProvisionContext } from '~/vendor/types';

// ---------------------------------------------------------------------------
// Mock prisma for catalog-linked tests
// ---------------------------------------------------------------------------
const mockFindUniqueOrThrow = vi.fn();
vi.mock('~/db/prisma', () => ({
  default: {
    providerSkuCatalog: {
      findUniqueOrThrow: (...args: unknown[]) => mockFindUniqueOrThrow(...args),
    },
  },
}));

// ---------------------------------------------------------------------------
// Silence logger output during tests
// ---------------------------------------------------------------------------
vi.mock('~/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock FiRoamClient — injected via the provider constructor
// ---------------------------------------------------------------------------

/** Minimal client interface used by FiRoamProvider */
interface MockClient {
  addEsimOrder: ReturnType<typeof vi.fn>;
  getPackages: ReturnType<typeof vi.fn>;
}

/** Default success response from addEsimOrder */
function makeOrderSuccess(overrides: Partial<{ orderNum: string }> = {}) {
  return {
    canonical: {
      lpa: 'LPA:1$smdp.io$ACTCODE',
      activationCode: 'ACTCODE',
      iccid: '8901000000000000001',
    },
    db: { id: 'db-record-1' },
    raw: { code: 0, data: { orderNum: overrides.orderNum ?? 'EP-001' } },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Shared test context
// ---------------------------------------------------------------------------

const ctx: ProvisionContext = {
  customerEmail: 'traveler@example.com',
  quantity: 1,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFixedConfig(providerSku: string): ProviderMappingConfig {
  return { providerSku, packageType: 'fixed' };
}

function makeDaypassConfig(providerSku: string, daysCount?: number): ProviderMappingConfig {
  return { providerSku, packageType: 'daypass', daysCount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FiRoamProvider.provision()', () => {
  let mockClient: MockClient;
  let provider: FiRoamProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      addEsimOrder: vi.fn().mockResolvedValue(makeOrderSuccess()),
      getPackages: vi.fn(),
    };
    // Inject mock client so no real HTTP calls are made
    provider = new FiRoamProvider(mockClient as never);
  });

  // ── providerSku format validation ─────────────────────────────────────

  describe('providerSku validation', () => {
    it('throws MappingError when providerSku has only one part (no colon)', async () => {
      await expect(provider.provision(makeFixedConfig('justonepart'), ctx)).rejects.toThrow(
        MappingError,
      );
    });

    it('throws MappingError with descriptive message for bad format', async () => {
      await expect(provider.provision(makeFixedConfig('badformat'), ctx)).rejects.toThrow(
        'Invalid providerSku format',
      );
    });
  });

  // ── Fixed package — priceId from 3-part SKU ───────────────────────────

  describe('fixed package — 3-part providerSku', () => {
    it('uses storedPriceId (3rd part) as priceId', async () => {
      await provider.provision(makeFixedConfig('120:apiCode:14094'), ctx);

      expect(mockClient.addEsimOrder).toHaveBeenCalledWith(
        expect.objectContaining({ priceId: '14094' }),
      );
    });

    it('sets skuId from the first part', async () => {
      await provider.provision(makeFixedConfig('120:apiCode:14094'), ctx);

      expect(mockClient.addEsimOrder).toHaveBeenCalledWith(
        expect.objectContaining({ skuId: '120' }),
      );
    });

    it('returns a valid EsimProvisionResult', async () => {
      const result = await provider.provision(makeFixedConfig('120:apiCode:14094'), ctx);

      expect(result).toMatchObject({
        vendorOrderId: 'EP-001',
        lpa: 'LPA:1$smdp.io$ACTCODE',
        activationCode: 'ACTCODE',
        iccid: '8901000000000000001',
      });
    });

    it('passes customerEmail to addEsimOrder', async () => {
      await provider.provision(makeFixedConfig('120:apiCode:14094'), ctx);

      expect(mockClient.addEsimOrder).toHaveBeenCalledWith(
        expect.objectContaining({ customerEmail: 'traveler@example.com' }),
      );
    });

    it('sets backInfo to "1" for one-step flow', async () => {
      await provider.provision(makeFixedConfig('120:apiCode:14094'), ctx);

      expect(mockClient.addEsimOrder).toHaveBeenCalledWith(
        expect.objectContaining({ backInfo: '1' }),
      );
    });
  });

  // ── Fixed package — legacy 2-part SKU ────────────────────────────────

  describe('fixed package — 2-part (legacy) providerSku', () => {
    it('falls back to apiCode as priceId when no 3rd part', async () => {
      await provider.provision(makeFixedConfig('156:14791'), ctx);

      expect(mockClient.addEsimOrder).toHaveBeenCalledWith(
        expect.objectContaining({ priceId: '14791', skuId: '156' }),
      );
    });
  });

  // ── Daypass — missing daysCount ───────────────────────────────────────

  describe('daypass package — missing daysCount', () => {
    it('throws MappingError when daysCount is undefined', async () => {
      await expect(
        provider.provision(makeDaypassConfig('120:826-0-?-1-G-D:14094', undefined), ctx),
      ).rejects.toThrow(MappingError);
    });

    it('throws MappingError when daysCount is null', async () => {
      await expect(
        provider.provision(
          { providerSku: '120:826-0-?-1-G-D:14094', packageType: 'daypass', daysCount: null },
          ctx,
        ),
      ).rejects.toThrow(MappingError);
    });

    it('error message mentions daysCount', async () => {
      await expect(
        provider.provision(makeDaypassConfig('120:826-0-?-1-G-D:14094'), ctx),
      ).rejects.toThrow('daysCount');
    });
  });

  // ── Daypass — 3-part SKU (stored priceId, no API call needed) ─────────

  describe('daypass package — 3-part SKU with stored priceId', () => {
    it('uses stored priceId without calling getPackages', async () => {
      await provider.provision(makeDaypassConfig('120:826-0-?-1-G-D:14094', 7), ctx);

      expect(mockClient.getPackages).not.toHaveBeenCalled();
      expect(mockClient.addEsimOrder).toHaveBeenCalledWith(
        expect.objectContaining({ priceId: '14094' }),
      );
    });

    it('sets daypassDays in the order payload', async () => {
      await provider.provision(makeDaypassConfig('120:826-0-?-1-G-D:14094', 7), ctx);

      expect(mockClient.addEsimOrder).toHaveBeenCalledWith(
        expect.objectContaining({ daypassDays: '7' }),
      );
    });
  });

  // ── Daypass — legacy 2-part SKU (requires getPackages lookup) ─────────

  describe('daypass package — 2-part legacy SKU (requires getPackages)', () => {
    const legacyDaypassConfig = makeDaypassConfig('120:826-0-?-1-G-D', 7);

    it('throws VendorError when getPackages returns no packageData', async () => {
      mockClient.getPackages.mockResolvedValue({ packageData: null, error: 'fetch failed' });

      await expect(provider.provision(legacyDaypassConfig, ctx)).rejects.toThrow(VendorError);
    });

    it('VendorError message includes skuId and original error', async () => {
      mockClient.getPackages.mockResolvedValue({ packageData: null, error: 'timeout' });

      await expect(provider.provision(legacyDaypassConfig, ctx)).rejects.toThrow('timeout');
    });

    it('uses "Unknown error" fallback when getPackages error field is null', async () => {
      mockClient.getPackages.mockResolvedValue({ packageData: null, error: '' });

      await expect(provider.provision(legacyDaypassConfig, ctx)).rejects.toThrow('Unknown error');
    });

    it('handles missing esimPackageDtoList (uses || [] fallback)', async () => {
      mockClient.getPackages.mockResolvedValue({
        packageData: {
          /* no esimPackageDtoList */
        },
        error: null,
      });

      await expect(provider.provision(legacyDaypassConfig, ctx)).rejects.toThrow(MappingError);
    });
    it('throws MappingError when package list is empty', async () => {
      mockClient.getPackages.mockResolvedValue({
        packageData: { esimPackageDtoList: [] },
        error: null,
      });

      await expect(provider.provision(legacyDaypassConfig, ctx)).rejects.toThrow(MappingError);
    });

    it('MappingError message mentions matching package not found', async () => {
      mockClient.getPackages.mockResolvedValue({
        packageData: { esimPackageDtoList: [] },
        error: null,
      });

      await expect(provider.provision(legacyDaypassConfig, ctx)).rejects.toThrow(
        'No matching daypass package',
      );
    });

    it('throws MappingError when no package apiCode or supportDaypass matches', async () => {
      mockClient.getPackages.mockResolvedValue({
        packageData: {
          esimPackageDtoList: [
            // Wrong apiCode, wrong flows
            { apiCode: 'totally-different', priceid: 99, supportDaypass: 0, flows: 99 },
          ],
        },
        error: null,
      });

      await expect(provider.provision(legacyDaypassConfig, ctx)).rejects.toThrow(MappingError);
    });

    it('finds package by exact apiCode match (? replaced with daysCount)', async () => {
      mockClient.getPackages.mockResolvedValue({
        packageData: {
          esimPackageDtoList: [
            { apiCode: '826-0-7-1-G-D', priceid: 99, supportDaypass: 1, flows: 1 },
          ],
        },
        error: null,
      });

      await provider.provision(legacyDaypassConfig, ctx);

      expect(mockClient.addEsimOrder).toHaveBeenCalledWith(
        expect.objectContaining({ priceId: '99', daypassDays: '7' }),
      );
    });

    it('falls back to supportDaypass=1 + matching flows when apiCode does not match', async () => {
      // apiCode won't match '826-0-7-1-G-D', but supportDaypass=1 and flows=1 matches
      // The fallback logic: pkg.supportDaypass === 1 && pkg.flows === parseInt(apiCode.split('-')[3])
      // apiCode = '826-0-?-1-G-D', parts[3] = '1', so flows must be 1
      mockClient.getPackages.mockResolvedValue({
        packageData: {
          esimPackageDtoList: [
            { apiCode: 'non-matching-code', priceid: 77, supportDaypass: 1, flows: 1 },
          ],
        },
        error: null,
      });

      await provider.provision(legacyDaypassConfig, ctx);

      expect(mockClient.addEsimOrder).toHaveBeenCalledWith(
        expect.objectContaining({ priceId: '77' }),
      );
    });

    it('calls getPackages with the skuId', async () => {
      mockClient.getPackages.mockResolvedValue({
        packageData: {
          esimPackageDtoList: [
            { apiCode: '826-0-7-1-G-D', priceid: 55, supportDaypass: 1, flows: 1 },
          ],
        },
        error: null,
      });

      await provider.provision(legacyDaypassConfig, ctx);

      expect(mockClient.getPackages).toHaveBeenCalledWith('120');
    });
  });

  // ── addEsimOrder failure handling ─────────────────────────────────────

  describe('addEsimOrder failure handling', () => {
    it('throws VendorError when canonical is null', async () => {
      mockClient.addEsimOrder.mockResolvedValue({
        canonical: null,
        db: null,
        raw: { code: 1, data: null },
        error: 'Quota exceeded',
      });

      await expect(provider.provision(makeFixedConfig('120:apiCode:14094'), ctx)).rejects.toThrow(
        VendorError,
      );
    });

    it('includes FiRoam error message in the VendorError', async () => {
      mockClient.addEsimOrder.mockResolvedValue({
        canonical: null,
        db: null,
        raw: {},
        error: 'Rate limit exceeded',
      });

      await expect(provider.provision(makeFixedConfig('120:apiCode:14094'), ctx)).rejects.toThrow(
        'FiRoam error: Rate limit exceeded',
      );
    });

    it('uses default message when error field is null', async () => {
      mockClient.addEsimOrder.mockResolvedValue({
        canonical: null,
        db: null,
        raw: {},
        error: null,
      });

      await expect(provider.provision(makeFixedConfig('120:apiCode:14094'), ctx)).rejects.toThrow(
        'FiRoam returned unexpected response',
      );
    });

    it('throws VendorError when db is null (even if canonical present)', async () => {
      mockClient.addEsimOrder.mockResolvedValue({
        canonical: { lpa: 'LPA:1$smdp.io$ACT', activationCode: 'ACT', iccid: '890123' },
        db: null,
        raw: {},
        error: null,
      });

      await expect(provider.provision(makeFixedConfig('120:apiCode:14094'), ctx)).rejects.toThrow(
        VendorError,
      );
    });
  });

  // ── vendorOrderId extraction ──────────────────────────────────────────

  describe('vendorOrderId extraction', () => {
    it('throws VendorError when raw.data has no orderNum', async () => {
      mockClient.addEsimOrder.mockResolvedValue({
        canonical: { lpa: 'LPA:1$smdp.io$ACT', activationCode: 'ACT', iccid: '890123' },
        db: { id: 'db-1' },
        raw: { code: 0, data: {} }, // data object present but no orderNum
        error: null,
      });

      await expect(provider.provision(makeFixedConfig('120:apiCode:14094'), ctx)).rejects.toThrow(
        VendorError,
      );
    });

    it('throws VendorError with message about missing order number', async () => {
      mockClient.addEsimOrder.mockResolvedValue({
        canonical: { lpa: 'LPA:1$smdp.io$ACT', activationCode: 'ACT', iccid: '890123' },
        db: { id: 'db-1' },
        raw: { code: 0, data: null },
        error: null,
      });

      await expect(provider.provision(makeFixedConfig('120:apiCode:14094'), ctx)).rejects.toThrow(
        'No order number',
      );
    });

    it('accepts a raw string as vendorOrderId (direct-string data)', async () => {
      mockClient.addEsimOrder.mockResolvedValue({
        canonical: { lpa: 'LPA:1$smdp.io$ACT', activationCode: 'ACT', iccid: '890123' },
        db: { id: 'db-1' },
        raw: { code: 0, data: 'EP-STRING-ORDER-007' },
        error: null,
      });

      const result = await provider.provision(makeFixedConfig('120:apiCode:14094'), ctx);
      expect(result.vendorOrderId).toBe('EP-STRING-ORDER-007');
    });

    it('extracts orderNum from a data object', async () => {
      mockClient.addEsimOrder.mockResolvedValue(makeOrderSuccess({ orderNum: 'EP-999' }));

      const result = await provider.provision(makeFixedConfig('120:apiCode:14094'), ctx);
      expect(result.vendorOrderId).toBe('EP-999');
    });
  });

  // ── Catalog-linked path ───────────────────────────────────────────────

  describe('catalog-linked path (providerCatalogId set)', () => {
    const catalogConfig: ProviderMappingConfig = {
      providerSku: '', // ignored when catalog ID is set
      providerCatalogId: 'cat-001',
      packageType: 'fixed',
    };

    beforeEach(() => {
      mockFindUniqueOrThrow.mockResolvedValue({
        productCode: '826-0-?-1-G-D',
        skuId: '120',
        rawPayload: { skuId: 120, priceid: 14094 },
      });
    });

    it('looks up catalog entry by providerCatalogId', async () => {
      await provider.provision(catalogConfig, ctx);

      expect(mockFindUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 'cat-001' } });
    });

    it('uses skuId from top-level column and priceId from rawPayload', async () => {
      await provider.provision(catalogConfig, ctx);

      expect(mockClient.addEsimOrder).toHaveBeenCalledWith(
        expect.objectContaining({ skuId: '120', priceId: '14094' }),
      );
    });

    it('throws MappingError when skuId column is empty string', async () => {
      mockFindUniqueOrThrow.mockResolvedValue({
        productCode: '826-0-?-1-G-D',
        skuId: '', // missing — empty default
        rawPayload: { priceid: 14094 },
      });

      await expect(provider.provision(catalogConfig, ctx)).rejects.toThrow(MappingError);
    });

    it('returns a valid EsimProvisionResult from catalog path', async () => {
      const result = await provider.provision(catalogConfig, ctx);

      expect(result).toMatchObject({
        vendorOrderId: 'EP-001',
        lpa: 'LPA:1$smdp.io$ACTCODE',
        activationCode: 'ACTCODE',
        iccid: '8901000000000000001',
      });
    });

    it('uses apiCode as priceId when priceid is absent in catalog rawPayload (fixed pkg)', async () => {
      mockFindUniqueOrThrow.mockResolvedValue({
        productCode: 'MY-API-CODE',
        skuId: '120',
        rawPayload: { skuId: 120 }, // no priceid
      });

      await provider.provision({ ...catalogConfig, packageType: 'fixed' }, ctx);

      // storedPriceId = null → fixed pkg fallback: priceId = apiCode
      expect(mockClient.addEsimOrder).toHaveBeenCalledWith(
        expect.objectContaining({ priceId: 'MY-API-CODE' }),
      );
    });
  });

  // ── Full happy-path result shape ──────────────────────────────────────

  describe('EsimProvisionResult completeness', () => {
    it('result contains all required fields', async () => {
      const result = await provider.provision(makeFixedConfig('120:apiCode:14094'), ctx);

      expect(typeof result.vendorOrderId).toBe('string');
      expect(typeof result.lpa).toBe('string');
      expect(typeof result.activationCode).toBe('string');
      expect(typeof result.iccid).toBe('string');
    });

    it('falls back to empty string for null lpa in canonical', async () => {
      mockClient.addEsimOrder.mockResolvedValue({
        canonical: { lpa: null, activationCode: null, iccid: null },
        db: { id: 'db-1' },
        raw: { code: 0, data: { orderNum: 'EP-001' } },
        error: null,
      });

      const result = await provider.provision(makeFixedConfig('120:apiCode:14094'), ctx);
      expect(result.lpa).toBe('');
      expect(result.activationCode).toBe('');
      expect(result.iccid).toBe('');
    });
  });
});
