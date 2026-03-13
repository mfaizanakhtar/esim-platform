#!/usr/bin/env ts-node
/**
 * List all registered webhooks
 *
 * Usage: npx ts-node scripts/list-webhooks.ts
 */

import 'dotenv/config';
import axios from 'axios';
import { graphqlQuery } from './utils/shopify-graphql';
import type { WebhookSubscriptionsList } from './utils/shopify-types';

async function listWebhooks() {
  console.log('🔑 Getting access token...');

  console.log('📋 Fetching webhooks...\n');

  const query = `
    query {
      webhookSubscriptions(first: 50) {
        edges {
          node {
            id
            topic
            format
            endpoint {
              __typename
              ... on WebhookHttpEndpoint {
                callbackUrl
              }
            }
            createdAt
            updatedAt
          }
        }
      }
    }
  `;

  try {
    const response = await graphqlQuery<WebhookSubscriptionsList>(query);

    const webhooks = response.data.webhookSubscriptions.edges;

    if (webhooks.length === 0) {
      console.log('No webhooks registered yet.');
      return;
    }

    console.log(`Found ${webhooks.length} webhook(s):\n`);

    webhooks.forEach((edge, index) => {
      const webhook = edge.node;
      console.log(`${index + 1}. ${webhook.topic}`);
      console.log(`   ID: ${webhook.id}`);
      console.log(`   URL: ${webhook.endpoint.callbackUrl}`);
      console.log(`   Format: ${webhook.format}`);
      if (webhook.createdAt) {
        console.log(`   Created: ${new Date(webhook.createdAt).toLocaleString()}`);
      }
      console.log('');
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('❌ GraphQL Error:', error.response?.data);
    } else {
      console.error('❌ Error:', error);
    }
    process.exit(1);
  }
}

listWebhooks().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
