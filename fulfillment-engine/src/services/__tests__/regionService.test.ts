import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindMany = vi.fn();

vi.mock('~/db/prisma', () => ({
  default: {
    providerSkuCatalog: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
  },
}));

import { buildRegionSuggestions, inferParentCode, normalizeLabel } from '~/services/regionService';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('normalizeLabel', () => {
  it('uppercases and trims', () => {
    expect(normalizeLabel('  europe  ')).toBe('EUROPE');
    expect(normalizeLabel('eu')).toBe('EU');
  });
});

describe('inferParentCode', () => {
  it('maps known aliases', () => {
    expect(inferParentCode('Europe')).toBe('EU');
    expect(inferParentCode('eu')).toBe('EU');
    expect(inferParentCode('APAC')).toBe('ASIA');
    expect(inferParentCode('Asia')).toBe('ASIA');
    expect(inferParentCode('Middle East')).toBe('ME');
    expect(inferParentCode('LATAM')).toBe('AMERICAS');
    expect(inferParentCode('Worldwide')).toBe('GLOBAL');
  });

  it('falls back to alphanumeric stripped + capped at 16 chars', () => {
    expect(inferParentCode('Some-Custom Region')).toBe('SOMECUSTOMREGION');
    expect(inferParentCode('A really super extra long label')).toBe('AREALLYSUPEREXTR');
  });

  it('returns OTHER for too-short labels', () => {
    expect(inferParentCode('!')).toBe('OTHER');
  });
});

/**
 * Build a catalog row mirror that matches the schema fields the discovery uses.
 * Defaults to no region label and no parsedJson — caller specifies what matters.
 */
function row(opts: {
  provider: string;
  countryCodes: string[];
  region?: string | null;
  productName?: string | null;
  parsedJson?: { regionCodes?: string[]; dataMb?: number; validityDays?: number } | null;
}) {
  return {
    provider: opts.provider,
    productName: opts.productName ?? null,
    region: opts.region ?? null,
    countryCodes: opts.countryCodes,
    parsedJson: opts.parsedJson ?? null,
  };
}

