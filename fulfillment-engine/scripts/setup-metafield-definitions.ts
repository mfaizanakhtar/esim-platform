/**
 * Create / update the metafield definitions required by the Shopify UI extensions.
 *
 * Shopify's customer-account UI extensions can only read order metafields that
 * have a definition with `customerAccount: READ` access. This cannot be declared
 * in shopify.app.toml — it must be set via the GraphQL Admin API.
 *
 * Run once per store (or after reinstalling the app):
 *   npx tsx scripts/setup-metafield-definitions.ts
 */
import axios from 'axios';

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = '2025-04';

if (!SHOP_DOMAIN || !ACCESS_TOKEN) {
  console.error('Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ACCESS_TOKEN env vars');
  process.exit(1);
}

const graphql = async (query: string, variables?: Record<string, unknown>) => {
  const res = await axios.post(
    `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    { query, variables },
    { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': ACCESS_TOKEN } },
  );
  return res.data;
};

async function ensureDefinition() {
  // Check if definition already exists
  const existing = await graphql(`
    {
      metafieldDefinitions(ownerType: ORDER, namespace: "esim", key: "delivery_tokens", first: 1) {
        nodes {
          id
          access {
            admin
            customerAccount
          }
        }
      }
    }
  `);

  const node = existing.data?.metafieldDefinitions?.nodes?.[0];

  if (node) {
    if (node.access.customerAccount === 'READ') {
      console.log('✓ esim.delivery_tokens definition exists with customerAccount: READ');
      return;
    }

    // Update access
    const update = await graphql(`
      mutation {
        metafieldDefinitionUpdate(
          definition: {
            namespace: "esim"
            key: "delivery_tokens"
            ownerType: ORDER
            access: { customerAccount: READ }
          }
        ) {
          updatedDefinition {
            id
            access {
              admin
              customerAccount
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `);

    const errors = update.data?.metafieldDefinitionUpdate?.userErrors;
    if (errors?.length) {
      console.error('Failed to update:', errors);
      process.exit(1);
    }
    console.log('✓ Updated esim.delivery_tokens → customerAccount: READ');
    return;
  }

  // Create definition
  const create = await graphql(`
    mutation {
      metafieldDefinitionCreate(
        definition: {
          name: "eSIM Delivery Tokens"
          namespace: "esim"
          key: "delivery_tokens"
          type: "json"
          ownerType: ORDER
        }
      ) {
        createdDefinition {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `);

  const createErrors = create.data?.metafieldDefinitionCreate?.userErrors;
  if (createErrors?.length) {
    console.error('Failed to create:', createErrors);
    process.exit(1);
  }

  // Set customer account access (separate call — create doesn't allow it with custom app tokens)
  const update = await graphql(`
    mutation {
      metafieldDefinitionUpdate(
        definition: {
          namespace: "esim"
          key: "delivery_tokens"
          ownerType: ORDER
          access: { customerAccount: READ }
        }
      ) {
        updatedDefinition {
          id
          access {
            admin
            customerAccount
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `);

  const updateErrors = update.data?.metafieldDefinitionUpdate?.userErrors;
  if (updateErrors?.length) {
    console.error('Failed to set access:', updateErrors);
    process.exit(1);
  }

  console.log('✓ Created esim.delivery_tokens with customerAccount: READ');
}

ensureDefinition().catch((err) => {
  console.error(err);
  process.exit(1);
});
