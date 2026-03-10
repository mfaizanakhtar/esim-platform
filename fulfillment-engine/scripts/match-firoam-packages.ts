/**
 * Phase 2: Match Shopify SKUs with FiRoam Packages
 *
 * Reads shopify-skus-generated.csv and matches with FiRoam packages
 * Output: shopify-firoam-mappings.csv
 *
 * Usage: npm run match:firoam
 */
import fs from 'fs';
import path from 'path';

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

interface FiRoamCountry {
  skuId: number;
  displayName: string;
  countryCode: number;
  region: string;
}

interface FiRoamPackage {
  skuId: number;
  skuName: string;
  priceId?: number;
  apiCode: string;
  dataAmount: number;
  unit: string;
  days: number;
  priceUSD: number;
  supportDaypass: number;
}

interface MatchResult {
  shopifySKU: string;
  shopifyHandle: string;
  shopifyCountryCode: string;
  shopifyPackageType: string;
  shopifyDaysCount: number;
  shopifyDataAmount: string;
  shopifyPrice: string;
  firoamSkuId: number | null;
  firoamPriceId: number | null;
  firoamApiCode: string | null;
  firoamCountryName: string | null;
  matchStatus: 'MATCHED' | 'NO_COUNTRY' | 'NO_PACKAGE' | 'AMBIGUOUS';
  matchConfidence: number;
  matchNotes: string;
}

// Map Shopify country codes to FiRoam country codes (ISO numeric)
// Only ISO codes - truncated codes removed after generation script fix
const COUNTRY_CODE_MAP: Record<string, number> = {
  AF: 4, // Afghanistan
  AL: 8, // Albania
  AD: 20, // Andorra
  AM: 51, // Armenia
  AT: 40, // Austria
  AZ: 31, // Azerbaijan
  BH: 48, // Bahrain
  BD: 50, // Bangladesh
  BY: 112, // Belarus
  BE: 56, // Belgium
  BA: 70, // Bosnia-Herzegovina
  BG: 100, // Bulgaria
  KH: 116, // Cambodia
  CA: 124, // Canada
  CN: 156, // China
  HR: 191, // Croatia
  CY: 196, // Cyprus
  CZ: 203, // Czech Republic
  DK: 208, // Denmark
  EE: 233, // Estonia
  FO: 234, // Faeroe Islands
  FI: 246, // Finland
  FR: 250, // France
  GE: 268, // Georgia
  DE: 276, // Germany
  GI: 292, // Gibraltar
  GR: 300, // Greece
  GL: 304, // Greenland
  HK: 344, // Hong Kong
  HU: 348, // Hungary
  IS: 352, // Iceland
  IN: 356, // India
  ID: 360, // Indonesia
  IE: 372, // Ireland
  IL: 376, // Israel
  IT: 380, // Italy
  JP: 392, // Japan
  JO: 400, // Jordan
  KZ: 398, // Kazakhstan
  KW: 414, // Kuwait
  KG: 417, // Kyrgyzstan
  LA: 418, // Laos
  LV: 428, // Latvia
  LI: 438, // Liechtenstein
  LT: 440, // Lithuania
  LU: 442, // Luxembourg
  MO: 446, // Macau
  MK: 807, // Macedonia
  MY: 458, // Malaysia
  MV: 462, // Maldives
  MT: 470, // Malta
  MU: 480, // Mauritius
  MX: 484, // Mexico
  MD: 498, // Moldova
  MN: 496, // Mongolia
  ME: 499, // Montenegro
  MA: 504, // Morocco
  NP: 524, // Nepal
  NL: 528, // Netherlands
  NO: 578, // Norway
  OM: 512, // Oman
  PK: 586, // Pakistan
  PH: 608, // Philippines
  PL: 616, // Poland
  PT: 620, // Portugal
  QA: 634, // Qatar
  RO: 642, // Romania
  RU: 643, // Russia
  SM: 674, // San Marino
  SA: 682, // Saudi Arabia
  RS: 891, // Serbia (FiRoam custom code)
  SG: 702, // Singapore
  SK: 703, // Slovakia
  SI: 705, // Slovenia
  KR: 410, // South Korea
  ES: 724, // Spain
  LK: 144, // Sri Lanka
  SE: 752, // Sweden
  CH: 756, // Switzerland
  TW: 158, // Taiwan
  TJ: 762, // Tajikistan
  TH: 764, // Thailand
  TR: 792, // Turkey
  AE: 784, // UAE
  UA: 804, // Ukraine
  GB: 826, // United Kingdom
  US: 840, // United States
  UZ: 860, // Uzbekistan
  VN: 704, // Vietnam
  // Regional/Global plans
  GLOBAL: 99911, // Global (supports 86+ countries)
  TEMPLATE: 0, // Template/Test products
  ASIA: 0, // Asia region
  ASIA4: 0, // Asia-4 region
  ASIA8: 0, // Asia-8 region
  EU: 0, // Europe region
  CAR: 0, // Caribbean region
  LATAM: 0, // Latin America region
};