describe('buildRegionSuggestions — filter & grouping', () => {
  it('produces an empty list when catalog has no entries', async () => {
    mockFindMany.mockResolvedValue([]);
    expect(await buildRegionSuggestions()).toEqual([]);
  });

  it('skips single-country rows (regional plans = 2+ countries)', async () => {
    mockFindMany.mockResolvedValue([
      // FiRoam stores `region` = country code for single-country plans — must NOT
      // be treated as regional discovery candidates.
      row({ provider: 'firoam', region: 'DE', countryCodes: ['DE'] }),
      row({ provider: 'firoam', region: 'FR', countryCodes: ['FR'] }),
      row({ provider: 'tgt', region: null, countryCodes: ['JP'] }),
    ]);
    expect(await buildRegionSuggestions()).toEqual([]);
  });

  it('discovers multi-country rows even when `region` is null (TGT case)', async () => {
    // TGT sync hard-codes region: null, so discovery must NOT depend on it.
    mockFindMany.mockResolvedValue([
      row({ provider: 'tgt', region: null, countryCodes: ['DE', 'FR', 'AT'] }),
    ]);
    const groups = await buildRegionSuggestions();
    expect(groups).toHaveLength(1);
    expect(groups[0].providers[0].provider).toBe('tgt');
    expect(groups[0].providers[0].countries).toEqual(['AT', 'DE', 'FR']);
  });

  it('uses parsedJson.regionCodes[0] as the group label when available', async () => {
    mockFindMany.mockResolvedValue([
      row({
        provider: 'firoam',
        region: null,
        countryCodes: ['DE', 'FR', 'AT'],
        parsedJson: { regionCodes: ['EU'] },
      }),
      row({
        provider: 'tgt',
        region: null,
        countryCodes: ['DE', 'FR', 'BE'],
        parsedJson: { regionCodes: ['EU'] },
      }),
    ]);
    const groups = await buildRegionSuggestions();
    // Both rows tagged "EU" by the parser → grouped together
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('EU');
    expect(groups[0].parentCode).toBe('EU');
    expect(groups[0].providers).toHaveLength(2);
  });

  it('falls back to vendor `region` when parsedJson missing AND region is multi-char', async () => {
    mockFindMany.mockResolvedValue([
      row({ provider: 'firoam', region: 'GCC', countryCodes: ['SA', 'AE', 'QA'] }),
    ]);
    const groups = await buildRegionSuggestions();
    expect(groups[0].label).toBe('GCC');
    expect(groups[0].parentCode).toBe('GCC');
  });

  it('does NOT use vendor `region` when it looks like a 2-letter ISO country code', async () => {
    // FiRoam may set region = 'BR' for a single-country plan; if a row has 3
    // countries with region='BR', region is misleading. Use countries that
    // don't match any canonical region and lack productName/keyword to verify
    // we fall through to MULTI-N.
    mockFindMany.mockResolvedValue([
      row({ provider: 'firoam', region: 'BR', countryCodes: ['BR', 'NG', 'KE'] }),
    ]);
    const groups = await buildRegionSuggestions();
    expect(groups[0].label).toBe('MULTI-3');
  });

  it('synthesizes MULTI-N label when no region info available', async () => {
    mockFindMany.mockResolvedValue([
      // Mix from disjoint regions so no canonical subset matches.
      row({ provider: 'tgt', region: null, countryCodes: ['BR', 'NG', 'KE', 'ZA'] }),
    ]);
    const groups = await buildRegionSuggestions();
    expect(groups[0].label).toBe('MULTI-4');
    expect(groups[0].parentCode).toBe('MULTI4');
  });

  it('Tier 2: tags a pure GCC pack as GCC even when vendor region is misleading', async () => {
    mockFindMany.mockResolvedValue([
      // TGT real-world case: 5-country GCC pack, vendor region null, parsedJson
      // is an enumeration (the broken parser output).
      row({
        provider: 'tgt',
        region: null,
        countryCodes: ['AE', 'BH', 'KW', 'QA', 'SA'],
        parsedJson: { regionCodes: ['QA', 'AE', 'BH', 'KW', 'SA'] },
      }),
    ]);
    const groups = await buildRegionSuggestions();
    expect(groups[0].label).toBe('GCC');
    expect(groups[0].parentCode).toBe('GCC');
  });

  it('Tier 2: tags 9-country Middle East pack as ME (subset of ME, not GCC)', async () => {
    mockFindMany.mockResolvedValue([
      row({
        provider: 'firoam',
        region: null,
        countryCodes: ['AE', 'BH', 'EG', 'IQ', 'JO', 'OM', 'QA', 'SA', 'TR'],
        parsedJson: {
          regionCodes: ['AE', 'BH', 'EG', 'IQ', 'JO', 'OM', 'QA', 'SA', 'TR'],
        },
      }),
    ]);
    const groups = await buildRegionSuggestions();
    expect(groups[0].label).toBe('ME');
    expect(groups[0].parentCode).toBe('ME');
  });

  it('Tier 3: tags 130-country Global pack via productName keyword', async () => {
    // 130 mixed countries — not a subset of any canonical region.
    const big = Array.from({ length: 130 }, (_, i) => {
      const a = String.fromCharCode(65 + Math.floor(i / 26));
      const b = String.fromCharCode(65 + (i % 26));
      return a + b;
    });
    mockFindMany.mockResolvedValue([
      row({
        provider: 'firoam',
        region: null,
        productName: 'Global - 5GB 30D',
        countryCodes: big,
        parsedJson: { regionCodes: big },
      }),
    ]);
    const groups = await buildRegionSuggestions();
    expect(groups[0].label).toBe('GLOBAL');
    expect(groups[0].parentCode).toBe('GLOBAL');
  });

  it('Tier 1 (single-entry parsedJson) still wins for clean parser output', async () => {
    mockFindMany.mockResolvedValue([
      // parsedJson tagged "GLOBAL" — single canonical entry → trust it
      row({
        provider: 'firoam',
        region: null,
        countryCodes: ['BR', 'NG', 'KE'],
        parsedJson: { regionCodes: ['GLOBAL'] },
      }),
    ]);
    const groups = await buildRegionSuggestions();
    expect(groups[0].label).toBe('GLOBAL');
  });

  it('multi-entry parsedJson.regionCodes (enumeration) is ignored — Tier 2 catches it', async () => {
    mockFindMany.mockResolvedValue([
      row({
        provider: 'firoam',
        region: null,
        // Parser returned 5-element enumeration (the broken case)
        countryCodes: ['AE', 'BH', 'KW', 'QA', 'SA'],
        parsedJson: { regionCodes: ['AE', 'BH', 'KW', 'QA', 'SA'] },
      }),
    ]);
    const groups = await buildRegionSuggestions();
    // Should NOT label as 'AE' (the first enumerated entry) — falls through
    // to canonical subset match → GCC
    expect(groups[0].label).toBe('GCC');
  });

  it('groups same-label rows from multiple providers into one group', async () => {
    mockFindMany.mockResolvedValue([
      row({
        provider: 'firoam',
        region: null,
        countryCodes: ['DE', 'FR', 'AT'],
        parsedJson: { regionCodes: ['EU'] },
      }),
      row({
        provider: 'firoam',
        region: null,
        countryCodes: ['fr', 'AT', 'DE'], // overlap, lowercase
        parsedJson: { regionCodes: ['EU'] },
      }),
      row({
        provider: 'tgt',
        region: null,
        countryCodes: ['DE', 'BE'],
        parsedJson: { regionCodes: ['EU'] },
      }),
    ]);
    const [eu] = await buildRegionSuggestions();
    expect(eu.label).toBe('EU');

    const firoam = eu.providers.find((p) => p.provider === 'firoam')!;
    expect(firoam.countries).toEqual(['AT', 'DE', 'FR']);
    expect(firoam.skuCount).toBe(2);

    const tgt = eu.providers.find((p) => p.provider === 'tgt')!;
    expect(tgt.countries).toEqual(['BE', 'DE']);
    expect(tgt.skuCount).toBe(1);
  });
});

