/**
 * Parse a Shopify SKU.
 * Supported formats:
 *   {REGION}-{DATA}-{VALIDITY}-{TYPE}   e.g. SA-2GB-7D-FIXED, EU-500MB-30D-DAYPASS
 *   ESIM-{REGION}-{DATA}-{VALIDITY}     e.g. ESIM-EU-1GB-7D  (legacy)
 */
export interface ParsedShopifySku {
  regionCode: string;
  dataMb: number;
  validityDays: number;
}

const SKU_REGEX = /^([A-Z]{2,})-(\d+)(GB|MB)-(\d+)D-[A-Z]+$/;
const SKU_REGEX_LEGACY = /^ESIM-([A-Z]{2,})-(\d+)(GB|MB)-(\d+)D(?:-[A-Z]+)?$/;

export function parseShopifySku(sku: string): ParsedShopifySku | null {
  const m = SKU_REGEX.exec(sku) ?? SKU_REGEX_LEGACY.exec(sku);
  if (!m) return null;
  return {
    regionCode: m[1],
    dataMb: m[3] === 'GB' ? parseInt(m[2], 10) * 1024 : parseInt(m[2], 10),
    validityDays: parseInt(m[4], 10),
  };
}
