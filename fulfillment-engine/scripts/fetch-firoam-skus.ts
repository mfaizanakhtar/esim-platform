#!/usr/bin/env ts-node
/**
 * Fetch and display available FiRoam SKUs with package details
 * Saves results to CSV files in the project root
 */
import FiRoamClient from '../src/vendor/firoamClient';
import * as fs from 'fs';
import * as path from 'path';

interface SkuItem {
  skuid: number;
  display: string;
  countryCode: string;
  imageUrl?: string;
}

interface GroupedData {
  continent: string[];
  data: Record<string, SkuItem[]>;
}

async function main() {
  const client = new FiRoamClient();

  console.log('🔍 Fetching FiRoam SKUs...\n');

  // Get SKUs grouped by continent - use raw response since schema has validation issues
  const { raw } = await client.getSkuByGroup();

  if (!raw || raw.code !== '0') {
    console.error('❌ Failed to fetch SKUs');
    console.log('\nRaw response:', JSON.stringify(raw, null, 2));
    process.exit(1);
  }

  const grouped = raw.data as GroupedData;

  console.log('✅ Available FiRoam SKUs by Continent:\n');
  console.log(`📍 CONTINENTS: ${grouped.continent.join(', ')}\n`);
  console.log('─'.repeat(70));

  let totalSkus = 0;
  for (const [region, skus] of Object.entries(grouped.data)) {
    const skuList = skus;
    totalSkus += skuList.length;
    console.log(`\n${region.toUpperCase()} (${skuList.length} SKUs):`);
    for (const sku of skuList.slice(0, 5)) {
      // Show first 5 only
      console.log(`  • SKU ${sku.skuid}: ${sku.display}`);
    }
    if (skuList.length > 5) {
      console.log(`  ... and ${skuList.length - 5} more`);
    }
  }

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`📊 Total SKUs available: ${totalSkus}`);

  // Create output directory
  const outputDir = path.join(process.cwd(), 'firoam-data');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Save all SKUs to CSV
  console.log('\n💾 Saving SKUs to CSV...');
  const skusCsvPath = path.join(outputDir, 'firoam-skus.csv');
  const skusCsvHeader = 'SKU_ID,Display_Name,Country_Code,Region,Image_URL\n';
  let skusCsvContent = skusCsvHeader;

  // Collect all SKUs with their metadata
  const allSkus: Array<{ id: number; name: string; countryCode: string; region: string }> = [];

  for (const [region, skus] of Object.entries(grouped.data)) {
    const skuList = skus;
    for (const sku of skuList) {
      const row = [
        sku.skuid,
        `"${sku.display.replace(/"/g, '""')}"`,
        sku.countryCode,
        `"${region}"`,
        `"${sku.imageUrl || ''}"`,
      ].join(',');
      skusCsvContent += row + '\n';

      // Collect for package fetching
      allSkus.push({
        id: sku.skuid,
        name: sku.display,
        countryCode: sku.countryCode,
        region,
      });
    }
  }

  fs.writeFileSync(skusCsvPath, skusCsvContent, 'utf-8');
  console.log(`✅ Saved ${totalSkus} SKUs to: ${skusCsvPath}`);

  // Fetch package details for ALL SKUs
  console.log(
    `\n\n🔍 Fetching package details for all ${allSkus.length} SKUs (this may take a few minutes)...\n`,
  );

  const packagesCsvHeader =
    'SKU_ID,SKU_Name,Price_ID,API_Code,Data_Amount,Unit,Days,Price_USD,Flow_Type,Expire_Days,Support_Daypass,Must_Date\n';

  let processedCount = 0;
  let failedCount = 0;

  for (const sku of allSkus) {
    processedCount++;
    const percent = Math.round((processedCount / allSkus.length) * 100);
    process.stdout.write(
      `\r📦 Processing: ${processedCount}/${allSkus.length} (${percent}%) - ${sku.name.padEnd(30)}`,
    );

    try {
      const { packageData } = await client.getPackages(String(sku.id));

      if (packageData && packageData.esimPackageDtoList.length > 0) {
        // Create CSV file for this country code
        const packagesCsvPath = path.join(outputDir, `firoam-packages-${sku.countryCode}.csv`);
        let packagesCsvContent = packagesCsvHeader;

        for (const pkg of packageData.esimPackageDtoList) {
          const row = [
            sku.id,
            `"${sku.name.replace(/"/g, '""')}"`,
            pkg.priceid,
            `"${pkg.apiCode}"`,
            pkg.flows,
            `"${pkg.unit}"`,
            pkg.days,
            pkg.price,
            pkg.flowType,
            pkg.expireDays,
            pkg.supportDaypass,
            pkg.mustDate,
          ].join(',');
          packagesCsvContent += row + '\n';
        }

        fs.writeFileSync(packagesCsvPath, packagesCsvContent, 'utf-8');
      } else {
        failedCount++;
      }

      // Small delay to avoid overwhelming the API
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      failedCount++;
    }
  }

  console.log('\n\n✨ Done!\n');
  console.log('📁 Files created in firoam-data/:');
  console.log(`   • firoam-skus.csv (${totalSkus} SKUs)`);
  console.log(`   • firoam-packages-<country_code>.csv (${processedCount - failedCount} files)`);
  if (failedCount > 0) {
    console.log(`   ⚠️  ${failedCount} SKUs had no packages or failed to fetch`);
  }
  console.log('\n💡 To map a Shopify SKU to FiRoam:');
  console.log('   1. Open firoam-data/firoam-skus.csv to find the SKU ID you want');
  console.log('   2. Open firoam-data/firoam-packages-<countryCode>.csv for package details');
  console.log('   3. Use the apiCode from packages as providerSku in ProviderSkuMapping table\n');
}

main().catch(console.error);
