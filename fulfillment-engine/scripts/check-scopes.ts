#!/usr/bin/env ts-node
/**
 * Check current app scopes
 *
 * Usage: npx ts-node scripts/check-scopes.ts
 */

import 'dotenv/config';
import { graphqlQuery } from './utils/shopify-graphql';
import type { AppInstallationScopes } from './utils/shopify-types';

const SHOPIFY_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

async function getInstalledScopes(): Promise<string[]> {
  const query = `
    query {
      app {
        installation {
          accessScopes {
            handle
          }
        }
      }
    }
  `;

  const response = await graphqlQuery<AppInstallationScopes>(query);
  const scopes = response.data?.app?.installation?.accessScopes || [];
  return scopes.map((s) => s.handle);
}

async function checkScopes() {
  console.log('🔑 Checking configured access scopes...\n');

  try {
    const scopeList = await getInstalledScopes();

    console.log('📋 Current scopes:');
    console.log(`   ${scopeList.join(', ')}\n`);

    console.log('Required scopes for orders/paid webhook:');
    const requiredScopes = [
      { old: 'read_orders', current: 'read_all_orders' },
      { old: 'write_fulfillments', current: 'write_fulfillments' },
    ];

    requiredScopes.forEach(({ old, current }) => {
      const hasScope = scopeList.includes(current) || scopeList.includes(old);
      const scopeName = scopeList.includes(current) ? current : old;
      console.log(`   ${hasScope ? '✅' : '❌'} ${scopeName}`);
    });

    const missingScopes = requiredScopes
      .filter(({ old, current }) => !scopeList.includes(current) && !scopeList.includes(old))
      .map(({ current }) => current);

    if (missingScopes.length > 0) {
      console.log('\n⚠️  Missing required scopes:', missingScopes.join(', '));
      console.log('\n📝 To add scopes:');
      console.log('   1. Go to https://dev.shopify.com/dashboard/');
      console.log('   2. Select your app');
      console.log('   3. Go to "Configuration" tab');
      console.log('   4. Scroll to "Access scopes" section');
      console.log('   5. Add the missing scopes');
      console.log('   6. Save and re-install the app to your store');
      console.log('   7. Run this script again to verify');
    } else {
      console.log('\n✅ All required scopes are configured!');
      console.log('   You can now register webhooks.');
    }
  } catch (error) {
    console.error('❌ Error fetching scopes:', error);
    process.exit(1);
  }
}

if (!SHOPIFY_DOMAIN || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

checkScopes().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
