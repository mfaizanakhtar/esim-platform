#!/usr/bin/env ts-node
/**
 * Register orders/paid webhook with Shopify using the official Shopify SDK
 *
 * Usage:
 *   1. Start ngrok: npm run ngrok
 *   2. Copy ngrok HTTPS URL
 *   3. Run: npx ts-node scripts/register-webhook.ts https://YOUR-NGROK-URL.ngrok.io
 */

import 'dotenv/config';
import { graphqlQuery } from './utils/shopify-graphql';
import type { WebhookSubscriptionCreateResponse } from './utils/shopify-types';

const SHOPIFY_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

async function registerWebhook(callbackUrl: string) {
  console.log('📝 Registering webhook...');

  const mutation = `
    mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $callbackUrl: String!) {
      webhookSubscriptionCreate(
        topic: $topic
        webhookSubscription: {
          callbackUrl: $callbackUrl
          format: JSON
        }
      ) {
        webhookSubscription {
          id
          topic
          format
          endpoint {
            __typename
            ... on WebhookHttpEndpoint {
              callbackUrl
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const response = await graphqlQuery<WebhookSubscriptionCreateResponse>(mutation, {
      topic: 'ORDERS_PAID',
      callbackUrl: `${callbackUrl}/webhook/orders/paid`,
    });
    const result = response.data.webhookSubscriptionCreate;

    if (result.userErrors.length > 0) {
      console.error('❌ Error creating webhook:');
      result.userErrors.forEach((error) => {
        console.error(`  - ${error.field.join('.')}: ${error.message}`);
      });
      process.exit(1);
    }

    const webhook = result.webhookSubscription;
    if (!webhook) {
      console.error('❌ Unexpected response shape:', response.data);
      process.exit(1);
    }

    console.log('✅ Webhook registered successfully!');
    console.log('\nWebhook Details:');
    console.log(`  ID: ${webhook.id}`);
    console.log(`  Topic: ${webhook.topic}`);
    console.log(`  URL: ${webhook.endpoint.callbackUrl}`);
    console.log(`  Format: ${webhook.format}`);

    console.log(
      '\n⚠️  IMPORTANT: The webhook secret for HMAC verification is in the GraphQL response headers.',
    );
    console.log(
      'Check X-Shopify-Webhook-Hmac-Sha256 header or fetch it using webhookSubscriptions query.',
    );
    console.log('\nFor now, use your SHOPIFY_CLIENT_SECRET as SHOPIFY_WEBHOOK_SECRET');
    console.log(`\nAdd to .env:\nSHOPIFY_WEBHOOK_SECRET=${CLIENT_SECRET}`);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Get ngrok URL from command line
const ngrokUrl = process.argv[2];

if (!ngrokUrl) {
  console.error('❌ Please provide your ngrok HTTPS URL as an argument');
  console.error('\nUsage:');
  console.error('  npx ts-node scripts/register-webhook.ts https://abc123.ngrok.io');
  process.exit(1);
}

if (!ngrokUrl.startsWith('https://')) {
  console.error('❌ URL must start with https://');
  process.exit(1);
}

if (!SHOPIFY_DOMAIN || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Missing required environment variables:');
  console.error('  SHOPIFY_SHOP_DOMAIN');
  console.error('  SHOPIFY_CLIENT_ID');
  console.error('  SHOPIFY_CLIENT_SECRET');
  process.exit(1);
}

console.log('🚀 Registering webhook for orders/paid...');
console.log(`   Shop: ${SHOPIFY_DOMAIN}`);
console.log(`   Callback URL: ${ngrokUrl}/webhook/orders/paid\n`);

registerWebhook(ngrokUrl).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