/**
 * Parse CSV line
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
 * Load FiRoam countries
 */
function loadFiRoamCountries(): Map<number, FiRoamCountry> {
  const file = path.join(process.cwd(), 'firoam-data', 'firoam-skus.csv');
  if (!fs.existsSync(file)) {
    throw new Error(`FiRoam countries file not found: ${file}`);
  }

  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());
  const countries = new Map<number, FiRoamCountry>();

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 3) continue;

    const skuId = parseInt(fields[0], 10);
    const displayName = fields[1].replace(/"/g, '');
    const countryCode = parseInt(fields[2], 10);
    const region = fields[3] || '';

    if (!isNaN(skuId) && !isNaN(countryCode)) {
      countries.set(countryCode, { skuId, displayName, countryCode, region });
    }
  }

  return countries;
}

/**
 * Load FiRoam packages for a specific country
 */
function loadFiRoamPackages(countryCode: number): FiRoamPackage[] {
  const file = path.join(process.cwd(), 'firoam-data', `firoam-packages-${countryCode}.csv`);

  if (!fs.existsSync(file)) {
    return [];
  }

  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());
  const packages: FiRoamPackage[] = [];

  // CSV format: SKU_ID,SKU_Name,Price_ID,API_Code,Data_Amount,Unit,Days,Price_USD,Flow_Type,Expire_Days,Support_Daypass,Must_Date
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 11) continue;

    const skuId = parseInt(fields[0], 10);
    const skuName = fields[1].replace(/"/g, '');
    const priceId = parseInt(fields[2], 10);
    const apiCode = fields[3].replace(/"/g, '');
    const dataAmount = parseInt(fields[4], 10);
    const unit = fields[5].replace(/"/g, '');
    const days = parseInt(fields[6], 10);
    const priceUSD = parseFloat(fields[7]);
    const supportDaypass = parseInt(fields[10], 10);

    if (!isNaN(skuId) && !isNaN(dataAmount) && !isNaN(days) && !isNaN(priceId)) {
      packages.push({
        skuId,
        skuName,
        priceId,
        apiCode,
        dataAmount,
        unit,
        days,
        priceUSD,
        supportDaypass,
      });
    }
  }

  return packages;
}

/**
 * Normalize data for comparison
 */
function normalizeData(dataAmount: string): { value: number; unit: 'MB' | 'GB' } {
  const match = dataAmount.match(/(\d+)(GB|MB)/i);
  if (!match) return { value: 0, unit: 'MB' };

  let value = parseInt(match[1], 10);
  const unit = match[2].toUpperCase() as 'MB' | 'GB';

  // Convert to MB for comparison
  if (unit === 'GB') {
    value = value * 1024;
  }

  return { value, unit };
}

/**
 * Match Shopify SKU with FiRoam package
 */
function matchPackage(
  sku: GeneratedSKU,
  firoamCountry: FiRoamCountry,
  packages: FiRoamPackage[],
): Omit<
  MatchResult,
  | 'shopifySKU'
  | 'shopifyHandle'
  | 'shopifyCountryCode'
  | 'shopifyPackageType'
  | 'shopifyDaysCount'
  | 'shopifyDataAmount'
  | 'shopifyPrice'
> {
  const shopifyData = normalizeData(sku.dataAmount);
  const isDaypass = sku.packageType === 'daypass';

  // Filter packages by type (daypass vs fixed)
  const typeMatches = packages.filter((p) => {
    if (isDaypass) return p.supportDaypass === 1;
    return p.supportDaypass === 0;
  });

  if (typeMatches.length === 0) {
    return {
      firoamSkuId: firoamCountry.skuId,
      firoamPriceId: null,
      firoamApiCode: null,
      firoamCountryName: firoamCountry.displayName,
      matchStatus: 'NO_PACKAGE',
      matchConfidence: 0,
      matchNotes: `No ${isDaypass ? 'daypass' : 'fixed'} packages found`,
    };
  }

  // Match by data amount and days
  const candidates = typeMatches.map((pkg) => {
    let score = 0;
    const notes: string[] = [];

    // Convert package data to MB
    let pkgDataMB = pkg.dataAmount;
    if (pkg.unit.toUpperCase() === 'GB' || pkg.unit === 'G') {
      pkgDataMB = pkg.dataAmount * 1024;
    }

    // Exact data match
    if (pkgDataMB === shopifyData.value) {
      score += 50;
      notes.push('exact_data');
    } else {
      // Partial data match (within 10%)
      const diff = Math.abs(pkgDataMB - shopifyData.value) / shopifyData.value;
      if (diff < 0.1) {
        score += 30;
        notes.push('close_data');
      }
    }

    // Days match
    if (pkg.days === sku.daysCount) {
      score += 50;
      notes.push('exact_days');
    } else {
      // Close days match
      const daysDiff = Math.abs(pkg.days - sku.daysCount);
      if (daysDiff <= 1) {
        score += 20;
        notes.push('close_days');
      }
    }

    return { pkg, score, notes };
  });

  // Sort by score
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];

  if (best.score >= 80) {
    // High confidence match
    return {
      firoamSkuId: firoamCountry.skuId,
      firoamPriceId: best.pkg.priceId || null,
      firoamApiCode: best.pkg.apiCode,
      firoamCountryName: firoamCountry.displayName,
      matchStatus: 'MATCHED',
      matchConfidence: best.score,
      matchNotes: best.notes.join(', '),
    };
  } else if (best.score >= 50) {
    // Moderate match
    return {
      firoamSkuId: firoamCountry.skuId,
      firoamPriceId: best.pkg.priceId || null,
      firoamApiCode: best.pkg.apiCode,
      firoamCountryName: firoamCountry.displayName,
      matchStatus: 'MATCHED',
      matchConfidence: best.score,
      matchNotes: `partial_match: ${best.notes.join(', ')}`,
    };
  } else {
    // No good match
    return {
      firoamSkuId: firoamCountry.skuId,
      firoamPriceId: null,
      firoamApiCode: null,
      firoamCountryName: firoamCountry.displayName,
      matchStatus: 'NO_PACKAGE',
      matchConfidence: best.score,
      matchNotes: `low_confidence: ${best.notes.join(', ')}`,
    };
  }
}

