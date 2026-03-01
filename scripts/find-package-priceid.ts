#!/usr/bin/env ts-node
/**
 * Quick test to get priceId for Japan 300MB package
 */
import FiRoamClient from '../src/vendor/firoamClient';

async function main() {
  const client = new FiRoamClient();
  const { packageData } = await client.getPackages('26'); // Japan

  if (packageData) {
    // Find the 300MB package
    const pkg = packageData.esimPackageDtoList.find((p) => p.apiCode === '392-1-1-300-M');
    if (pkg) {
      console.log('Found package:');
      console.log(`  API Code: ${pkg.apiCode}`);
      console.log(`  Price ID: ${pkg.priceid}`);
      console.log(`  SKU ID: 26`);
      console.log('\nDatabase format:');
      console.log(`  providerSku: "26:${pkg.priceid}"`);
    } else {
      console.log('Package 392-1-1-300-M not found');
    }
  }
}

main().catch(console.error);
