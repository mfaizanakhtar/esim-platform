/**
 * Parse a Shopify SKU.
 *
 * Supported formats:
 *   COUNTRY (or vendor-region label): {REGION}-{DATA}-{VALIDITY}-{TYPE}
 *     e.g. SA-2GB-7D-FIXED, EU-500MB-30D-DAYPASS
 *   REGION (canonical): REGION-{REGION_CODE}-{DATA}-{VALIDITY}-{TYPE}
 *     e.g. REGION-EU30-5GB-30D-FIXED, REGION-ASIA4-1GB-1D-DAYPASS
 *   Legacy: ESIM-{REGION}-{DATA}-{VALIDITY}
 *     e.g. ESIM-EU-1GB-7D
 *
 * `kind` discriminates COUNTRY/legacy from REGION so callers can decide whether
 * to look up a `Region` row and apply strict-coverage matching.
 */
export interface ParsedShopifySku {
  /**
   * For COUNTRY: a 2-letter ISO code or vendor region label (e.g. "DE", "EU").
   * For REGION: the canonical region code (e.g. "EU30", "ASIA4", "GCC6").
   */
  regionCode: string;
  dataMb: number;
  validityDays: number;
  /** 'FIXED' (total-data) or 'DAYPASS' (per-day). Defaults to 'FIXED' for legacy SKUs without suffix. */
  skuType: string;
  /** Discriminator: REGION SKUs require Region-table lookup + strict-coverage matching. */
  kind: 'COUNTRY' | 'REGION';
}

// REGION must be checked first — its code can include digits/dashes (e.g. EU30, AMERICAS-NA3).
const SKU_REGEX_REGION = /^REGION-([A-Z0-9-]+?)-(\d+)(GB|MB)-(\d+)D-([A-Z]+)$/;
// COUNTRY/legacy formats (region code is uppercase letters only).
const SKU_REGEX = /^([A-Z]{2,})-(\d+)(GB|MB)-(\d+)D-([A-Z]+)$/;
const SKU_REGEX_LEGACY = /^ESIM-([A-Z]{2,})-(\d+)(GB|MB)-(\d+)D(?:-([A-Z]+))?$/;

export function parseShopifySku(sku: string): ParsedShopifySku | null {
  const r = SKU_REGEX_REGION.exec(sku);
  if (r) {
    return {
      regionCode: r[1],
      dataMb: r[3] === 'GB' ? parseInt(r[2], 10) * 1024 : parseInt(r[2], 10),
      validityDays: parseInt(r[4], 10),
      skuType: r[5],
      kind: 'REGION',
    };
  }
  const m = SKU_REGEX.exec(sku) ?? SKU_REGEX_LEGACY.exec(sku);
  if (!m) return null;
  return {
    regionCode: m[1],
    dataMb: m[3] === 'GB' ? parseInt(m[2], 10) * 1024 : parseInt(m[2], 10),
    validityDays: parseInt(m[4], 10),
    skuType: m[5] ?? 'FIXED',
    kind: 'COUNTRY',
  };
}
