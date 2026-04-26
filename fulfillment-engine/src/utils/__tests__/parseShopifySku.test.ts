import { describe, it, expect } from 'vitest';
import { parseShopifySku } from '~/utils/parseShopifySku';

describe('parseShopifySku', () => {
  // Primary format: {REGION}-{DATA}-{VALIDITY}-{TYPE}
  it('parses FIXED GB SKU', () => {
    expect(parseShopifySku('SA-2GB-7D-FIXED')).toEqual({
      regionCode: 'SA',
      dataMb: 2048,
      validityDays: 7,
      skuType: 'FIXED',
      kind: 'COUNTRY',
    });
  });

  it('parses DAYPASS MB SKU', () => {
    expect(parseShopifySku('EU-500MB-30D-DAYPASS')).toEqual({
      regionCode: 'EU',
      dataMb: 500,
      validityDays: 30,
      skuType: 'DAYPASS',
      kind: 'COUNTRY',
    });
  });

  it('parses multi-letter region with type suffix', () => {
    expect(parseShopifySku('APAC-10GB-30D-FIXED')).toEqual({
      regionCode: 'APAC',
      dataMb: 10240,
      validityDays: 30,
      skuType: 'FIXED',
      kind: 'COUNTRY',
    });
  });

  // Legacy format: ESIM-{REGION}-{DATA}-{VALIDITY}
  it('parses legacy ESIM-prefix GB SKU — defaults skuType to FIXED', () => {
    expect(parseShopifySku('ESIM-EU-1GB-7D')).toEqual({
      regionCode: 'EU',
      dataMb: 1024,
      validityDays: 7,
      skuType: 'FIXED',
      kind: 'COUNTRY',
    });
  });

  it('parses legacy ESIM-prefix MB SKU — defaults skuType to FIXED', () => {
    expect(parseShopifySku('ESIM-US-500MB-30D')).toEqual({
      regionCode: 'US',
      dataMb: 500,
      validityDays: 30,
      skuType: 'FIXED',
      kind: 'COUNTRY',
    });
  });

  it('parses legacy ESIM-prefix SKU with FIXED suffix', () => {
    expect(parseShopifySku('ESIM-EU-1GB-3D-FIXED')).toEqual({
      regionCode: 'EU',
      dataMb: 1024,
      validityDays: 3,
      skuType: 'FIXED',
      kind: 'COUNTRY',
    });
  });

  it('parses legacy ESIM-prefix SKU with DAYPASS suffix', () => {
    expect(parseShopifySku('ESIM-US-500MB-1D-DAYPASS')).toEqual({
      regionCode: 'US',
      dataMb: 500,
      validityDays: 1,
      skuType: 'DAYPASS',
      kind: 'COUNTRY',
    });
  });

  // REGION format: REGION-{REGION_CODE}-{DATA}-{VALIDITY}-{TYPE}
  it('parses REGION FIXED SKU', () => {
    expect(parseShopifySku('REGION-EU30-5GB-30D-FIXED')).toEqual({
      regionCode: 'EU30',
      dataMb: 5120,
      validityDays: 30,
      skuType: 'FIXED',
      kind: 'REGION',
    });
  });

  it('parses REGION DAYPASS SKU', () => {
    expect(parseShopifySku('REGION-ASIA4-1GB-1D-DAYPASS')).toEqual({
      regionCode: 'ASIA4',
      dataMb: 1024,
      validityDays: 1,
      skuType: 'DAYPASS',
      kind: 'REGION',
    });
  });

  it('parses REGION code with embedded dash', () => {
    expect(parseShopifySku('REGION-AMERICAS-NA3-2GB-7D-FIXED')).toEqual({
      regionCode: 'AMERICAS-NA3',
      dataMb: 2048,
      validityDays: 7,
      skuType: 'FIXED',
      kind: 'REGION',
    });
  });

  // Null cases
  it('returns null for lowercase', () => {
    expect(parseShopifySku('sa-2gb-7d-fixed')).toBeNull();
  });

  it('returns null when type suffix is missing', () => {
    expect(parseShopifySku('EU-1GB-7D')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseShopifySku('')).toBeNull();
  });

  it('returns null for arbitrary string', () => {
    expect(parseShopifySku('SOME-RANDOM-SKU')).toBeNull();
  });

  it('rejects unsupported type suffixes (only FIXED/DAYPASS allowed)', () => {
    expect(parseShopifySku('SA-2GB-7D-TRIAL')).toBeNull();
    expect(parseShopifySku('REGION-EU30-5GB-30D-BETA')).toBeNull();
    expect(parseShopifySku('ESIM-EU-1GB-7D-CUSTOM')).toBeNull();
  });
});
