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

describe('buildRegionSuggestions', () => {
  function entry(provider: string, region: string, countryCodes: string[]) {
    return { provider, region, countryCodes };
  }

  it('produces an empty list when catalog has no regional entries', async () => {
    mockFindMany.mockResolvedValue([]);
    const groups = await buildRegionSuggestions();
    expect(groups).toEqual([]);
  });

  it('groups by normalized label and dedupes country codes per provider', async () => {
    mockFindMany.mockResolvedValue([
      entry('firoam', 'EU', ['DE', 'FR']),
      entry('firoam', 'eu', ['fr', 'AT']), // same group, lowercase, overlap with FR
      entry('tgt', 'EU', ['DE', 'BE']),
    ]);

    const groups = await buildRegionSuggestions();
    expect(groups).toHaveLength(1);

    const eu = groups[0];
    expect(eu.label).toBe('EU');
    expect(eu.parentCode).toBe('EU');
    expect(eu.providers).toHaveLength(2);

    const firoam = eu.providers.find((p) => p.provider === 'firoam')!;
    expect(firoam.countries).toEqual(['AT', 'DE', 'FR']);
    expect(firoam.skuCount).toBe(2);

    const tgt = eu.providers.find((p) => p.provider === 'tgt')!;
    expect(tgt.countries).toEqual(['BE', 'DE']);
    expect(tgt.skuCount).toBe(1);
  });

  it('computes intersection across providers', async () => {
    mockFindMany.mockResolvedValue([
      entry('firoam', 'EU', ['DE', 'FR', 'AT']),
      entry('tgt', 'EU', ['DE', 'FR', 'BE']),
    ]);

    const [eu] = await buildRegionSuggestions();
    expect(eu.intersection).toEqual(['DE', 'FR']);
  });

  it('computes union across providers', async () => {
    mockFindMany.mockResolvedValue([
      entry('firoam', 'EU', ['DE', 'FR', 'AT']),
      entry('tgt', 'EU', ['DE', 'BE']),
    ]);

    const [eu] = await buildRegionSuggestions();
    expect(eu.union).toEqual(['AT', 'BE', 'DE', 'FR']);
  });

  it('emits an INTERSECTION suggestion when ≥2 countries are common', async () => {
    mockFindMany.mockResolvedValue([
      entry('firoam', 'EU', ['DE', 'FR', 'AT']),
      entry('tgt', 'EU', ['DE', 'FR', 'BE']),
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

  it('does NOT emit an INTERSECTION suggestion when fewer than 2 countries are common', async () => {
    mockFindMany.mockResolvedValue([entry('firoam', 'EU', ['DE']), entry('tgt', 'EU', ['BE'])]);
    const [eu] = await buildRegionSuggestions();
    expect(eu.suggestions.find((s) => s.kind === 'INTERSECTION')).toBeUndefined();
  });

  it('emits a UNION suggestion when union is larger than intersection', async () => {
    mockFindMany.mockResolvedValue([
      entry('firoam', 'EU', ['DE', 'FR', 'AT']),
      entry('tgt', 'EU', ['DE', 'BE']),
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
      entry('firoam', 'EU', ['DE', 'FR', 'AT', 'BE']),
      entry('tgt', 'EU', ['DE']),
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
      entry('firoam', 'GLOBAL', twentyCountries),
      entry('tgt', 'GLOBAL', ['US']),
    ]);

    const [global] = await buildRegionSuggestions({ unionLimit: 10 });
    expect(global.suggestions.find((s) => s.kind === 'UNION')).toBeUndefined();
  });

  it('skips entries with no countryCodes', async () => {
    mockFindMany.mockResolvedValue([
      entry('firoam', 'EU', []),
      entry('firoam', 'EU', ['DE', 'FR']),
    ]);
    const [eu] = await buildRegionSuggestions();
    expect(eu.providers[0].skuCount).toBe(1); // only the second entry counted
  });

  it('skips invalid country codes (non-2-letter, non-strings)', async () => {
    mockFindMany.mockResolvedValue([
      entry('firoam', 'EU', ['DE', 'GERMANY', 'fr']) as unknown as Parameters<
        typeof mockFindMany
      >[0],
    ]);
    const [eu] = await buildRegionSuggestions();
    expect(eu.providers[0].countries).toEqual(['DE', 'FR']);
  });

  it('groups distinct vendor labels into separate groups', async () => {
    mockFindMany.mockResolvedValue([entry('firoam', 'EU', ['DE']), entry('tgt', 'Europe', ['FR'])]);
    const groups = await buildRegionSuggestions();
    // EU and EUROPE are different labels — they appear as separate groups,
    // even though both infer parentCode EU. Admin reconciles.
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.label).sort()).toEqual(['EU', 'EUROPE']);
    expect(groups.every((g) => g.parentCode === 'EU')).toBe(true);
  });

  it('sorts groups alphabetically by label', async () => {
    mockFindMany.mockResolvedValue([
      entry('firoam', 'GCC', ['SA']),
      entry('firoam', 'ASIA', ['SG']),
      entry('firoam', 'EU', ['DE']),
    ]);
    const groups = await buildRegionSuggestions();
    expect(groups.map((g) => g.label)).toEqual(['ASIA', 'EU', 'GCC']);
  });

  it('skips entries with null region (filtered at query time)', async () => {
    // The where-clause excludes region=null at the DB level, so this is a
    // sanity check that we ignore them defensively if they slip through.
    mockFindMany.mockResolvedValue([
      { provider: 'firoam', region: null, countryCodes: ['DE'] },
      entry('firoam', 'EU', ['DE']),
    ]);
    const groups = await buildRegionSuggestions();
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('EU');
  });
});