describe('buildRegionSuggestions — intersection / union / suggestions', () => {
  it('computes intersection across providers', async () => {
    mockFindMany.mockResolvedValue([
      row({ provider: 'firoam', region: 'EU', countryCodes: ['DE', 'FR', 'AT'] }),
      row({ provider: 'tgt', region: 'EU', countryCodes: ['DE', 'FR', 'BE'] }),
    ]);
    const [eu] = await buildRegionSuggestions();
    expect(eu.intersection).toEqual(['DE', 'FR']);
  });

  it('computes union across providers', async () => {
    mockFindMany.mockResolvedValue([
      row({ provider: 'firoam', region: 'EU', countryCodes: ['DE', 'FR', 'AT'] }),
      row({ provider: 'tgt', region: 'EU', countryCodes: ['DE', 'BE'] }),
    ]);
    const [eu] = await buildRegionSuggestions();
    expect(eu.union).toEqual(['AT', 'BE', 'DE', 'FR']);
  });

  it('emits an INTERSECTION suggestion when ≥2 countries are common', async () => {
    mockFindMany.mockResolvedValue([
      row({ provider: 'firoam', region: 'EU', countryCodes: ['DE', 'FR', 'AT'] }),
      row({ provider: 'tgt', region: 'EU', countryCodes: ['DE', 'FR', 'BE'] }),
    ]);
    const [eu] = await buildRegionSuggestions();
    const intersect = eu.suggestions.find((s) => s.kind === 'INTERSECTION');
    expect(intersect).toMatchObject({
      code: 'EU2',
      parentCode: 'EU',
      countryCodes: ['DE', 'FR'],
      providersAvailable: ['firoam', 'tgt'],
    });
  });

  it('emits a UNION suggestion when union is larger than intersection', async () => {
    mockFindMany.mockResolvedValue([
      row({ provider: 'firoam', region: 'EU', countryCodes: ['DE', 'FR', 'AT'] }),
      row({ provider: 'tgt', region: 'EU', countryCodes: ['DE', 'BE'] }),
    ]);
    const [eu] = await buildRegionSuggestions();
    const union = eu.suggestions.find((s) => s.kind === 'UNION');
    expect(union).toMatchObject({
      code: 'EU4',
      countryCodes: ['AT', 'BE', 'DE', 'FR'],
      kind: 'UNION',
    });
    // No single provider covers all 4 → providersAvailable is empty
    expect(union!.providersAvailable).toEqual([]);
  });

  it('lists providersAvailable for UNION when one provider covers everything', async () => {
    mockFindMany.mockResolvedValue([
      row({ provider: 'firoam', region: 'EU', countryCodes: ['DE', 'FR', 'AT', 'BE'] }),
      row({ provider: 'tgt', region: 'EU', countryCodes: ['DE', 'BE'] }),
    ]);
    const [eu] = await buildRegionSuggestions();
    const union = eu.suggestions.find((s) => s.kind === 'UNION');
    expect(union!.providersAvailable).toEqual(['firoam']);
  });

  it('drops UNION suggestions exceeding unionLimit', async () => {
    const twentyCountries = Array.from(
      { length: 20 },
      (_, i) => String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)),
    );
    mockFindMany.mockResolvedValue([
      row({ provider: 'firoam', region: 'GLOBAL', countryCodes: twentyCountries }),
      row({ provider: 'tgt', region: 'GLOBAL', countryCodes: ['US', 'JP'] }),
    ]);
    const [global] = await buildRegionSuggestions({ unionLimit: 10 });
    expect(global.suggestions.find((s) => s.kind === 'UNION')).toBeUndefined();
  });

  it('does NOT emit an INTERSECTION suggestion when fewer than 2 countries are common', async () => {
    // Both rows are EU-subset (so they group under 'EU') but their countries
    // don't overlap → intersection empty. Pick countries that match EU only,
    // NOT smaller canonical sets like BENELUX, otherwise they'd split into
    // separate groups.
    mockFindMany.mockResolvedValue([
      row({ provider: 'firoam', region: 'EU', countryCodes: ['DE', 'IT'] }),
      row({ provider: 'tgt', region: 'EU', countryCodes: ['ES', 'FR'] }),
    ]);
    const [eu] = await buildRegionSuggestions();
    expect(eu.suggestions.find((s) => s.kind === 'INTERSECTION')).toBeUndefined();
  });
});

