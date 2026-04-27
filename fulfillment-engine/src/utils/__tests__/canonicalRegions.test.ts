import { describe, it, expect } from 'vitest';
import { findCanonicalSubsetTag, findProductNameTag } from '~/utils/canonicalRegions';

describe('findCanonicalSubsetTag', () => {
  it('tags a pure GCC pack as GCC', () => {
    expect(findCanonicalSubsetTag(['SA', 'AE', 'BH', 'KW', 'OM', 'QA'])).toEqual({
      tag: 'GCC',
      parent: 'GCC',
    });
  });

  it('tags a partial GCC pack (subset of GCC) as GCC', () => {
    // TGT pack from real data — 5 of 6 GCC countries
    expect(findCanonicalSubsetTag(['AE', 'BH', 'KW', 'QA', 'SA'])).toEqual({
      tag: 'GCC',
      parent: 'GCC',
    });
  });

  it('tags a 9-country Middle East pack as ME (not GCC, since some countries are not GCC)', () => {
    // FiRoam Middle East pack from real data
    expect(findCanonicalSubsetTag(['AE', 'BH', 'EG', 'IQ', 'JO', 'OM', 'QA', 'SA', 'TR'])).toEqual({
      tag: 'ME',
      parent: 'ME',
    });
  });

  it('tags a Nordic pack as NORDIC', () => {
    expect(findCanonicalSubsetTag(['SE', 'NO', 'DK', 'FI', 'IS'])).toEqual({
      tag: 'NORDIC',
      parent: 'EU',
    });
  });

  it('tags Benelux as BENELUX', () => {
    expect(findCanonicalSubsetTag(['BE', 'NL', 'LU'])).toEqual({
      tag: 'BENELUX',
      parent: 'EU',
    });
  });

  it('tags an EU-only pack as EU (subset of EU_27)', () => {
    expect(findCanonicalSubsetTag(['DE', 'FR', 'IT', 'ES'])).toEqual({
      tag: 'EU',
      parent: 'EU',
    });
  });

  it('tags an EU + UK + CH pack as EEA (escapes EU but fits EEA_PLUS)', () => {
    expect(findCanonicalSubsetTag(['DE', 'FR', 'GB', 'CH'])).toEqual({
      tag: 'EEA',
      parent: 'EU',
    });
  });

  it('tags ASEAN as ASEAN', () => {
    expect(findCanonicalSubsetTag(['SG', 'TH', 'MY', 'ID'])).toEqual({
      tag: 'ASEAN',
      parent: 'ASIA',
    });
  });

  it('tags ANZ as ANZ', () => {
    expect(findCanonicalSubsetTag(['AU', 'NZ'])).toEqual({
      tag: 'ANZ',
      parent: 'OCEANIA',
    });
  });

  it('returns null for a 130-country global pack (not subset of anything specific)', () => {
    const big = [
      'DE',
      'FR',
      'JP',
      'US',
      'BR',
      'AR',
      'KE',
      'ZA',
      'CN',
      'IN',
      'AU',
      'CA',
      'MX',
      'NG',
      'EG',
      'TR',
      'IR',
      'TH',
      'VN',
      'ID',
      'PH',
      'SG',
      'MY',
      'KR',
    ];
    expect(findCanonicalSubsetTag(big)).toBeNull();
  });

  it('returns null when the row mixes regions (not subset of any single canonical set)', () => {
    // One GCC country + one EU country → not a subset of GCC or EU alone
    expect(findCanonicalSubsetTag(['SA', 'DE'])).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(findCanonicalSubsetTag([])).toBeNull();
  });

  it('prefers most specific (GCC over ME) when both would match', () => {
    // [SA, AE] is subset of BOTH GCC and ME; GCC has 6 countries, ME has 16,
    // so GCC wins because the table is sorted ascending by size.
    expect(findCanonicalSubsetTag(['SA', 'AE'])).toEqual({
      tag: 'GCC',
      parent: 'GCC',
    });
  });
});

describe('findProductNameTag', () => {
  it('tags global packs as GLOBAL', () => {
    expect(findProductNameTag('Global - 3GB 30D')).toEqual({
      tag: 'GLOBAL',
      parent: 'GLOBAL',
    });
    expect(findProductNameTag('Worldwide unlimited')).toEqual({
      tag: 'GLOBAL',
      parent: 'GLOBAL',
    });
  });

  it('tags Middle East before Asia (more specific keyword wins)', () => {
    expect(findProductNameTag('West Asia + Middle East 8 countries')).toEqual({
      tag: 'ME',
      parent: 'ME',
    });
  });

  it('tags GCC packs as GCC', () => {
    expect(findProductNameTag('GCC 6 countries')).toEqual({
      tag: 'GCC',
      parent: 'GCC',
    });
    expect(findProductNameTag('Gulf Cooperation Council Plan')).toEqual({
      tag: 'GCC',
      parent: 'GCC',
    });
  });

  it('tags ASEAN packs as ASEAN', () => {
    expect(findProductNameTag('ASEAN 10 countries')).toEqual({
      tag: 'ASEAN',
      parent: 'ASIA',
    });
  });

  it('tags Nordic packs as NORDIC', () => {
    expect(findProductNameTag('Nordic countries pack')).toEqual({
      tag: 'NORDIC',
      parent: 'EU',
    });
  });

  it('tags Latam as LATAM (specific) before North America', () => {
    expect(findProductNameTag('Latin America 12 countries')).toEqual({
      tag: 'LATAM',
      parent: 'AMERICAS',
    });
    expect(findProductNameTag('LATAM unlimited')).toEqual({
      tag: 'LATAM',
      parent: 'AMERICAS',
    });
  });

  it('tags Caribbean as CARIBBEAN', () => {
    expect(findProductNameTag('Caribbean Islands eSIM')).toEqual({
      tag: 'CARIBBEAN',
      parent: 'AMERICAS',
    });
  });

  it('falls back to EU when product name says Europe', () => {
    expect(findProductNameTag('Europe 30 - 5GB')).toEqual({ tag: 'EU', parent: 'EU' });
  });

  it('returns null for product names with no region keyword', () => {
    expect(findProductNameTag('Random product 5GB')).toBeNull();
    expect(findProductNameTag('Premium plan')).toBeNull();
  });

  it('returns null for empty / non-string input', () => {
    expect(findProductNameTag('')).toBeNull();
    expect(findProductNameTag('   ')).toBeNull();
    expect(findProductNameTag(null)).toBeNull();
    expect(findProductNameTag(undefined)).toBeNull();
    expect(findProductNameTag(42)).toBeNull();
  });

  it('matches "AsiaN" without space (FiRoam quirk: "West Asia8", "Central Asia3")', () => {
    expect(findProductNameTag('West Asia8 - 5GB 30D')).toEqual({ tag: 'ASIA', parent: 'ASIA' });
    expect(findProductNameTag('Central Asia3 - ')).toEqual({ tag: 'ASIA', parent: 'ASIA' });
    expect(findProductNameTag('Asia30')).toEqual({ tag: 'ASIA', parent: 'ASIA' });
  });

  it('still does NOT match "Asian" (avoids false positive)', () => {
    expect(findProductNameTag('Asian Premium plan')).toBeNull();
    expect(findProductNameTag('Asiana airlines bundle')).toBeNull();
  });
});
