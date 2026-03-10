/**
 * Phase 4: Verify Database Mappings
 *
 * Compares generated Shopify SKUs with database mappings
 * Reports: coverage, missing mappings, orphaned mappings
 *
 * Usage: npm run verify:mappings
 */
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface ShopifySKU {
  handle: string;
  sku: string;
  countryCode: string;
  packageType: string;
  daysCount: string;
  dataAmount: string;
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

async function main() {
  console.log('🔍 Phase 4: Verify Database Mappings\n');

  // Load updated Shopify export with SKUs
  const csvPath = path.join(process.cwd(), 'products_export_updated.csv');
  if (!fs.existsSync(csvPath)) {
    throw new Error(`File not found: ${csvPath}. Run 'npm run update:export' first.`);
  }

  console.log('📦 Loading Shopify products with SKUs...');
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());

  const shopifySkus = new Set<string>();
  const shopifyDetails: Map<string, ShopifySKU> = new Map();

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const handle = fields[0];
    const variantSku = fields[17]; // Variant SKU column

    if (!variantSku || !variantSku.trim()) continue;

    // Parse SKU components
    const parts = variantSku.split('-');
    if (parts.length < 4) continue;

    const countryCode = parts[0];
    const dataAmount = parts[1];
    const daysWithD = parts[2]; // e.g., "1D"
    const packageType = parts[3];
    const daysCount = daysWithD.replace('D', '');

    shopifySkus.add(variantSku);

    if (!shopifyDetails.has(variantSku)) {
      shopifyDetails.set(variantSku, {
        handle,
        sku: variantSku,
        countryCode,
        packageType: packageType.toLowerCase(),
        daysCount,
        dataAmount,
      });
    }
  }

  console.log(`  Found ${shopifySkus.size} unique Shopify SKUs\n`);

  // Load database mappings
  console.log('🗄️  Loading database mappings...');
  const dbMappings = await prisma.providerSkuMapping.findMany({
    select: {
      shopifySku: true,
      providerSku: true,
      packageType: true,
      isActive: true,
    },
  });

  const dbSkus = new Set(dbMappings.map((m) => m.shopifySku));
  console.log(`  Found ${dbSkus.size} SKUs in database\n`);

  // Compare
  console.log('📊 Analysis:\n');

  const inShopifyNotInDb = Array.from(shopifySkus).filter((sku) => !dbSkus.has(sku));
  const inDbNotInShopify = Array.from(dbSkus).filter((sku) => !shopifySkus.has(sku));
  const inBoth = Array.from(shopifySkus).filter((sku) => dbSkus.has(sku));

  const coverage = ((inBoth.length / shopifySkus.size) * 100).toFixed(1);

  console.log(`  ✅ In Both: ${inBoth.length} (${coverage}%)`);
  console.log(`  ❌ In Shopify, Missing from DB: ${inShopifyNotInDb.length}`);
  console.log(`  ⚠️  In DB, Not in Shopify: ${inDbNotInShopify.length}\n`);

  // Missing mappings details
  if (inShopifyNotInDb.length > 0) {
    console.log('❌ Missing Mappings (not in database):');
    console.log('   These Shopify products cannot be fulfilled:\n');

    const byCountry: Record<string, number> = {};
    const byType: Record<string, number> = {};

    inShopifyNotInDb.forEach((sku) => {
      const parts = sku.split('-');
      const country = parts[0];
      const type = parts[parts.length - 1];

      byCountry[country] = (byCountry[country] || 0) + 1;
      byType[type] = (byType[type] || 0) + 1;
    });

    console.log('   By Country:');
    Object.entries(byCountry)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .forEach(([country, count]) => {
        console.log(`     ${country}: ${count}`);
      });

    console.log('\n   By Type:');
    Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .forEach(([type, count]) => {
        console.log(`     ${type}: ${count}`);
      });

    // Write missing SKUs to file
    const missingFile = path.join(process.cwd(), 'csv-exports', 'shopify-missing-mappings.csv');
    const missingLines = ['SKU,Handle,Country_Code,Package_Type,Days_Count,Data_Amount'];
    inShopifyNotInDb.forEach((sku) => {
      const detail = shopifyDetails.get(sku);
      if (detail) {
        missingLines.push(
          `${sku},${detail.handle},${detail.countryCode},${detail.packageType},${detail.daysCount},${detail.dataAmount}`,
        );
      }
    });
    fs.writeFileSync(missingFile, missingLines.join('\n'), 'utf-8');
    console.log(`\n   📄 Full list: csv-exports/shopify-missing-mappings.csv\n`);
  }

  // Orphaned mappings
  if (inDbNotInShopify.length > 0) {
    console.log('⚠️  Orphaned Mappings (in database but not in Shopify):');
    console.log(
      `   ${inDbNotInShopify.length} mappings don't correspond to current Shopify products`,
    );
    console.log('   These may be from old products or test data\n');

    const orphanedFile = path.join(process.cwd(), 'csv-exports', 'database-orphaned-mappings.csv');
    fs.writeFileSync(orphanedFile, ['SKU'].concat(inDbNotInShopify).join('\n'), 'utf-8');
    console.log(`   📄 Full list: csv-exports/database-orphaned-mappings.csv\n`);
  }

  // Summary
  console.log('📈 Summary:');
  console.log(`   Total Shopify Products: ${shopifySkus.size}`);
  console.log(`   Total Database Mappings: ${dbSkus.size}`);
  console.log(`   Coverage: ${coverage}%`);
  console.log(`   Ready to Fulfill: ${inBoth.length} products`);
  console.log(`   Need Manual Review: ${inShopifyNotInDb.length} products\n`);

  if (inShopifyNotInDb.length === 0) {
    console.log('✨ Perfect! All Shopify products have database mappings.\n');
  } else {
    console.log('💡 Next Steps:');
    console.log('   1. Review csv-exports/shopify-missing-mappings.csv');
    console.log('   2. Check if FiRoam offers these packages');
    console.log('   3. Consider alternative providers or remove from store\n');
  }
}

main()
  .catch((err) => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
