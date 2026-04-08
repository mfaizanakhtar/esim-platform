import { describe, it, expect } from 'vitest';
import { parseShopifySku } from '~/utils/parseShopifySku';

describe('parseShopifySku', () => {
  // Primary format: {REGION}-{DATA}-{VALIDITY}-{TYPE}
  it('parses FIXED GB SKU', () => {
    expect(parseShopifySku('SA-2GB-7D-FIXED')).toEqual({
      regionCode: 'SA',
      dataMb: 2048,
      validityDays: 7,
    });
  });

  it('parses DAYPASS MB SKU', () => {
    expect(parseShopifySku('EU-500MB-30D-DAYPASS')).toEqual({
      regionCode: 'EU',
      dataMb: 500,
      validityDays: 30,
    });
  });

  it('parses multi-letter region with type suffix', () => {
    expect(parseShopifySku('APAC-10GB-30D-FIXED')).toEqual({
      regionCode: 'APAC',
      dataMb: 10240,
      validityDays: 30,
    });
  });

  // Legacy format: ESIM-{REGION}-{DATA}-{VALIDITY}
  it('parses legacy ESIM-prefix GB SKU', () => {
    expect(parseShopifySku('ESIM-EU-1GB-7D')).toEqual({
      regionCode: 'EU',
      dataMb: 1024,
      validityDays: 7,
    });
  });

  it('parses legacy ESIM-prefix MB SKU', () => {
    expect(parseShopifySku('ESIM-US-500MB-30D')).toEqual({
      regionCode: 'US',
      dataMb: 500,
      validityDays: 30,
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
});
