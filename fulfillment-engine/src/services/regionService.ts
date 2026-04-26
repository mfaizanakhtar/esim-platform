import prisma from '~/db/prisma';

/**
 * Region discovery service.
 *
 * Aggregates the active provider catalog by `region` label per provider and
 * proposes canonical `Region` rows the admin can curate. The discovery is
 * read-only and side-effect-free; the admin reviews suggestions and saves
 * the ones they want via POST /admin/regions.
 *
 * See docs/implementations/0002-region-schema-crud.md for context.
 */

export interface ProviderRegionCoverage {
  provider: string;
  countries: string[];
  skuCount: number;
}

export type SuggestionKind = 'INTERSECTION' | 'UNION';

export interface RegionSuggestion {
  /** Auto-generated stable code, e.g. "EU5" — admin can rename before saving. */
  code: string;
  parentCode: string;
  countryCodes: string[];
  /** Why this suggestion exists (intersection vs union, etc.). */
  rationale: string;
  kind: SuggestionKind;
  /** Providers whose regional SKUs cover ALL the suggested countries. */
  providersAvailable: string[];
}

export interface RegionGroup {
  /** Normalized vendor region label (uppercase, trimmed). */
  label: string;
  /** Inferred canonical parent (e.g. "EU", "ASIA") — admin may override. */
  parentCode: string;
  providers: ProviderRegionCoverage[];
  /** Countries every provider covers. */
  intersection: string[];
  /** Countries any provider covers. */
  union: string[];
  suggestions: RegionSuggestion[];
}

/**
 * Best-effort mapping from common vendor region labels to canonical parent
 * codes. Anything not in this dictionary falls back to the label itself
 * (uppercased, alphanumeric stripped, capped at 16 chars).
 */
const PARENT_CODE_ALIASES: Record<string, string> = {
  EU: 'EU',
  EUROPE: 'EU',
  EEA: 'EU',
  ASIA: 'ASIA',
  APAC: 'ASIA',
  AS: 'ASIA',
  GCC: 'GCC',
  'MIDDLE EAST': 'ME',
  ME: 'ME',
  AMERICAS: 'AMERICAS',
  AMERICA: 'AMERICAS',
  'NORTH AMERICA': 'AMERICAS',
  'SOUTH AMERICA': 'AMERICAS',
  LATAM: 'AMERICAS',
  NA: 'AMERICAS',
  GLOBAL: 'GLOBAL',
  WORLD: 'GLOBAL',
  WORLDWIDE: 'GLOBAL',
  AFRICA: 'AFRICA',
  AF: 'AFRICA',
  OCEANIA: 'OCEANIA',
};

export function normalizeLabel(raw: string): string {
  return raw.trim().toUpperCase();
}

export function inferParentCode(label: string): string {
  const upper = normalizeLabel(label);
  const alias = PARENT_CODE_ALIASES[upper];
  if (alias) return alias;
  // Fallback: strip non-alphanumeric, cap at 16 chars (matches Region.parentCode validation).
  const stripped = upper.replace(/[^A-Z0-9]/g, '').slice(0, 16);
  return stripped.length >= 2 ? stripped : 'OTHER';
}

interface ProviderBucket {
  countries: Set<string>;
  skuCount: number;
}

/**
 * Run discovery against the live ProviderSkuCatalog and return one group per
 * normalized vendor region label.
 *
 * Only entries with both a non-empty `region` string AND a non-empty
 * `countryCodes` array contribute — the suggestion engine can't propose
 * coverage from rows that don't list their countries.
 *
 * Maximum suggestion size is `unionLimit` (default 60) — beyond that the
 * "union" suggestion is dropped to avoid overwhelming proposals like a
 * 130-country GLOBAL union dominated by one provider.
 */
export async function buildRegionSuggestions(
  options: { unionLimit?: number } = {},
): Promise<RegionGroup[]> {
  const unionLimit = options.unionLimit ?? 60;

  const entries = await prisma.providerSkuCatalog.findMany({
    where: { isActive: true, region: { not: null } },
    select: { provider: true, region: true, countryCodes: true },
  });

  // label → provider → bucket
  const groupsMap = new Map<string, Map<string, ProviderBucket>>();

  for (const entry of entries) {
    if (!entry.region) continue;
    const ccRaw = entry.countryCodes;
    if (!Array.isArray(ccRaw) || ccRaw.length === 0) continue;

    const normalized: string[] = [];
    for (const code of ccRaw) {
      if (typeof code !== 'string') continue;
      const upper = code.trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(upper)) normalized.push(upper);
    }
    if (normalized.length === 0) continue;

    const label = normalizeLabel(entry.region);
    let byProvider = groupsMap.get(label);
    if (!byProvider) {
      byProvider = new Map();
      groupsMap.set(label, byProvider);
    }

    let bucket = byProvider.get(entry.provider);
    if (!bucket) {
      bucket = { countries: new Set(), skuCount: 0 };
      byProvider.set(entry.provider, bucket);
    }
    for (const code of normalized) bucket.countries.add(code);
    bucket.skuCount += 1;
  }

  const groups: RegionGroup[] = [];

  for (const [label, byProvider] of groupsMap) {
    const parentCode = inferParentCode(label);

    const providers: ProviderRegionCoverage[] = Array.from(byProvider.entries())
      .map(([provider, bucket]) => ({
        provider,
        countries: Array.from(bucket.countries).sort(),
        skuCount: bucket.skuCount,
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider));

    // Intersection: countries every provider covers.
    let intersection: string[] = [];
    if (providers.length > 0) {
      const [first, ...rest] = providers;
      const result = new Set(first.countries);
      for (const p of rest) {
        const next = new Set<string>();
        for (const c of result) if (p.countries.includes(c)) next.add(c);
        result.clear();
        for (const c of next) result.add(c);
      }
      intersection = Array.from(result).sort();
    }

    // Union: countries at least one provider covers.
    const unionSet = new Set<string>();
    for (const p of providers) for (const c of p.countries) unionSet.add(c);
    const union = Array.from(unionSet).sort();

    const suggestions: RegionSuggestion[] = [];

    if (intersection.length >= 2) {
      suggestions.push({
        code: `${parentCode}${intersection.length}`,
        parentCode,
        countryCodes: intersection,
        rationale: `All ${providers.length} provider${providers.length > 1 ? 's' : ''} cover every country — safest choice for strict coverage matching.`,
        kind: 'INTERSECTION',
        providersAvailable: providers.map((p) => p.provider),
      });
    }

    if (union.length > intersection.length && union.length <= unionLimit) {
      const providersForUnion = providers
        .filter((p) => union.every((c) => p.countries.includes(c)))
        .map((p) => p.provider);
      suggestions.push({
        code: `${parentCode}${union.length}`,
        parentCode,
        countryCodes: union,
        rationale: `Union across all providers — at least one provider covers every country, but no single provider covers all of them. Strict matching may eliminate this region in practice.`,
        kind: 'UNION',
        providersAvailable: providersForUnion,
      });
    }

    groups.push({ label, parentCode, providers, intersection, union, suggestions });
  }

  groups.sort((a, b) => a.label.localeCompare(b.label));
  return groups;
}
