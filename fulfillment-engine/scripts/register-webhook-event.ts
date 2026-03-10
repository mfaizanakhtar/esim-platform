import 'dotenv/config';
import { graphqlQuery } from './utils/shopify-graphql';
import type { EventBridgeWebhookSubscriptionCreateResponse } from './utils/shopify-types';

async function registerEventBridgeWebhook(webhookUrl: string) {
  console.log('🔑 Getting access token...');
  console.log('📝 Registering webhook as EventBridge subscription...');

  // Try using EventBridgeWebhookSubscription instead
  const mutation = `
    mutation eventBridgeWebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $callbackUrl: String!) {
      eventBridgeWebhookSubscriptionCreate(
        topic: $topic
        webhookSubscription: {
          callbackUrl: $callbackUrl
          format: JSON
        }
      ) {
        webhookSubscription {
          id
          topic
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
    const response = await graphqlQuery<EventBridgeWebhookSubscriptionCreateResponse>(mutation, {
      topic: 'ORDERS_PAID',
      callbackUrl: `${webhookUrl}/webhook/orders/paid`,
    });

    console.log('Response:', JSON.stringify(response, null, 2));

    const result = response.data.eventBridgeWebhookSubscriptionCreate;
    if (result.userErrors.length > 0) {
      console.error('❌ Errors:', result.userErrors);
    } else if (result.webhookSubscription) {
      console.log('✅ Webhook registered successfully!');
      console.log('Webhook ID:', result.webhookSubscription.id);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error('❌ Error:', error.message);
    } else {
      console.error('❌ Error:', error);
    }
  }
}

const webhookUrl = process.argv[2];
if (!webhookUrl) {
  console.error('Usage: npx ts-node scripts/register-webhook-event.ts <webhook-url>');
  process.exit(1);
}

registerEventBridgeWebhook(webhookUrl);