/**
 * Main function
 */
async function main() {
  console.log('🔍 Phase 2: Match Shopify SKUs with FiRoam Packages\n');

  // Load generated SKUs
  const inputFile = path.join(process.cwd(), 'csv-exports', 'shopify-skus-generated.csv');
  if (!fs.existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}. Run 'npm run generate:skus' first.`);
  }

  console.log('📦 Loading Shopify SKUs...');
  const content = fs.readFileSync(inputFile, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());

  const skus: GeneratedSKU[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    skus.push({
      originalHandle: fields[0],
      title: fields[1],
      planType: fields[2],
      validity: fields[3],
      volume: fields[4],
      price: fields[5],
      generatedSKU: fields[6],
      countryCode: fields[7],
      packageType: fields[8] as 'daypass' | 'fixed',
      daysCount: parseInt(fields[9], 10),
      dataAmount: fields[10],
    });
  }
  console.log(`  Loaded ${skus.length} SKUs\n`);

  // Load FiRoam data
  console.log('🌍 Loading FiRoam countries...');
  const firoamCountries = loadFiRoamCountries();
  console.log(`  Loaded ${firoamCountries.size} countries\n`);

  // Match each SKU
  console.log('🔗 Matching SKUs with FiRoam packages...\n');
  const results: MatchResult[] = [];
  const stats = {
    matched: 0,
    noCountry: 0,
    noPackage: 0,
    total: skus.length,
  };

  for (let i = 0; i < skus.length; i++) {
    const sku = skus[i];

    // Find FiRoam country
    const firoamCountryCode = COUNTRY_CODE_MAP[sku.countryCode];
    const firoamCountry = firoamCountryCode ? firoamCountries.get(firoamCountryCode) : undefined;

    if (!firoamCountry) {
      results.push({
        shopifySKU: sku.generatedSKU,
        shopifyHandle: sku.originalHandle,
        shopifyCountryCode: sku.countryCode,
        shopifyPackageType: sku.packageType,
        shopifyDaysCount: sku.daysCount,
        shopifyDataAmount: sku.dataAmount,
        shopifyPrice: sku.price,
        firoamSkuId: null,
        firoamPriceId: null,
        firoamApiCode: null,
        firoamCountryName: null,
        matchStatus: 'NO_COUNTRY',
        matchConfidence: 0,
        matchNotes: `No FiRoam country mapping for ${sku.countryCode}`,
      });
      stats.noCountry++;
      continue;
    }

    // Load packages for this country
    const packages = loadFiRoamPackages(firoamCountry.countryCode);

    // Match package
    const match = matchPackage(sku, firoamCountry, packages);

    results.push({
      shopifySKU: sku.generatedSKU,
      shopifyHandle: sku.originalHandle,
      shopifyCountryCode: sku.countryCode,
      shopifyPackageType: sku.packageType,
      shopifyDaysCount: sku.daysCount,
      shopifyDataAmount: sku.dataAmount,
      shopifyPrice: sku.price,
      ...match,
    });

    if (match.matchStatus === 'MATCHED') stats.matched++;
    else if (match.matchStatus === 'NO_PACKAGE') stats.noPackage++;

    // Progress
    if ((i + 1) % 1000 === 0) {
      console.log(`  Processed ${i + 1}/${skus.length} SKUs...`);
    }
  }

  console.log(`\n✅ Matching complete!\n`);
  console.log('📊 Statistics:');
  console.log(`  Total SKUs: ${stats.total}`);
  console.log(`  Matched: ${stats.matched} (${((stats.matched / stats.total) * 100).toFixed(1)}%)`);
  console.log(
    `  No Country Mapping: ${stats.noCountry} (${((stats.noCountry / stats.total) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  No Package Match: ${stats.noPackage} (${((stats.noPackage / stats.total) * 100).toFixed(1)}%)\n`,
  );

  // Write output
  const outputFile = path.join(process.cwd(), 'csv-exports', 'shopify-firoam-mappings.csv');
  const outputLines: string[] = [];
  outputLines.push(
    [
      'Shopify_SKU',
      'Shopify_Handle',
      'Shopify_Country_Code',
      'Shopify_Package_Type',
      'Shopify_Days_Count',
      'Shopify_Data_Amount',
      'Shopify_Price',
      'FiRoam_SKU_ID',
      'FiRoam_Price_ID',
      'FiRoam_API_Code',
      'FiRoam_Country_Name',
      'Match_Status',
      'Match_Confidence',
      'Match_Notes',
    ].join(','),
  );

  for (const result of results) {
    outputLines.push(
      [
        result.shopifySKU,
        result.shopifyHandle,
        result.shopifyCountryCode,
        result.shopifyPackageType,
        result.shopifyDaysCount,
        result.shopifyDataAmount,
        result.shopifyPrice,
        result.firoamSkuId || '',
        result.firoamPriceId || '',
        result.firoamApiCode || '',
        result.firoamCountryName || '',
        result.matchStatus,
        result.matchConfidence,
        `"${result.matchNotes}"`,
      ].join(','),
    );
  }

  fs.writeFileSync(outputFile, outputLines.join('\n'), 'utf-8');
  console.log(`📄 Output written to: ${outputFile}\n`);

  console.log('✨ Phase 2 complete! Next steps:');
  console.log('  1. Review csv-exports/shopify-firoam-mappings.csv');
  console.log('  2. Check Match_Status and Match_Confidence columns');
  console.log('  3. Run: npm run generate:seed\n');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
