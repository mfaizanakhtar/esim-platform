/**
 * Analyze Missing SKU Mappings
 *
 * Cross-references missing Shopify SKUs with FiRoam catalog
 * to determine if products are actually unavailable or just mismatched
 *
 * Usage: npm run analyze:missing
 */
import fs from 'fs';
import path from 'path';

interface MissingSKU {
  sku: string;
  handle: string;
  countryCode: string;
  packageType: string;
  daysCount: number;
  dataAmount: string;
}

interface FiRoamCountry {
  skuId: number;
  name: string;
  code: number;
}

interface FiRoamPackage {
  skuId: number;
  name: string;
  apiCode: string;
  dataAmount: number;
  unit: string;
  days: number;
  supportDaypass: boolean;
}

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

function normalizeDataAmount(dataStr: string): { amount: number; unit: string } {
  const cleaned = dataStr.replace(/\s+/g, '').toUpperCase();

  const gbMatch = cleaned.match(/(\d+(?:\.\d+)?)GB/);
  if (gbMatch) {
    return { amount: parseFloat(gbMatch[1]), unit: 'GB' };
  }

  const mbMatch = cleaned.match(/(\d+)MB/);
  if (mbMatch) {
    return { amount: parseInt(mbMatch[1], 10), unit: 'MB' };
  }

  return { amount: 0, unit: '' };
}

