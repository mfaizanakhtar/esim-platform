import { describe, it, expect } from 'vitest';
import { parseShopifySku } from '~/utils/parseShopifySku';

describe('parseShopifySku', () => {
  it('parses GB SKU', () => {
    expect(parseShopifySku('ESIM-EU-1GB-7D')).toEqual({
      regionCode: 'EU',
      dataMb: 1024,
      validityDays: 7,
    });
  });

  it('parses MB SKU', () => {
    expect(parseShopifySku('ESIM-US-500MB-30D')).toEqual({
      regionCode: 'US',
      dataMb: 500,
      validityDays: 30,
    });
  });

  it('parses multi-letter region', () => {
    expect(parseShopifySku('ESIM-APAC-10GB-30D')).toEqual({
      regionCode: 'APAC',
      dataMb: 10240,
      validityDays: 30,
    });
  });

  it('returns null for lowercase', () => {
    expect(parseShopifySku('esim-eu-1gb-7d')).toBeNull();
  });

  it('returns null when validity is missing', () => {
    expect(parseShopifySku('ESIM-EU-1GB')).toBeNull();
  });

  it('returns null when prefix is missing', () => {
    expect(parseShopifySku('EU-1GB-7D')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseShopifySku('')).toBeNull();
  });

  it('returns null for arbitrary string', () => {
    expect(parseShopifySku('SOME-RANDOM-SKU')).toBeNull();
  });
});
