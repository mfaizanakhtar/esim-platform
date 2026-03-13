/**
 * Clean Shopify Export - Remove Unfulfillable Products
 *
 * Removes products from export that cannot be fulfilled:
 * - Daypass not supported
 * - Data amount not offered
 * - Days count not offered
 * - Country not in FiRoam
 *
 * Usage: npm run clean:export
 */
import * as fs from 'fs';
import * as path from 'path';

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
      current += char;
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

function joinCSVLine(fields: string[]): string {
  return fields.join(',');
}

async function main() {
  console.log('🧹 Clean Shopify Export - Remove Unfulfillable Products\n');

  // Load mappings to determine which SKUs to keep
  const mappingsFile = path.join(process.cwd(), 'csv-exports', 'shopify-firoam-mappings.csv');
  if (!fs.existsSync(mappingsFile)) {
    throw new Error(`File not found: ${mappingsFile}. Run 'npm run match:firoam' first.`);
  }

  console.log('📦 Loading FiRoam mappings...');
  const mappingsContent = fs.readFileSync(mappingsFile, 'utf-8');
  const mappingsLines = mappingsContent.split('\n').filter((l) => l.trim());

  // Build set of SKUs that should be kept (MATCHED status)
  const keepSkus = new Set<string>();
  const removeReasons = new Map<string, string>();

  for (let i = 1; i < mappingsLines.length; i++) {
    const fields = parseCSVLine(mappingsLines[i]);
    const sku = fields[0];
    const matchStatus = fields[11];

    if (matchStatus === 'MATCHED') {
      keepSkus.add(sku);
    } else {
      removeReasons.set(sku, matchStatus);
    }
  }

  console.log(`  Keep: ${keepSkus.size} SKUs`);
  console.log(`  Remove: ${removeReasons.size} SKUs\n`);

  // Load updated export
  const exportFile = path.join(process.cwd(), 'csv-exports', 'products_export_updated.csv');
  if (!fs.existsSync(exportFile)) {
    throw new Error(`File not found: ${exportFile}. Run 'npm run update:export' first.`);
  }

  console.log('📦 Loading Shopify export...');
  const exportContent = fs.readFileSync(exportFile, 'utf-8');
  // Use multi-line aware parser to handle quoted fields with newlines
  const exportLines = parseCSVRows(exportContent);

  console.log(`  Found ${exportLines.length - 1} rows\n`);

  // Filter lines and track products
  console.log('✂️  Filtering products...');
  const outputLines: string[] = [];
  let kept = 0;
  let removed = 0;
  const removalStats: Record<string, number> = {};
  const productFirstRows = new Map<string, string>(); // Track first row with title for each handle
  const productVariants = new Map<string, string[]>(); // Track all kept variants per handle

  // First pass: organize by product handle and preserve first rows
  for (let i = 0; i < exportLines.length; i++) {
    const line = exportLines[i];

    if (!line.trim()) continue;

    // Skip header for now
    if (i === 0) continue;

    const fields = parseCSVLine(line);
    const handle = fields[0]; // Handle column
    const title = fields[1]; // Title column
    const variantSku = fields[17]; // Variant SKU column

    if (!handle) continue;

    // Always preserve the first row with title for each product (has all product-level fields)
    if (title && title.trim() && !productFirstRows.has(handle)) {
      productFirstRows.set(handle, line);
    }

    // Track kept variants
    if (!variantSku || !variantSku.trim()) {
      removed++;
      removalStats['No SKU'] = (removalStats['No SKU'] || 0) + 1;
      continue;
    }

    if (keepSkus.has(variantSku)) {
      if (!productVariants.has(handle)) {
        productVariants.set(handle, []);
      }
      productVariants.get(handle)!.push(line);
    } else {
      const reason = removeReasons.get(variantSku) || 'Unknown';
      removalStats[reason] = (removalStats[reason] || 0) + 1;
      removed++;
    }
  }

  // Second pass: output with preserved first rows
  outputLines.push(exportLines[0]); // Add header

  for (const handle of Array.from(productVariants.keys())) {
    const variants = productVariants.get(handle)!;
    const firstRow = productFirstRows.get(handle);

    if (!firstRow) {
      // No title row was found in original export - create one
      // This shouldn't happen in a proper Shopify export, but handle it anyway
      const fields = parseCSVLine(variants[0]);
      const title = handle
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

      // Set product-level fields on first variant
      fields[1] = title; // Title
      fields[2] = '<p>Instant digital eSIM. Activate in minutes. No physical SIM required.<br></p>'; // Body
      fields[3] = 'Fluxyfi'; // Vendor
      fields[4] =
        'Electronics > Communications > Telephony > Mobile & Smart Phone Accessories > Mobile Phone Pre-Paid Cards & SIM Cards > eSIMs'; // Category
      fields[46] = 'draft'; // Status

      outputLines.push(joinCSVLine(fields));
      kept++;

      // Add remaining variants
      for (let i = 1; i < variants.length; i++) {
        outputLines.push(variants[i]);
        kept++;
      }
    } else {
      // Check if the first row (with title) is in our kept variants
      const firstRowInKeptVariants = variants.some((v) => v === firstRow);

      if (firstRowInKeptVariants) {
        // First row was kept, output all variants as-is (preserve original formatting)
        variants.forEach((variant) => {
          outputLines.push(variant);
          kept++;
        });
      } else {
        // First row was filtered out - need to merge it with first kept variant
        // Preserve product-level fields from firstRow, but use variant-specific fields from first kept variant
        const firstRowFields = parseCSVLine(firstRow);
        const firstKeptVariantFields = parseCSVLine(variants[0]);

        // Ensure both arrays have the same length (pad with empty strings if needed)
        const maxLen = Math.max(firstRowFields.length, firstKeptVariantFields.length);
        while (firstRowFields.length < maxLen) firstRowFields.push('');
        while (firstKeptVariantFields.length < maxLen) firstKeptVariantFields.push('');

        // Replace only variant-specific fields (keep all product-level fields intact)
        // Option values (columns 9, 12, 15)
        firstRowFields[9] = firstKeptVariantFields[9]; // Option1 Value
        firstRowFields[12] = firstKeptVariantFields[12]; // Option2 Value
        firstRowFields[15] = firstKeptVariantFields[15]; // Option3 Value

        // Variant-specific fields (columns 17-31, 44, 45, 47)
        firstRowFields[17] = firstKeptVariantFields[17]; // Variant SKU
        firstRowFields[18] = firstKeptVariantFields[18]; // Variant Grams
        firstRowFields[19] = firstKeptVariantFields[19]; // Variant Inventory Tracker
        firstRowFields[20] = firstKeptVariantFields[20]; // Variant Inventory Qty
        firstRowFields[21] = firstKeptVariantFields[21]; // Variant Inventory Policy
        firstRowFields[22] = firstKeptVariantFields[22]; // Variant Fulfillment Service
        firstRowFields[23] = firstKeptVariantFields[23]; // Variant Price
        firstRowFields[24] = firstKeptVariantFields[24]; // Variant Compare At Price
        firstRowFields[25] = firstKeptVariantFields[25]; // Variant Requires Shipping
        firstRowFields[26] = firstKeptVariantFields[26]; // Variant Taxable
        firstRowFields[27] = firstKeptVariantFields[27]; // Unit Price Total Measure
        firstRowFields[28] = firstKeptVariantFields[28]; // Unit Price Total Measure Unit
        firstRowFields[29] = firstKeptVariantFields[29]; // Unit Price Base Measure
        firstRowFields[30] = firstKeptVariantFields[30]; // Unit Price Base Measure Unit
        firstRowFields[31] = firstKeptVariantFields[31]; // Variant Barcode
        firstRowFields[44] = firstKeptVariantFields[44]; // Variant Image
        firstRowFields[45] = firstKeptVariantFields[45]; // Variant Weight Unit
        firstRowFields[47] = firstKeptVariantFields[47]; // Cost per item

        outputLines.push(joinCSVLine(firstRowFields));
        kept++;

        // Add remaining variants (preserve original formatting)
        for (let i = 1; i < variants.length; i++) {
          outputLines.push(variants[i]);
          kept++;
        }
      }
    }
  }

  // Write cleaned export
  const cleanedFile = path.join(process.cwd(), 'csv-exports', 'products_export_cleaned.csv');
  fs.writeFileSync(cleanedFile, outputLines.join('\n'), 'utf-8');

  console.log(`  Kept: ${kept}`);
  console.log(`  Removed: ${removed}\n`);

  console.log('📈 Removal Breakdown:');
  Object.entries(removalStats)
    .sort((a, b) => b[1] - a[1])
    .forEach(([reason, count]) => {
      console.log(`  ${reason}: ${count}`);
    });

  console.log(`\n📄 Output file: csv-exports/products_export_cleaned.csv`);
  console.log(`   Original size: ${(fs.statSync(exportFile).size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`   Cleaned size: ${(fs.statSync(cleanedFile).size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`   Original lines: ${exportLines.length.toLocaleString()}`);
  console.log(`   Cleaned lines: ${outputLines.length.toLocaleString()}`);
  console.log(`   Removed: ${((removed / (exportLines.length - 1)) * 100).toFixed(1)}%\n`);

  console.log('✨ Done! Next steps:');
  console.log('  1. Review csv-exports/products_export_cleaned.csv');
  console.log('  2. Upload to Shopify via Admin > Products > Import');
  console.log('  3. Select "Overwrite existing products" option\n');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
