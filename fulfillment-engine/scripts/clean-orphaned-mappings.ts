/**
 * Clean Orphaned Database Mappings
 *
 * Removes SKU mappings from database that don't exist in the cleaned export
 * These are typically old mappings from previous runs or test data
 *
 * Usage: npm run db:clean-orphaned
 */
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
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

async function main() {
  console.log('🧹 Clean Orphaned Database Mappings\n');

  // Load valid SKUs from cleaned export
  const exportFile = path.join(process.cwd(), 'csv-exports', 'products_export_cleaned.csv');
  if (!fs.existsSync(exportFile)) {
    throw new Error(`File not found: ${exportFile}. Run 'npm run clean:export' first.`);
  }

  console.log('📦 Loading valid SKUs from export...');
  const content = fs.readFileSync(exportFile, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());

  const validSkus = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const variantSku = fields[17]; // Variant SKU column

    if (variantSku && variantSku.trim()) {
      validSkus.add(variantSku.trim());
    }
  }

  console.log(`  Found ${validSkus.size} valid SKUs in export\n`);

  // Get all mappings from database
  console.log('🗄️  Loading database mappings...');
  const allMappings = await prisma.providerSkuMapping.findMany({
    select: {
      id: true,
      shopifySku: true,
      provider: true,
      createdAt: true,
    },
  });

  console.log(`  Found ${allMappings.length} mappings in database\n`);

  // Find orphaned mappings
  const orphaned = allMappings.filter((m) => !validSkus.has(m.shopifySku));

  if (orphaned.length === 0) {
    console.log('✨ No orphaned mappings found. Database is clean!\n');
    return;
  }

  console.log(`⚠️  Found ${orphaned.length} orphaned mappings:\n`);

  // Categorize orphaned mappings
  const categories: Record<string, string[]> = {};
  orphaned.forEach((m) => {
    const prefix = m.shopifySku.split('-')[0];
    if (!categories[prefix]) {
      categories[prefix] = [];
    }
    categories[prefix].push(m.shopifySku);
  });

  console.log('   By Country/Type:');
  Object.entries(categories)
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([prefix, skus]) => {
      console.log(`     ${prefix}: ${skus.length}`);
    });

  console.log('\n   Sample orphaned SKUs:');
  orphaned.slice(0, 10).forEach((m) => {
    console.log(`     ${m.shopifySku} (ID: ${m.id})`);
  });

  // Ask for confirmation
  console.log(`\n⚠️  WARNING: This will DELETE ${orphaned.length} mappings from the database.`);
  console.log('   These SKUs are not in csv-exports/products_export_cleaned.csv\n');

  // Check if running in CI or force mode
  const force = process.argv.includes('--force') || process.argv.includes('-f');

  if (!force) {
    console.log('💡 To proceed, run with --force flag:');
    console.log('   npm run db:clean-orphaned -- --force\n');
    return;
  }

  // Delete orphaned mappings
  console.log('🗑️  Deleting orphaned mappings...');

  const orphanedIds = orphaned.map((m) => m.id);

  const result = await prisma.providerSkuMapping.deleteMany({
    where: {
      id: {
        in: orphanedIds,
      },
    },
  });

  console.log(`  Deleted ${result.count} mappings\n`);

  // Verify
  const remaining = await prisma.providerSkuMapping.count();
  console.log(`✅ Database cleaned!`);
  console.log(`   Before: ${allMappings.length} mappings`);
  console.log(`   Deleted: ${result.count} mappings`);
  console.log(`   After: ${remaining} mappings\n`);

  // Export deleted mappings for reference
  const backupFile = path.join(process.cwd(), 'csv-exports', 'deleted-mappings-backup.csv');
  const backupLines = ['ID,Shopify_SKU,Provider,Created_At'];
  orphaned.forEach((m) => {
    backupLines.push(`${m.id},${m.shopifySku},${m.provider},${m.createdAt.toISOString()}`);
  });
  fs.writeFileSync(backupFile, backupLines.join('\n'), 'utf-8');

  console.log(`📄 Backup saved: deleted-mappings-backup.csv`);
  console.log('   (In case you need to restore any mappings)\n');
}

main()
  .catch((err) => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
