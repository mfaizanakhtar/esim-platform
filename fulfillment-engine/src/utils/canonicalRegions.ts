/**
 * Canonical region tags + matchers used by region-discovery group labeling.
 *
 * The AI parser (`parseCatalogEntry` in `src/services/embeddingService.ts`)
 * frequently returns enumerated country lists in `parsedJson.regionCodes`
 * instead of canonical tags like "GCC" or "GLOBAL". Discovery used to take
 * the first entry of those enumerations and use it as the group label,
 * which buried real regional packs under arbitrary country codes
 * (e.g. a Gulf pack containing AE/BH/KW/QA/SA was labeled "QA" because
 * that was alphabetically first in the parser's output).
 *
 * This module gives `regionService.deriveGroupLabel` two deterministic
 * sources to fall back on:
 *
 *   1. **Canonical subset match** — if every country in a row belongs
 *      to a known canonical region's country set, tag it with that
 *      region. Most-specific match wins (GCC before ME before EU).
 *
 *   2. **Product-name keyword match** — if the row's productName contains
 *      an obvious region keyword ("Global", "Middle East", "ASEAN", etc.),
 *      use that. Useful for huge global packs whose country set is too
 *      broad to subset-match anything sensible.
 *
 * Both are pure functions — no DB, no AI, no IO. Adding a new canonical
 * region or keyword is a one-line change here.
 */

export interface CanonicalRegion {
  /** The label produced by discovery for groups that match this region. */
  tag: string;
  /** Parent group used by `inferParentCode` so accepted regions land in the right family. */
  parent: string;
  /** Member ISO 3166-1 alpha-2 codes (uppercase). */
  countries: Set<string>;
}

// ── Canonical country sets ────────────────────────────────────────────────

const EU_27 = new Set([
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
]);

// EEA = EU + Iceland, Liechtenstein, Norway. Plus we include UK/CH for the
// real-world "Europe ~30" packs that lump them in.
const EEA_PLUS = new Set([
  ...EU_27,
  'IS',
  'LI',
  'NO', // EEA non-EU
  'GB',
  'CH', // commonly included by carriers
]);

const GCC = new Set(['SA', 'AE', 'BH', 'KW', 'OM', 'QA']);

const NORDIC = new Set(['SE', 'NO', 'DK', 'FI', 'IS']);

const BENELUX = new Set(['BE', 'NL', 'LU']);

const BALTIC = new Set(['EE', 'LV', 'LT']);

const ANZ = new Set(['AU', 'NZ']);

const ASEAN = new Set(['SG', 'TH', 'MY', 'ID', 'PH', 'VN', 'MM', 'LA', 'KH', 'BN']);

// Middle East, broadly. Larger than GCC; includes Levant + Egypt + Turkey + Iran.
const MIDDLE_EAST = new Set([
  'SA',
  'AE',
  'BH',
  'KW',
  'OM',
  'QA', // GCC
  'IQ',
  'IR',
  'IL',
  'JO',
  'LB',
  'SY',
  'YE',
  'PS', // Levant + nearby
  'EG',
  'TR',
]);

// Sorted ascending by size — first matching subset wins, so the most-specific
// label is returned (e.g. [SA,AE,BH] is GCC, not ME).
export const CANONICAL_REGIONS: CanonicalRegion[] = [
  { tag: 'BENELUX', parent: 'EU', countries: BENELUX }, // 3
  { tag: 'BALTIC', parent: 'EU', countries: BALTIC }, // 3
  { tag: 'ANZ', parent: 'OCEANIA', countries: ANZ }, // 2
  { tag: 'NORDIC', parent: 'EU', countries: NORDIC }, // 5
  { tag: 'GCC', parent: 'GCC', countries: GCC }, // 6
  { tag: 'ASEAN', parent: 'ASIA', countries: ASEAN }, // 10
  { tag: 'ME', parent: 'ME', countries: MIDDLE_EAST }, // 16
  { tag: 'EU', parent: 'EU', countries: EU_27 }, // 27
  { tag: 'EEA', parent: 'EU', countries: EEA_PLUS }, // ~32
].sort((a, b) => a.countries.size - b.countries.size);

