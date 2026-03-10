/**
 * Phase 1: Generate Shopify SKUs
 *
 * Parses products_export_1.csv and generates unique SKUs for each variant.
 * Output: shopify-skus-generated.csv
 *
 * Usage: npm run generate:skus
 */
import fs from 'fs';
import path from 'path';

interface ShopifyVariant {
  handle: string;
  title: string;
  planType: string;
  validity: string;
  volume: string;
  variantPrice: string;
}

interface GeneratedSKU {
  originalHandle: string;
  title: string;
  planType: string;
  validity: string;
  volume: string;
  price: string;
  generatedSKU: string;
  countryCode: string;
  packageType: 'daypass' | 'fixed';
  daysCount: number;
  dataAmount: string;
}

// Country handle to ISO code mapping - Complete list from products_export_1.csv
const COUNTRY_CODES: Record<string, string> = {
  // Countries from Shopify export
  afghanistan: 'AF',
  albania: 'AL',
  andorra: 'AD',
  armenia: 'AM',
  'armenia-copy': 'AM', // Duplicate handle
  austria: 'AT',
  azerbaijan: 'AZ',
  bahrain: 'BH',
  bangladesh: 'BD',
  belarus: 'BY',
  belgium: 'BE',
  'bosnia-herzegovina': 'BA',
  bulgaria: 'BG',
  cambodia: 'KH',
  china: 'CN',
  croatia: 'HR',
  cyprus: 'CY',
  'czech-republic': 'CZ',
  denmark: 'DK',
  estonia: 'EE',
  'faeroe-islands': 'FO',
  finland: 'FI',
  france: 'FR',
  georgia: 'GE',
  germany: 'DE',
  gibraltar: 'GI',
  greece: 'GR',
  greenland: 'GL',
  hungary: 'HU',
  iceland: 'IS',
  india: 'IN',
  indonesia: 'ID',
  ireland: 'IE',
  italy: 'IT',
  japan: 'JP',
  jordan: 'JO',
  kazakhstan: 'KZ',
  kuwait: 'KW',
  kyrgyzstan: 'KG',
  laos: 'LA',
  latvia: 'LV',
  liechtenstein: 'LI',
  lithuania: 'LT',
  luxembourg: 'LU',
  macau: 'MO',
  macedonia: 'MK',
  malaysia: 'MY',
  maldives: 'MV',
  malta: 'MT',
  moldova: 'MD',
  mongolia: 'MN',
  montenegro: 'ME',
  nepal: 'NP',
  netherlands: 'NL',
  norway: 'NO',
  oman: 'OM',
  pakistan: 'PK',
  philippines: 'PH',
  poland: 'PL',
  portugal: 'PT',
  qatar: 'QA',
  romania: 'RO',
  russia: 'RU',
  'san-marino': 'SM',
  'saudi-arabia': 'SA',
  serbia: 'RS',
  singapore: 'SG',
  slovakia: 'SK',
  slovenia: 'SI',
  'south-korea': 'KR',
  spain: 'ES',
  'sri-lanka': 'LK',
  sweden: 'SE',
  switzerland: 'CH',
  taiwan: 'TW',
  tajikistan: 'TJ',
  thailand: 'TH',
  turkey: 'TR',
  uae: 'AE',
  ukraine: 'UA',
  'united-kingdom': 'GB',
  uzbekistan: 'UZ',
  vietnam: 'VN',
  // Regional/Global plans
  'asia-4': 'ASIA4',
  global: 'GLOBAL',
  'e-sim-template': 'TEMPLATE',
};

/**
 * Convert country handle to code
 */
function getCountryCode(handle: string): string {
  const normalized = handle.toLowerCase().trim().replace(/\s+/g, '-');
  return (
    COUNTRY_CODES[normalized] ||
    handle
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .substring(0, 6)
  );
}

/**
 * Determine if package is daypass or fixed
 */
function getPackageType(planType: string): 'daypass' | 'fixed' {
  const normalized = planType.toLowerCase();
  if (normalized.includes('day-pass') || normalized.includes('daily')) {
    return 'daypass';
  }
  return 'fixed';
}

/**
 * Extract days count from validity string
 */
function extractDays(validity: string): number {
  if (!validity) return 1;

  const normalized = validity.toLowerCase().replace(/\s+/g, '');

  // Match patterns like "1-day", "3-days", "7days", "30d"
  const match = normalized.match(/(\d+)[-\s]?days?/);
  if (match) return parseInt(match[1], 10);

  // Just a number
  const numMatch = normalized.match(/^(\d+)$/);
  if (numMatch) return parseInt(numMatch[1], 10);

  return 1;
}

/**
 * Normalize data amount (e.g., "1 GB", "500 MB", "10GB")
 */
function normalizeDataAmount(volume: string): string {
  if (!volume) return 'UNKNOWN';

  const normalized = volume.toUpperCase().replace(/\s+/g, '');

  // Already normalized (e.g., "1GB", "500MB")
  if (/^\d+[GM]B$/.test(normalized)) {
    return normalized;
  }

  // Has space (e.g., "1 GB", "500 MB")
  const match = volume.match(/(\d+)\s*(GB|MB|G|M)/i);
  if (match) {
    const amount = match[1];
    const unit = match[2].toUpperCase();
    if (unit === 'G') return `${amount}GB`;
    if (unit === 'M') return `${amount}MB`;
    return `${amount}${unit}`;
  }

  return normalized;
}

/**
 * Generate SKU from variant details
 */
