#!/usr/bin/env ts-node
/**
 * Test webhook subscription creation with detailed error output
 */

import 'dotenv/config';
import { graphqlQuery } from './utils/shopify-graphql';
import type { WebhookSubscriptionCreateResponse } from './utils/shopify-types';

async function testWebhookCreation() {
  console.log('🔍 Testing webhook creation with detailed output...\n');

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
      callbackUrl: 'https://example.com/webhook',
    });

    console.log('📦 Full Response:', JSON.stringify(response, null, 2));

    const result = response.data.webhookSubscriptionCreate;
    if (result.userErrors.length > 0) {
      console.log('\n❌ Errors found:');
      result.userErrors.forEach((e) => {
        console.log(`  - ${e.field.join('.')}: ${e.message}`);
      });
    } else {
      console.log('\n✅ Success!');
    }
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

testWebhookCreation().catch(console.error);
