/**
 * Phase 3: Generate Deployment Seed Script
 *
 * Reads shopify-firoam-mappings.csv and generates a deployable TypeScript seed script
 * Output: prisma/seed-all-mappings.ts
 *
 * Usage: npm run generate:seed
 */
import fs from 'fs';
import path from 'path';

interface MappingRecord {
  shopifySKU: string;
  shopifyHandle: string;
  shopifyCountryCode: string;
  shopifyPackageType: 'daypass' | 'fixed';
  shopifyDaysCount: number;
  shopifyDataAmount: string;
  shopifyPrice: string;
  firoamSkuId: number;
  firoamPriceId: number | null;
  firoamApiCode: string;
  firoamCountryName: string;
  matchStatus: string;
  matchConfidence: number;
}

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
 * Generate friendly name from SKU
 */
function generateName(record: MappingRecord): string {
  const type = record.shopifyPackageType === 'daypass' ? 'Daily' : 'Total';
  const days = record.shopifyDaysCount === 1 ? '1 Day' : `${record.shopifyDaysCount} Days`;
  return `${record.firoamCountryName} ${record.shopifyDataAmount} (${type}, ${days})`;
}

/**
 * Generate region from country
 */
function getRegion(countryName: string): string {
  const asiaCountries = [
    'Japan',
    'China',
    'Hong Kong',
    'Taiwan',
    'South Korea',
    'Singapore',
    'Malaysia',
    'Thailand',
    'Vietnam',
    'Philippines',
    'Indonesia',
    'India',
    'Laos',
    'Sri Lanka',
    'Cambodia',
  ];
  const europeCountries = [
    'United Kingdom',
    'Germany',
    'France',
    'Italy',
    'Spain',
    'Netherlands',
    'Switzerland',
    'Sweden',
    'Norway',
    'Denmark',
    'Finland',
    'Belgium',
    'Austria',
    'Poland',
    'Czech Republic',
    'Greece',
    'Portugal',
    'Ireland',
    'Serbia',
  ];
  const middleEastCountries = [
    'UAE',
    'Saudi Arabia',
    'Israel',
    'Turkey',
    'Bahrain',
    'Kuwait',
    'Oman',
    'Qatar',
    'Jordan',
  ];

  if (asiaCountries.includes(countryName)) return 'Asia';
  if (europeCountries.includes(countryName)) return 'Europe';
  if (middleEastCountries.includes(countryName)) return 'Middle East';
  return 'Other';
}

/**
 * Main function
 */
