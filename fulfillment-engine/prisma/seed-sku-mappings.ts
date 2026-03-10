/**
 * Seed script to add SKU mappings for testing
 * Usage: npx ts-node prisma/seed-sku-mappings.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding SKU mappings...\n');

  // Example SKU mappings using real FiRoam data
  // Format: providerSku should be "skuId:priceId" (e.g., "26:424")
  // Get priceId from firoam-data/firoam-packages-<countryCode>.csv or use npm run find:priceid
  const mappings = [
    // Fixed package example
    {
      shopifySku: 'ESIM-JAPAN-1GB-3D-FIXED',
      provider: 'firoam',
      providerSku: '26:424', // Japan 1GB / 3 days (fixed validity)
      packageType: 'fixed',
      daysCount: null,
      name: 'Japan 1GB eSIM (3 Days Total)',
      region: 'Asia',
      dataAmount: '1GB',
      validity: '3 days',
      isActive: true,
    },
    // Daypass package example
    {
      shopifySku: 'ESIM-JAPAN-1GB-3D-DAYPASS',
      provider: 'firoam',
      providerSku: '26:daypass_1gb', // Japan 1GB/day (use daypass priceId)
      packageType: 'daypass',
      daysCount: 3, // 3 day passes = 3GB total
      name: 'Japan 1GB/day eSIM (3 Days)',
      region: 'Asia',
      dataAmount: '1GB/day',
      validity: '3 days',
      isActive: true,
    },
    {
      shopifySku: 'ESIM-JAPAN-5GB-7D',
      provider: 'firoam',
      providerSku: '26:5gb_7d_priceid', // Japan 5GB / 7 days
      packageType: 'fixed',
      daysCount: null,
      name: 'Japan 5GB eSIM',
      region: 'Asia',
      dataAmount: '5GB',
      validity: '7 days',
      isActive: true,
    },
    {
      shopifySku: 'ESIM-USA-1GB-3D',
      provider: 'firoam',
      providerSku: '7:usa_1gb_3d', // USA 1GB / 3 days
      packageType: 'fixed',
      daysCount: null,
      name: 'United States 1GB eSIM',
      region: 'North America',
      dataAmount: '1GB',
      validity: '3 days',
      isActive: true,
    },
    {
      shopifySku: 'ESIM-USA-10GB-30D',
      provider: 'firoam',
      providerSku: '7:usa_10gb_30d', // USA 10GB / 30 days
      packageType: 'fixed',
      daysCount: null,
      name: 'United States 10GB eSIM',
      region: 'North America',
      dataAmount: '10GB',
      validity: '30 days',
      isActive: true,
    },
    {
      shopifySku: 'ESIM-MALAYSIA-1GB-3D',
      provider: 'firoam',
      providerSku: '13:malaysia_1gb_3d', // Malaysia 1GB / 3 days
      packageType: 'fixed',
      daysCount: null,
      name: 'Malaysia 1GB eSIM',
      region: 'Asia',
      dataAmount: '1GB',
      validity: '3 days',
      isActive: true,
    },
  ];

  for (const mapping of mappings) {
    const result = await prisma.providerSkuMapping.upsert({
      where: { shopifySku: mapping.shopifySku },
      update: mapping,
      create: mapping,
    });
    console.log(`✅ ${result.shopifySku} → ${result.provider}:${result.providerSku}`);
  }

  console.log('\n✨ Seeding complete!');
  console.log('\nNext steps:');
  console.log('1. Update your Shopify product variant SKUs to match these:');
  mappings.forEach((m) => console.log(`   - ${m.shopifySku}`));
  console.log('2. Create a test order in Shopify');
  console.log('3. Watch your logs for provisioning!\n');
}

main()
  .catch((e) => {
    console.error('Error seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
