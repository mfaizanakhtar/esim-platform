import 'dotenv/config';
import { graphqlQuery } from './utils/shopify-graphql';
import type { WebhookSubscriptionsSecretList } from './utils/shopify-types';

async function getWebhookSecret() {
  console.log('🔑 Getting access token...');
  console.log('🔍 Querying webhook details...');

  const query = `
    query {
      webhookSubscriptions(first: 10) {
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
            privateMetafield(namespace: "shopify", key: "hmac_secret") {
              value
            }
          }
        }
      }
    }
  `;

  try {
    const response = await graphqlQuery<WebhookSubscriptionsSecretList>(query);

    console.log('\n📦 Response:');
    console.log(JSON.stringify(response, null, 2));
  } catch (error) {
    if (error instanceof Error) {
      console.error('\n❌ Error:', error.message);
    } else {
      console.error('\n❌ Error:', error);
    }
  }
}

getWebhookSecret();
