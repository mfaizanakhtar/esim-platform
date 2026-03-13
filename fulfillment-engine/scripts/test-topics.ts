#!/usr/bin/env ts-node
/**
 * Query available webhook topics for this app
 */

import 'dotenv/config';
import { graphqlQuery } from './utils/shopify-graphql';
import type { WebhookSubscriptionTestResponse } from './utils/shopify-types';

interface TopicTest {
  name: string;
  topic: string;
}

async function checkAvailableTopics() {
  console.log('🔍 Checking app capabilities and available webhook topics...\n');

  const mutations: TopicTest[] = [
    { name: 'orders/create', topic: 'ORDERS_CREATE' },
    { name: 'orders/paid', topic: 'ORDERS_PAID' },
    { name: 'orders/fulfilled', topic: 'ORDERS_FULFILLED' },
    { name: 'orders/updated', topic: 'ORDERS_UPDATED' },
  ];

  for (const { name, topic } of mutations) {
    console.log(`\n📝 Testing ${name}...`);

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
      const response = await graphqlQuery<WebhookSubscriptionTestResponse>(mutation, {
        topic,
        callbackUrl: 'https://example.com/webhook',
      });

      const result = response.data.webhookSubscriptionCreate;
      if (result.userErrors.length > 0) {
        console.log(`   ❌ ${result.userErrors[0].message}`);
      } else if (result.webhookSubscription?.id) {
        console.log(`   ✅ SUCCESS! Created: ${result.webhookSubscription.id}`);
        console.log(`   (Will delete this test webhook next...)`);

        // Delete the test webhook
        const deleteM = `
          mutation webhookSubscriptionDelete($id: ID!) {
            webhookSubscriptionDelete(id: $id) {
              userErrors { message }
              deletedWebhookSubscriptionId
            }
          }
        `;
        await graphqlQuery(deleteM, { id: result.webhookSubscription.id });
        console.log(`   🗑️  Test webhook deleted`);
      }
    } catch (error) {
      console.log(`   ❌ Error testing ${name}`);
      console.log(`   Error:`, error);
    }
  }
}

checkAvailableTopics();

checkAvailableTopics().catch(console.error);
