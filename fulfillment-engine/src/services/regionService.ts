import prisma from '~/db/prisma';
import { findCanonicalSubsetTag, findProductNameTag } from '~/utils/canonicalRegions';

/**
 * Region discovery service.
 *
 * Aggregates the active provider catalog to propose canonical `Region` rows the
 * admin can curate. Read-only / side-effect-free.
 *
 * **Core rule:** a "regional plan" is a catalog row whose `countryCodes` array
 * has 2+ entries. We do NOT use the top-level `region` field as the gate
 * because providers store it inconsistently (TGT always null, FiRoam sets it
 * to the country code for single-country plans, etc.). The country list is the
 * universal regional signal.
 *
 * **Grouping label** (preference order):
 *   1. `parsedJson.regionCodes` ONLY if it's a single canonical-looking tag
 *      ("EU", "GLOBAL", "ASIA"). Multi-entry enumerations (the buggy AI
 *      output) fall through.
 *   2. Country set is a strict subset of a canonical region (GCC, ASEAN,
 *      NORDIC, EU, ME, …) — see `utils/canonicalRegions.ts`.
 *   3. `productName` contains an obvious region keyword ("Global",
 *      "Middle East", "ASEAN", "Europe", …).
 *   4. `region` field if multi-char or in PARENT_CODE_ALIASES.
 *   5. Synthetic `MULTI-<count>` based on country list size.
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
  /** Group label (canonical region tag, vendor label, or synthetic). */
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
  NORDIC: 'EU',
  BENELUX: 'EU',
  BALTIC: 'EU',
  BALKANS: 'EU',
  ASIA: 'ASIA',
  APAC: 'ASIA',
  AS: 'ASIA',
  ASEAN: 'ASIA',
  GCC: 'GCC',
  'MIDDLE EAST': 'ME',
  ME: 'ME',
  AMERICAS: 'AMERICAS',
  AMERICA: 'AMERICAS',
  'NORTH AMERICA': 'AMERICAS',
  'NORTH-AMERICA': 'AMERICAS',
  'SOUTH AMERICA': 'AMERICAS',
  LATAM: 'AMERICAS',
  NA: 'AMERICAS',
  CARIBBEAN: 'AMERICAS',
  GLOBAL: 'GLOBAL',
  WORLD: 'GLOBAL',
  WORLDWIDE: 'GLOBAL',
  AFRICA: 'AFRICA',
  AF: 'AFRICA',
  OCEANIA: 'OCEANIA',
  ANZ: 'OCEANIA',
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

interface CatalogRow {
  provider: string;
  productName: string | null;
  region: string | null;
  countryCodes: unknown;
  parsedJson: unknown;
}

/**
 * Pick a stable group label for a multi-country catalog row. Already filtered
 * to `countryCodes.length >= 2`, so the row is definitely a regional plan —
 * we just need a stable name to group by.
 */
function deriveGroupLabel(row: CatalogRow, isoCountries: string[]): string {
  // Tier 1: parser produced a SINGLE canonical-looking tag.
  //   Multi-entry regionCodes is the broken case (parser enumerated countries
  //   instead of identifying a region); fall through to deterministic tiers.
  const parsed = row.parsedJson as { regionCodes?: unknown } | null;
  if (parsed && Array.isArray(parsed.regionCodes) && parsed.regionCodes.length === 1) {
    const first = parsed.regionCodes[0];
    if (typeof first === 'string') {
      const t = first.trim().toUpperCase();
      // Accept if it's clearly a region tag (>2 chars) or in our alias map
      // (covers 2-letter region tags like "EU", "ME", "AS", "AF").
      if (t.length > 2 || (t.length > 0 && PARENT_CODE_ALIASES[t])) {
        return t;
      }
    }
  }

  // Tier 2: country set is a strict subset of a known canonical region.
  const subset = findCanonicalSubsetTag(isoCountries);
  if (subset) return subset.tag;

  // Tier 3: product name contains an explicit region keyword.
  const fromName = findProductNameTag(row.productName);
  if (fromName) return fromName.tag;

  // Tier 4: vendor `region` field. Accept multi-char tags or 2-char known
  // aliases (EU, ME, AS, AF, …). Reject pure-digit values — FiRoam stores
  // internal SKU IDs (e.g. "99111", "99988") in this column for some packs;
  // those would otherwise leak through as group labels.
  if (typeof row.region === 'string') {
    const r = row.region.trim().toUpperCase();
    const isPureDigits = /^\d+$/.test(r);
    if (!isPureDigits && (r.length > 2 || (r.length > 0 && PARENT_CODE_ALIASES[r]))) {
      return r;
    }
  }

  // Tier 5: synthetic — group by country count so similarly-sized bundles cluster.
  return `MULTI-${isoCountries.length}`;
}

interface ProviderBucket {
  countries: Set<string>;
  skuCount: number;
}

/**
 * Run discovery against the live ProviderSkuCatalog and return one group per
 * derived label.
 *
 * Filter: `isActive = true` AND `countryCodes` is an array of length ≥ 2 (i.e.
 * a real regional plan, not a single-country SKU).
 *
 * Maximum suggestion size is `unionLimit` (default 60) — beyond that the
 * "union" suggestion is dropped to avoid overwhelming proposals like a
 * 130-country GLOBAL union dominated by one provider.
 */
export async function buildRegionSuggestions(
  options: { unionLimit?: number } = {},
): Promise<RegionGroup[]> {
  const unionLimit = options.unionLimit ?? 60;

  // We can't filter by countryCodes length in Prisma's where clause for JSON
  // arrays cleanly, so we fetch active rows and filter in memory. Catalog is
  // O(thousands), so this is cheap.
  const entries = (await prisma.providerSkuCatalog.findMany({
    where: { isActive: true },
    select: {
      provider: true,
      productName: true,
      region: true,
      countryCodes: true,
      parsedJson: true,
    },
  })) as CatalogRow[];

  // label → provider → bucket
  const groupsMap = new Map<string, Map<string, ProviderBucket>>();

  for (const entry of entries) {
    const ccRaw = entry.countryCodes;
    if (!Array.isArray(ccRaw)) continue;

    const normalized: string[] = [];
    for (const code of ccRaw) {
      if (typeof code !== 'string') continue;
      const upper = code.trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(upper)) normalized.push(upper);
    }
    // Regional plans only — single-country SKUs are not what discovery is for.
    if (normalized.length < 2) continue;

    const label = deriveGroupLabel(entry, normalized);

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