describe('buildRegionSuggestions — edge cases', () => {
  it('skips rows whose only valid country codes are <2 after normalization', async () => {
    // Only "DE" is valid; "GERMANY" and "fr-INVALID" are not 2-letter ISO codes
    // → ends up as 1 valid country → filtered out.
    mockFindMany.mockResolvedValue([
      row({ provider: 'firoam', region: 'EU', countryCodes: ['DE', 'GERMANY', 'fr-INVALID'] }),
    ]);
    expect(await buildRegionSuggestions()).toEqual([]);
  });

  it('keeps rows when at least 2 codes survive normalization', async () => {
    mockFindMany.mockResolvedValue([
      row({ provider: 'firoam', region: 'EU', countryCodes: ['DE', 'GERMANY', 'fr', 'AT'] }),
    ]);
    const [eu] = await buildRegionSuggestions();
    expect(eu.providers[0].countries).toEqual(['AT', 'DE', 'FR']);
  });

  it('sorts groups alphabetically by label', async () => {
    mockFindMany.mockResolvedValue([
      // Each row's countries match a different canonical subset → labeled
      // GCC, ASEAN, EU respectively. Verify alphabetical sort.
      row({ provider: 'firoam', region: null, countryCodes: ['SA', 'AE', 'QA'] }),
      row({ provider: 'firoam', region: null, countryCodes: ['SG', 'TH', 'MY'] }),
      row({ provider: 'firoam', region: null, countryCodes: ['DE', 'FR', 'AT'] }),
    ]);
    const groups = await buildRegionSuggestions();
    expect(groups.map((g) => g.label)).toEqual(['ASEAN', 'EU', 'GCC']);
  });

  it('canonical subset takes priority over vendor label — different vendor labels merge into one group', async () => {
    // Both rows are EU subsets — even though FiRoam tags 'EU' and TGT tags
    // 'Europe', the canonical subset matcher unifies them into a single 'EU'
    // group. This is the new behavior: we DO want cross-vendor merging when
    // the underlying coverage matches a canonical region.
    mockFindMany.mockResolvedValue([
      row({ provider: 'firoam', region: 'EU', countryCodes: ['DE', 'FR'] }),
      row({ provider: 'tgt', region: 'Europe', countryCodes: ['DE', 'BE'] }),
    ]);
    const groups = await buildRegionSuggestions();
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('EU');
    expect(groups[0].parentCode).toBe('EU');
    expect(groups[0].providers).toHaveLength(2);
  });
});