async function main() {
  console.log('🌱 Phase 3: Generate Deployment Seed Script\n');

  const inputFile = path.join(process.cwd(), 'csv-exports', 'shopify-firoam-mappings.csv');
  if (!fs.existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}. Run 'npm run match:firoam' first.`);
  }

  console.log('📦 Loading mappings...');
  const content = fs.readFileSync(inputFile, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());

  const records: MappingRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);

    const matchStatus = fields[11];
    if (matchStatus !== 'MATCHED') continue;

    const firoamSkuId = parseInt(fields[7], 10);
    const firoamPriceId = fields[8] ? parseInt(fields[8], 10) : null;

    if (isNaN(firoamSkuId)) continue;

    records.push({
      shopifySKU: fields[0],
      shopifyHandle: fields[1],
      shopifyCountryCode: fields[2],
      shopifyPackageType: fields[3] as 'daypass' | 'fixed',
      shopifyDaysCount: parseInt(fields[4], 10),
      shopifyDataAmount: fields[5],
      shopifyPrice: fields[6],
      firoamSkuId,
      firoamPriceId,
      firoamApiCode: fields[9],
      firoamCountryName: fields[10],
      matchStatus: fields[11],
      matchConfidence: parseInt(fields[12], 10),
    });
  }

  console.log(`  Loaded ${records.length} matched mappings\n`);

  // Generate TypeScript code
  console.log('📝 Generating seed script...');

  const outputLines: string[] = [];

  // Header
  outputLines.push(`/**`);
  outputLines.push(` * Auto-generated seed script for all Shopify → FiRoam SKU mappings`);
  outputLines.push(` * Generated: ${new Date().toISOString()}`);
  outputLines.push(` * Total Mappings: ${records.length}`);
  outputLines.push(` * `);
  outputLines.push(` * Usage: npm run seed:all-mappings`);
  outputLines.push(` */`);
  outputLines.push(`import { PrismaClient } from '@prisma/client';`);
  outputLines.push(``);
  outputLines.push(`const prisma = new PrismaClient();`);
  outputLines.push(``);
  outputLines.push(`async function main() {`);
  outputLines.push(`  console.log('🌱 Seeding all SKU mappings...\\n');`);
  outputLines.push(``);
  outputLines.push(`  const startTime = Date.now();`);
  outputLines.push(`  let inserted = 0;`);
  outputLines.push(`  let updated = 0;`);
  outputLines.push(`  let skipped = 0;`);
  outputLines.push(``);

  // Generate mappings in batches
  const batchSize = 100;
  const totalBatches = Math.ceil(records.length / batchSize);

  outputLines.push(`  // Total records: ${records.length}`);
  outputLines.push(`  // Batch size: ${batchSize}`);
  outputLines.push(`  // Total batches: ${totalBatches}`);
  outputLines.push(``);

  for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
    const start = batchNum * batchSize;
    const end = Math.min(start + batchSize, records.length);
    const batch = records.slice(start, end);

    outputLines.push(`  // Batch ${batchNum + 1}/${totalBatches} (${start + 1}-${end})`);
    outputLines.push(`  console.log('Processing batch ${batchNum + 1}/${totalBatches}...');`);
    outputLines.push(`  const batch${batchNum + 1} = [`);

    for (const record of batch) {
      const name = generateName(record);
      const region = getRegion(record.firoamCountryName);
      // Format: skuId:apiCode:priceId (e.g., "120:826-0-?-1-G-D:14094")
      // This ensures we always have both the apiCode (for reference) and numeric priceId (for ordering)
      const providerSku =
        record.firoamPriceId && record.firoamApiCode
          ? `${record.firoamSkuId}:${record.firoamApiCode}:${record.firoamPriceId}`
          : record.firoamApiCode
            ? `${record.firoamSkuId}:${record.firoamApiCode}`
            : `${record.firoamSkuId}:unknown`;

      outputLines.push(`    {`);
      outputLines.push(`      shopifySku: '${record.shopifySKU}',`);
      outputLines.push(`      provider: 'firoam',`);
      outputLines.push(`      providerSku: '${providerSku}',`);
      outputLines.push(`      packageType: '${record.shopifyPackageType}',`);
      outputLines.push(
        `      daysCount: ${record.shopifyPackageType === 'daypass' ? record.shopifyDaysCount : 'null'},`,
      );
      outputLines.push(`      name: '${name.replace(/'/g, "\\'")}',`);
      outputLines.push(`      region: '${region}',`);
      outputLines.push(`      dataAmount: '${record.shopifyDataAmount}',`);
      outputLines.push(
        `      validity: '${record.shopifyDaysCount} day${record.shopifyDaysCount > 1 ? 's' : ''}',`,
      );
      outputLines.push(`      isActive: true,`);
      outputLines.push(`    },`);
    }

    outputLines.push(`  ];`);
    outputLines.push(``);
    outputLines.push(`  for (const mapping of batch${batchNum + 1}) {`);
    outputLines.push(`    try {`);
    outputLines.push(`      const result = await prisma.providerSkuMapping.upsert({`);
    outputLines.push(`        where: { shopifySku: mapping.shopifySku },`);
    outputLines.push(`        update: mapping,`);
    outputLines.push(`        create: mapping,`);
    outputLines.push(`      });`);
    outputLines.push(`      if (result.createdAt === result.updatedAt) {`);
    outputLines.push(`        inserted++;`);
    outputLines.push(`      } else {`);
    outputLines.push(`        updated++;`);
    outputLines.push(`      }`);
    outputLines.push(`    } catch (err) {`);
    outputLines.push(
      `      console.error(\`  ❌ Failed to upsert \${mapping.shopifySku}:\`, (err as Error).message);`,
    );
    outputLines.push(`      skipped++;`);
    outputLines.push(`    }`);
    outputLines.push(`  }`);
    outputLines.push(``);
  }

  // Footer
  outputLines.push(`  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);`);
  outputLines.push(`  console.log('\\n✨ Seeding complete!');`);
  outputLines.push(`  console.log(\`  Inserted: \${inserted}\`);`);
  outputLines.push(`  console.log(\`  Updated: \${updated}\`);`);
  outputLines.push(`  console.log(\`  Skipped: \${skipped}\`);`);
  outputLines.push(`  console.log(\`  Time: \${elapsed}s\\n\`);`);
  outputLines.push(`}`);
  outputLines.push(``);
  outputLines.push(`main()`);
  outputLines.push(`  .catch((err) => {`);
  outputLines.push(`    console.error('❌ Seeding failed:', err);`);
  outputLines.push(`    process.exit(1);`);
  outputLines.push(`  })`);
  outputLines.push(`  .finally(async () => {`);
  outputLines.push(`    await prisma.$disconnect();`);
  outputLines.push(`  });`);

  // Write output
  const outputFile = path.join(process.cwd(), 'prisma', 'seed-all-mappings.ts');
  fs.writeFileSync(outputFile, outputLines.join('\n'), 'utf-8');

  console.log(`📄 Seed script generated: ${outputFile}`);
  console.log(`   Size: ${(fs.statSync(outputFile).size / 1024).toFixed(1)} KB`);
  console.log(`   Lines: ${outputLines.length.toLocaleString()}`);
  console.log(`   Batches: ${totalBatches}`);
  console.log(`   Records per batch: ${batchSize}\n`);

  // Statistics
  const byPackageType = records.reduce(
    (acc, r) => {
      acc[r.shopifyPackageType] = (acc[r.shopifyPackageType] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const byCountry = records.reduce(
    (acc, r) => {
      acc[r.firoamCountryName] = (acc[r.firoamCountryName] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const byConfidence = records.reduce(
    (acc, r) => {
      const key =
        r.matchConfidence >= 100
          ? '100 (Exact)'
          : r.matchConfidence >= 70
            ? '70-99 (Good)'
            : '50-69 (Partial)';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  console.log('📊 Statistics:');
  console.log('  Package Types:');
  Object.entries(byPackageType)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => {
      console.log(`    ${type}: ${count}`);
    });

  console.log('\n  Match Confidence:');
  Object.entries(byConfidence)
    .sort((a, b) => b[1] - a[1])
    .forEach(([conf, count]) => {
      console.log(`    ${conf}: ${count}`);
    });

  console.log('\n  Top 10 Countries:');
  Object.entries(byCountry)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([country, count]) => {
      console.log(`    ${country}: ${count}`);
    });

  console.log('\n✨ Phase 3 complete! Next steps:');
  console.log('  1. Review prisma/seed-all-mappings.ts');
  console.log('  2. Run: npm run seed:all-mappings');
  console.log('  3. Update Shopify product SKUs to match generated SKUs\n');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