function generateSKU(variant: ShopifyVariant): GeneratedSKU {
  const countryCode = getCountryCode(variant.handle);
  const packageType = getPackageType(variant.planType);
  const daysCount = extractDays(variant.validity);
  const dataAmount = normalizeDataAmount(variant.volume);

  // Format: {COUNTRY}-{DATA}-{DAYS}D-{TYPE}
  const sku = `${countryCode}-${dataAmount}-${daysCount}D-${packageType.toUpperCase()}`;

  return {
    originalHandle: variant.handle,
    title: variant.title,
    planType: variant.planType,
    validity: variant.validity,
    volume: variant.volume,
    price: variant.variantPrice,
    generatedSKU: sku,
    countryCode,
    packageType,
    daysCount,
    dataAmount,
  };
}

/**
 * Parse CSV line (handles quoted fields with commas)
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  return result;
}

/**
 * Main function
 */
async function main() {
  const inputFile = path.join(process.cwd(), 'csv-exports', 'products_export_1.csv');
  const outputFile = path.join(process.cwd(), 'csv-exports', 'shopify-skus-generated.csv');

  console.log('📦 Phase 1: Generate Shopify SKUs\n');
  console.log(`Reading: ${inputFile}`);

  if (!fs.existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}`);
  }

  const content = fs.readFileSync(inputFile, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());

  if (lines.length === 0) {
    throw new Error('CSV file is empty');
  }

  const headers = parseCSVLine(lines[0]);
  console.log(`\nFound ${lines.length - 1} data rows`);
  console.log(`Columns: ${headers.length}\n`);

  // Find column indices
  const handleIdx = headers.indexOf('Handle');
  const titleIdx = headers.indexOf('Title');
  const option1ValueIdx = headers.indexOf('Option1 Value'); // Plan Type
  const option2ValueIdx = headers.indexOf('Option2 Value'); // Validity
  const option3ValueIdx = headers.indexOf('Option3 Value'); // Volume
  const priceIdx = headers.indexOf('Variant Price');

  if (
    handleIdx === -1 ||
    option1ValueIdx === -1 ||
    option2ValueIdx === -1 ||
    option3ValueIdx === -1
  ) {
    throw new Error('Required columns not found in CSV');
  }

  console.log('Column Mapping:');
  console.log(`  Handle: Column ${handleIdx + 1}`);
  console.log(`  Title: Column ${titleIdx + 1}`);
  console.log(`  Plan Type: Column ${option1ValueIdx + 1}`);
  console.log(`  Validity: Column ${option2ValueIdx + 1}`);
  console.log(`  Volume: Column ${option3ValueIdx + 1}`);
  console.log(`  Price: Column ${priceIdx + 1}\n`);

  const generated: GeneratedSKU[] = [];
  const skipped: string[] = [];
  const skuSet = new Set<string>();
  let duplicates = 0;

  // Process each row
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);

    const handle = fields[handleIdx];
    const title = fields[titleIdx];
    const planType = fields[option1ValueIdx];
    const validity = fields[option2ValueIdx];
    const volume = fields[option3ValueIdx];
    const variantPrice = fields[priceIdx];

    // Skip if missing critical data
    if (!handle || !planType || !validity || !volume) {
      skipped.push(`Row ${i + 1}: Missing data (${handle || 'NO_HANDLE'})`);
      continue;
    }

    const variant: ShopifyVariant = {
      handle,
      title,
      planType,
      validity,
      volume,
      variantPrice,
    };

    const result = generateSKU(variant);

    // Check for duplicates
    if (skuSet.has(result.generatedSKU)) {
      duplicates++;
    } else {
      skuSet.add(result.generatedSKU);
    }

    generated.push(result);

    // Progress indicator
    if (i % 1000 === 0) {
      console.log(`Processed ${i} rows...`);
    }
  }

  console.log(`\n✅ Processing complete!`);
  console.log(`  Generated: ${generated.length} SKUs`);
  console.log(`  Unique SKUs: ${skuSet.size}`);
  console.log(`  Duplicates: ${duplicates}`);
  console.log(`  Skipped: ${skipped.length}\n`);

  if (skipped.length > 0 && skipped.length < 20) {
    console.log('Skipped rows:');
    skipped.forEach((s) => console.log(`  - ${s}`));
    console.log();
  }

  // Write output CSV
  const outputLines: string[] = [];
  outputLines.push(
    [
      'Original_Handle',
      'Title',
      'Plan_Type',
      'Validity',
      'Volume',
      'Price',
      'Generated_SKU',
      'Country_Code',
      'Package_Type',
      'Days_Count',
      'Data_Amount',
    ].join(','),
  );

  for (const item of generated) {
    outputLines.push(
      [
        item.originalHandle,
        `"${item.title.replace(/"/g, '""')}"`, // Escape quotes
        item.planType,
        item.validity,
        item.volume,
        item.price,
        item.generatedSKU,
        item.countryCode,
        item.packageType,
        item.daysCount,
        item.dataAmount,
      ].join(','),
    );
  }

  fs.writeFileSync(outputFile, outputLines.join('\n'), 'utf-8');
  console.log(`📄 Output written to: ${outputFile}\n`);

  // Statistics
  const byPackageType = generated.reduce(
    (acc, item) => {
      acc[item.packageType] = (acc[item.packageType] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const byCountry = generated.reduce(
    (acc, item) => {
      acc[item.countryCode] = (acc[item.countryCode] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  console.log('📊 Statistics:');
  console.log(`  Package Types:`);
  Object.entries(byPackageType).forEach(([type, count]) => {
    console.log(`    ${type}: ${count}`);
  });

  console.log(`\n  Top 10 Countries:`);
  Object.entries(byCountry)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([country, count]) => {
      console.log(`    ${country}: ${count}`);
    });

  console.log('\n✨ Phase 1 complete! Next steps:');
  console.log('  1. Review csv-exports/shopify-skus-generated.csv');
  console.log('  2. Run: npm run match:firoam\n');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
