import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';

const prisma = new PrismaClient();

async function init() {
  try {
    console.log('🔄 Running Prisma migrations...');
    execSync('npx prisma migrate deploy', { stdio: 'inherit' });

    console.log('🔍 Checking if seeding is needed...');
    const count = await prisma.providerSkuMapping.count();

    if (count === 0) {
      console.log('🌱 Running seed script (7356 mappings)...');
      execSync('node dist/prisma/seed-all-mappings.js', { stdio: 'inherit' });
      console.log('✅ Seeding completed');
    } else {
      console.log(`✅ SKU mappings already exist (${count} records), skipping seed`);
    }

    await prisma.$disconnect();
    console.log('🚀 Initialization complete, starting server...');
  } catch (error) {
    console.error('❌ Initialization failed:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

init();