// ── Product-name keyword rules ────────────────────────────────────────────

/** Matched in order — most specific first. First hit wins. */
export const PRODUCT_NAME_RULES: Array<{ pattern: RegExp; tag: string; parent: string }> = [
  { pattern: /\bglobal\b|worldwide/i, tag: 'GLOBAL', parent: 'GLOBAL' },
  { pattern: /\bgcc\b|gulf cooperation/i, tag: 'GCC', parent: 'GCC' },
  { pattern: /\bmiddle\s*east\b|\bmena\b/i, tag: 'ME', parent: 'ME' },
  { pattern: /\basean\b/i, tag: 'ASEAN', parent: 'ASIA' },
  { pattern: /\bnordic\b/i, tag: 'NORDIC', parent: 'EU' },
  { pattern: /\bbalkans?\b/i, tag: 'BALKANS', parent: 'EU' },
  { pattern: /\bbenelux\b/i, tag: 'BENELUX', parent: 'EU' },
  { pattern: /\bbaltics?\b/i, tag: 'BALTIC', parent: 'EU' },
  { pattern: /\bcaribbean\b/i, tag: 'CARIBBEAN', parent: 'AMERICAS' },
  { pattern: /\b(latin|south)\s*america\b|\blatam\b/i, tag: 'LATAM', parent: 'AMERICAS' },
  { pattern: /\bnorth\s*america\b/i, tag: 'NORTH-AMERICA', parent: 'AMERICAS' },
  { pattern: /\beu(rope)?\b/i, tag: 'EU', parent: 'EU' },
  { pattern: /\bafrica\b/i, tag: 'AFRICA', parent: 'AFRICA' },
  { pattern: /\boceania\b/i, tag: 'OCEANIA', parent: 'OCEANIA' },
  // Asia followed by digits (e.g. "West Asia8", "Central Asia3") OR word boundary.
  // (?:\d+|\b) avoids false positives like "Asian" while catching FiRoam's
  // numeric-suffix naming. Same idea kept narrowly scoped to Asia for now —
  // other region names in the catalog all use spaces (e.g. "Europe 30").
  { pattern: /\basia(?:\d+|\b)|\bapac\b/i, tag: 'ASIA', parent: 'ASIA' },
];

// ── Matchers ──────────────────────────────────────────────────────────────

/**
 * Returns the most-specific canonical region whose country set is a strict
 * superset of the input. `null` if no match.
 *
 * Subset rule: every country in `isoCountries` must be in the canonical set.
 * Avoids false positives — a row mixing GCC + EU countries won't match GCC
 * (some countries aren't GCC) nor EU (some aren't EU).
 *
 * Empty input returns `null` (a region of zero countries shouldn't be tagged).
 */
export function findCanonicalSubsetTag(isoCountries: Iterable<string>): {
  tag: string;
  parent: string;
} | null {
  const arr = [...isoCountries];
  if (arr.length === 0) return null;

  for (const region of CANONICAL_REGIONS) {
    let allIn = true;
    for (const c of arr) {
      if (!region.countries.has(c)) {
        allIn = false;
        break;
      }
    }
    if (allIn) return { tag: region.tag, parent: region.parent };
  }
  return null;
}

/**
 * Find the first product-name rule whose pattern matches `productName`.
 * Returns `null` for empty / non-string input.
 */
export function findProductNameTag(productName: unknown): { tag: string; parent: string } | null {
  if (typeof productName !== 'string' || productName.trim().length === 0) return null;
  for (const rule of PRODUCT_NAME_RULES) {
    if (rule.pattern.test(productName)) return { tag: rule.tag, parent: rule.parent };
  }
  return null;
}