async function main() {
  console.log('🔍 Analyze Missing SKU Mappings\n');

  // Load FiRoam countries
  const countriesFile = path.join(process.cwd(), 'firoam-data', 'firoam-skus.csv');
  const countriesContent = fs.readFileSync(countriesFile, 'utf-8');
  const countriesLines = countriesContent.split('\n').filter((l) => l.trim());

  const firoamCountries: Map<number, FiRoamCountry> = new Map();
  const countryNameToId: Map<string, number> = new Map();

  for (let i = 1; i < countriesLines.length; i++) {
    const fields = parseCSVLine(countriesLines[i]);
    const skuId = parseInt(fields[0], 10);
    const name = fields[1];
    const code = parseInt(fields[2], 10);

    firoamCountries.set(skuId, { skuId, name, code });
    countryNameToId.set(name.toLowerCase(), skuId);
  }

  console.log(`📦 Loaded ${firoamCountries.size} FiRoam countries\n`);

  // Load missing SKUs
  const missingFile = path.join(process.cwd(), 'csv-exports', 'shopify-missing-mappings.csv');
  if (!fs.existsSync(missingFile)) {
    throw new Error(`File not found: ${missingFile}. Run 'npm run verify:mappings' first.`);
  }

  const missingContent = fs.readFileSync(missingFile, 'utf-8');
  const missingLines = missingContent.split('\n').filter((l) => l.trim());

  const missingSkus: MissingSKU[] = [];

  for (let i = 1; i < missingLines.length; i++) {
    const fields = parseCSVLine(missingLines[i]);
    const sku = fields[0];
    const handle = fields[1];
    const countryCode = fields[2];
    const packageType = fields[3];
    const daysCount = parseInt(fields[4], 10);
    const dataAmount = fields[5];

    missingSkus.push({
      sku,
      handle,
      countryCode,
      packageType,
      daysCount,
      dataAmount,
    });
  }

  console.log(`📦 Loaded ${missingSkus.length} missing SKUs\n`);

  // Analyze categories
  const categories = {
    truncatedCountryCodes: 0,
    globalOrTemplate: 0,
    daypassNotSupported: 0,
    dataAmountNotOffered: 0,
    daysCountNotOffered: 0,
    countryNotInFiroam: 0,
    actuallyAvailable: 0,
  };

  const truncatedCodes = [
    'UKRAIN',
    'SWEDEN',
    'SLOVEN',
    'ROMANI',
    'LUXEMB',
    'LITHUA',
    'LIECHT',
    'LATVIA',
    'GREENL',
    'GIBRAL',
    'TAJIKI',
    'MONGOL',
    'SANMAR',
  ];
  const actuallyAvailable: MissingSKU[] = [];

  for (const missing of missingSkus) {
    // Check truncated country codes
    if (truncatedCodes.includes(missing.countryCode)) {
      categories.truncatedCountryCodes++;
      continue;
    }

    // Check global/template
    if (missing.countryCode === 'GLOBAL' || missing.countryCode === 'TEMPLATE') {
      categories.globalOrTemplate++;
      continue;
    }

    // Try to find FiRoam country
    const countryName = missing.handle.replace(/-/g, ' ').toLowerCase();
    const firoamSkuId = countryNameToId.get(countryName);

    if (!firoamSkuId) {
      categories.countryNotInFiroam++;
      continue;
    }

    // Load FiRoam packages for this country
    const country = firoamCountries.get(firoamSkuId);
    if (!country) continue;

    const packagesFile = path.join(
      process.cwd(),
      'firoam-data',
      `firoam-packages-${country.code}.csv`,
    );
    if (!fs.existsSync(packagesFile)) {
      categories.countryNotInFiroam++;
      continue;
    }

    const packagesContent = fs.readFileSync(packagesFile, 'utf-8');
    const packagesLines = packagesContent.split('\n').filter((l) => l.trim());

    const packages: FiRoamPackage[] = [];
    for (let j = 1; j < packagesLines.length; j++) {
      const fields = parseCSVLine(packagesLines[j]);
      packages.push({
        skuId: parseInt(fields[0], 10),
        name: fields[1],
        apiCode: fields[2],
        dataAmount: parseInt(fields[3], 10),
        unit: fields[4],
        days: parseInt(fields[5], 10),
        supportDaypass: fields[9] === '1',
      });
    }

    // Check if this exact package exists
    const normalized = normalizeDataAmount(missing.dataAmount);
    const isDaypass = missing.packageType === 'daypass';

    // Check if daypass is supported
    if (isDaypass && !packages.some((p) => p.supportDaypass)) {
      categories.daypassNotSupported++;
      continue;
    }

    // Check for exact match
    const exactMatch = packages.find((p) => {
      const dataMatch = p.dataAmount === normalized.amount && p.unit === normalized.unit;
      const daysMatch = p.days === missing.daysCount;
      const typeMatch = isDaypass ? p.supportDaypass : !p.supportDaypass;
      return dataMatch && daysMatch && typeMatch;
    });

    if (exactMatch) {
      categories.actuallyAvailable++;
      actuallyAvailable.push(missing);
      continue;
    }

    // Check what's missing
    const dataExists = packages.some(
      (p) => p.dataAmount === normalized.amount && p.unit === normalized.unit,
    );
    const daysExists = packages.some((p) => p.days === missing.daysCount);

    if (!dataExists) {
      categories.dataAmountNotOffered++;
    } else if (!daysExists) {
      categories.daysCountNotOffered++;
    }
  }

  // Report
  console.log('📊 Analysis Results:\n');
  console.log(`  Total Missing: ${missingSkus.length}`);
  console.log(
    `\n  🔴 Truncated Country Codes: ${categories.truncatedCountryCodes} (${((categories.truncatedCountryCodes / missingSkus.length) * 100).toFixed(1)}%)`,
  );
  console.log(`     These are mapping errors - countries like UKRAIN, SWEDEN, etc.`);
  console.log(
    `\n  🟠 Global/Template: ${categories.globalOrTemplate} (${((categories.globalOrTemplate / missingSkus.length) * 100).toFixed(1)}%)`,
  );
  console.log(`     Regional or test products`);
  console.log(
    `\n  🟡 Daypass Not Supported: ${categories.daypassNotSupported} (${((categories.daypassNotSupported / missingSkus.length) * 100).toFixed(1)}%)`,
  );
  console.log(`     Country exists but doesn't support daypass packages`);
  console.log(
    `\n  🟢 Data Amount Not Offered: ${categories.dataAmountNotOffered} (${((categories.dataAmountNotOffered / missingSkus.length) * 100).toFixed(1)}%)`,
  );
  console.log(`     FiRoam doesn't offer this data amount for this country`);
  console.log(
    `\n  🔵 Days Count Not Offered: ${categories.daysCountNotOffered} (${((categories.daysCountNotOffered / missingSkus.length) * 100).toFixed(1)}%)`,
  );
  console.log(`     FiRoam doesn't offer this duration for this country`);
  console.log(
    `\n  ⚪ Country Not in FiRoam: ${categories.countryNotInFiroam} (${((categories.countryNotInFiroam / missingSkus.length) * 100).toFixed(1)}%)`,
  );
  console.log(`     FiRoam doesn't cover this country at all`);
  console.log(
    `\n  ✅ Actually Available: ${categories.actuallyAvailable} (${((categories.actuallyAvailable / missingSkus.length) * 100).toFixed(1)}%)`,
  );
  console.log(`     These exist in FiRoam but didn't match during Phase 2`);

  if (actuallyAvailable.length > 0) {
    console.log(`\n⚠️  Found ${actuallyAvailable.length} SKUs that should have matched!`);
    console.log(`   Sample:`);
    actuallyAvailable.slice(0, 10).forEach((sku) => {
      console.log(`     ${sku.sku} (${sku.handle})`);
    });

    const outputFile = path.join(process.cwd(), 'csv-exports', 'should-have-matched.csv');
    const lines = ['SKU,Handle,Country_Code,Package_Type,Days_Count,Data_Amount'];
    actuallyAvailable.forEach((sku) => {
      lines.push(
        `${sku.sku},${sku.handle},${sku.countryCode},${sku.packageType},${sku.daysCount},${sku.dataAmount}`,
      );
    });
    fs.writeFileSync(outputFile, lines.join('\n'), 'utf-8');
    console.log(`\n   📄 Full list: csv-exports/should-have-matched.csv`);
  }

  console.log(`\n💡 Recommendations:`);
  console.log(`   1. Fix truncated country codes (${categories.truncatedCountryCodes} SKUs)`);
  console.log(
    `   2. Remove or hide Global/Template products (${categories.globalOrTemplate} SKUs)`,
  );
  console.log(
    `   3. Consider removing products FiRoam doesn't offer (${categories.dataAmountNotOffered + categories.daysCountNotOffered + categories.countryNotInFiroam} SKUs)`,
  );
  console.log(
    `   4. Investigate why ${categories.actuallyAvailable} available products didn't match\n`,
  );
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
