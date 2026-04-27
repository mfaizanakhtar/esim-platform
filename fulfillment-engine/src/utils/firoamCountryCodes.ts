import { firoamNameToCode } from '~/utils/countryCodes';
import { logger } from '~/utils/logger';

/**
 * Normalize FiRoam's `supportCountry` field into a canonical ISO 3166-1
 * alpha-2 list.
 *
 * FiRoam's API returns country **display names** (e.g. `"Germany"`, `"France"`)
 * in `supportCountry`, NOT ISO codes. The rest of the system (region discovery,
 * structured mapping JSONB containment, AI mapping post-filter, country-template
 * generation) assumes `ProviderSkuCatalog.countryCodes` is always ISO. This
 * helper enforces the invariant at the sync boundary so downstream code stays
 * simple.
 *
 * Behavior:
 *   - Strings already in ISO form (e.g. `"DE"`, `"de"`) pass through, uppercased
 *   - Display names mapped via `firoamNameToCode()` (e.g. `"Germany"` → `"DE"`)
 *   - Unknown names dropped (logged as a warning so unmappable countries can be
 *     spotted and added to the lookup map)
 *   - Result is deduped + sorted for stable diffs
 *   - Non-string entries silently skipped (defensive against API drift)
 *
 * The raw `supportCountry` is still preserved in `rawPayload` upstream, so no
 * information is lost — only the canonical column is normalized.
 */
export function normalizeFiroamCountries(
  supportCountry: unknown,
  context: { skuId?: string; productCode?: string } = {},
): string[] {
  if (!Array.isArray(supportCountry)) return [];

  const codes = new Set<string>();
  const unknown: string[] = [];

  for (const raw of supportCountry) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    const upper = trimmed.toUpperCase();
    // Defensive: FiRoam might mix formats. If it already looks like an ISO
    // code AND we recognize it (round-trip via firoamNameToCode reverse map
    // would be ideal, but the simpler proxy: it's a 2-letter all-letter
    // string), accept it without lookup.
    if (/^[A-Z]{2}$/.test(upper)) {
      codes.add(upper);
      continue;
    }

    const mapped = firoamNameToCode(trimmed);
    if (mapped) {
      codes.add(mapped.toUpperCase());
    } else {
      unknown.push(trimmed);
    }
  }

  if (unknown.length > 0) {
    logger.warn(
      { ...context, unknownCountryNames: unknown },
      'firoam-sync: dropped country names not in firoamNameToCode map',
    );
  }

  return [...codes].sort();
}
