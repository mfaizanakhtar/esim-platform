/**
 * Parse a Shopify SKU in the format ESIM-{REGION}-{DATA}-{VALIDITY}
 * Examples: ESIM-EU-1GB-7D, ESIM-US-500MB-30D, ESIM-APAC-10GB-30D
 */
export interface ParsedShopifySku {
  regionCode: string;
  dataMb: number;
  validityDays: number;
}

// Matches: ESIM-{2+ uppercase letters}-{digits}{GB|MB}-{digits}D
const SKU_REGEX = /^ESIM-([A-Z]{2,})-(\d+)(GB|MB)-(\d+)D$/;

export function parseShopifySku(sku: string): ParsedShopifySku | null {
  const m = SKU_REGEX.exec(sku);
  if (!m) return null;
  return {
    regionCode: m[1],
    dataMb: m[3] === 'GB' ? parseInt(m[2], 10) * 1024 : parseInt(m[2], 10),
    validityDays: parseInt(m[4], 10),
  };
}
