/**
 * Update Shopify Export with Generated SKUs
 *
 * Reads products_export_1.csv and shopify-skus-generated.csv
 * Updates the Variant SKU column (column 18) with generated SKUs
 * Outputs: products_export_updated.csv (ready for Shopify import)
 *
 * Usage: npm run update:export
 */
import fs from 'fs';
import path from 'path';

/**
 * Parse CSV content handling multi-line quoted fields
 * Returns array of rows, where each row is the original line(s) as a string
 */
function parseCSVRows(content: string): string[] {
  const rows: string[] = [];
  let currentRow = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (char === '"') {
      // Handle escaped quotes ("")
      if (i + 1 < content.length && content[i + 1] === '"') {
        currentRow += '""';
        i++; // Skip next quote
      } else {
        inQuotes = !inQuotes;
        currentRow += char;
      }
    } else if (char === '\n' && !inQuotes) {
      // End of row (not inside quotes)
      if (currentRow.trim()) {
        rows.push(currentRow);
      }
      currentRow = '';
    } else if (char === '\r') {
      // Skip carriage return
      continue;
    } else {
      currentRow += char;
    }
  }

  // Don't forget the last row
  if (currentRow.trim()) {
    rows.push(currentRow);
  }

  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char; // Preserve quotes
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

interface SKUMapping {
  handle: string;
  title: string;
  planType: string;
  validity: string;
  volume: string;
  price: string;
  generatedSKU: string;
  countryCode: string;
  packageType: string;
  daysCount: string;
  dataAmount: string;
}

async function main() {
  console.log('📝 Update Shopify Export with Generated SKUs\n');

  // Load generated SKUs
  const skuFile = path.join(process.cwd(), 'csv-exports', 'shopify-skus-generated.csv');
  if (!fs.existsSync(skuFile)) {
    throw new Error(`File not found: ${skuFile}. Run 'npm run generate:skus' first.`);
  }

  console.log('📦 Loading generated SKUs...');
  const skuContent = fs.readFileSync(skuFile, 'utf-8');
  const skuLines = skuContent.split('\n').filter((l) => l.trim());

  // Build lookup map: handle+planType+validity+volume -> generatedSKU
  const skuMap = new Map<string, SKUMapping>();

  for (let i = 1; i < skuLines.length; i++) {
    const fields = parseCSVLine(skuLines[i]);
    const handle = fields[0];
    const title = fields[1];
    const planType = fields[2];
    const validity = fields[3];
    const volume = fields[4];
    const price = fields[5];
    const generatedSKU = fields[6];
    const countryCode = fields[7];
    const packageType = fields[8];
    const daysCount = fields[9];
    const dataAmount = fields[10];

    const key = `${handle}|${planType}|${validity}|${volume}`.toLowerCase();
    skuMap.set(key, {
      handle,
      title,
      planType,
      validity,
      volume,
      price,
      generatedSKU,
      countryCode,
      packageType,
      daysCount,
      dataAmount,
    });
  }

  console.log(`  Loaded ${skuMap.size} SKU mappings\n`);

  // Load original Shopify export
  const exportFile = path.join(process.cwd(), 'csv-exports', 'products_export_1.csv');
  if (!fs.existsSync(exportFile)) {
    throw new Error(`File not found: ${exportFile}`);
  }

  console.log('📦 Loading Shopify export...');
  const exportContent = fs.readFileSync(exportFile, 'utf-8');
  // Use multi-line aware parser to handle quoted fields with newlines
  const exportLines = parseCSVRows(exportContent);

  console.log(`  Found ${exportLines.length - 1} rows\n`);

  // Process each line
  console.log('✏️  Updating Variant SKU column...');
  const outputLines: string[] = [];
  let updated = 0;
  let notFound = 0;
  let isHeader = true;

  for (const line of exportLines) {
    if (!line.trim()) {
      outputLines.push(line);
      continue;
    }

    if (isHeader) {
      outputLines.push(line);
      isHeader = false;
      continue;
    }

    const fields = parseCSVLine(line);
    const handle = fields[0];
    const option1Value = fields[9]; // Plan Type
    const option2Value = fields[12]; // Validity
    const option3Value = fields[15]; // Volume

    // Build lookup key
    const key = `${handle}|${option1Value}|${option2Value}|${option3Value}`.toLowerCase();
    const mapping = skuMap.get(key);

    if (mapping) {
      // Update Variant SKU column (index 17)
      fields[17] = mapping.generatedSKU;
      updated++;
    } else {
      notFound++;
    }

    // Reconstruct line - fields already have quotes preserved
    const updatedLine = fields.join(',');
    outputLines.push(updatedLine);
  }

  // Write output
  const outputFile = path.join(process.cwd(), 'csv-exports', 'products_export_updated.csv');
  fs.writeFileSync(outputFile, outputLines.join('\n'), 'utf-8');

  console.log(`  Updated: ${updated}`);
  console.log(`  Not Found: ${notFound}`);
  console.log(`\n📄 Output file: csv-exports/products_export_updated.csv`);
  console.log(`   Size: ${(fs.statSync(outputFile).size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`   Lines: ${outputLines.length.toLocaleString()}\n`);

  console.log('✨ Done! Next steps:');
  console.log('  1. Review csv-exports/products_export_updated.csv');
  console.log('  2. Upload to Shopify via Admin > Products > Import');
  console.log('  3. Select "Overwrite existing products" option\n');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
