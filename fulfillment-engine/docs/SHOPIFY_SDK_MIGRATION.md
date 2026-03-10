# Shopify GraphQL Variables Migration

> **Document Type**: Developer  
> **Status**: ✅ Current  
> **Last Updated**: 2026-03-01  
> **Purpose**: Migration from old to new Shopify SDK

---

## ✅ What Changed

We've migrated from **manual string interpolation** to **GraphQL variables** for all Shopify API calls. This is the industry-standard, production-ready approach.

---

## 🎯 Key Benefit: GraphQL Variables

### Before (String Interpolation - Dangerous!)
```typescript
// ❌ Injection risk! Never do this with user input
const mutation = `
  mutation {
    webhookSubscriptionCreate(
      topic: ORDERS_PAID
      webhookSubscription: {
        callbackUrl: "${url}/webhook"  // SQL injection equivalent!
        format: JSON
      }
    ) { ... }
  }
`;
```

### After (GraphQL Variables - Safe!)
```typescript
// ✅ Type-safe, injection-proof
const mutation = `
  mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $callbackUrl: String!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: {
        callbackUrl: $callbackUrl
        format: JSON
      }
    ) { ... }
  }
`;

await graphqlQuery(mutation, {
  topic: 'ORDERS_PAID',
  callbackUrl: `${url}/webhook`,
});
```

---

## 🚀 Key Improvements

1. **Security**: Prevents GraphQL injection attacks
2. **Type Safety**: GraphQL validates variable types
3. **Readability**: Cleaner separation of query structure and data
4. **Reusability**: Same query works with different variable values
5. **Debugging**: Named operations easier to track in logs
6. **Testing**: Can mock variables separately from query structure

---

## 📦 New Utility Module

**`scripts/utils/shopify-graphql.ts`**

Simple wrapper that adds GraphQL variable support:

```typescript
// Execute GraphQL queries/mutations with variables
export async function graphqlQuery<T>(
  query: string, 
  variables?: Record<string, unknown>
): Promise<T>
```

That's it! No complex SDK setup needed.

---

## 📝 Updated Scripts

All scripts now use the new SDK:

- ✅ `register-webhook.ts` - Uses variables for URL
- ✅ `list-webhooks.ts` - Cleaner query execution
- ✅ `delete-webhook.ts` - Variables for webhook ID
- ✅ `update-webhook.ts` - Variables for ID and URL
- ✅ `check-scopes.ts` - Simplified scope checking
- ✅ `debug-webhook.ts` - Better error output
- ✅ `register-http-webhook.ts` - Variables with error handling
- ✅ `get-webhook-secret.ts` - Streamlined query
- ✅ `register-webhook-event.ts` - EventBridge with variables
- ✅ `test-topics.ts` - Loop testing with variables

---

## 🔧 How to Use

### Basic Query
```typescript
import { graphqlQuery } from './utils/shopify-graphql';

const query = `
  query {
    shop {
      name
      email
    }
  }
`;

const result = await graphqlQuery(query);
console.log(result.data.shop.name);
```

### Mutation with Variables (The Key Improvement!)
```typescript
import { graphqlQuery } from './utils/shopify-graphql';

const mutation = `
  mutation createWebhook($topic: WebhookSubscriptionTopic!, $url: String!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { callbackUrl: $url, format: JSON }
    ) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`;

const result = await graphqlQuery(mutation, {
  topic: 'ORDERS_PAID',
  url: 'https://example.com/webhook',
});
```

---

## 🛡️ Why Variables Matter

### The Problem with String Interpolation
```typescript
// ❌ DANGEROUS - imagine if url contains: `" } }} malicious code`
const url = userInput;
const query = `mutation { create(url: "${url}") }`;
```

This is the GraphQL equivalent of SQL injection!

### The Solution: GraphQL Variables
```typescript
// ✅ SAFE - GraphQL engine sanitizes variables
const query = `mutation($url: String!) { create(url: $url) }`;
await graphqlQuery(query, { url: userInput }); // Completely safe!
```

The GraphQL server validates and escapes variables automatically.

---

## 📚 Documentation

- [Shopify API Library](https://github.com/Shopify/shopify-api-js)
- [GraphQL Admin API](https://shopify.dev/docs/api/admin-graphql)
- [Webhooks Guide](https://shopify.dev/docs/apps/build/webhooks)

---

## 🎓 Best Practices Going Forward

1. **Always use variables** for dynamic values in queries/mutations
2. **Type your responses** using the interfaces in `shopify-types.ts`
3. **Handle errors** by checking `userErrors` in responses
4. **Avoid raw axios** - use the SDK wrapper instead
5. **Test queries** in Shopify GraphQL Explorer first

---

## 🔄 Migration Notes

- Old utility (`shopify-admin.ts`) deprecated - use `shopify-graphql.ts`
- All scripts now use GraphQL variables (no more string interpolation)
- Queries have named operations (better for debugging in Shopify logs)
- Variables prevent injection attacks
- Token management still handled automatically

---

## ✨ What This Enables

1. **Production-ready security** - No injection vulnerabilities
2. **Better debugging** - Named operations show up in Shopify Admin logs
3. **Type validation** - GraphQL validates variable types at runtime
4. **Easy testing** - Mock variables separately from query structure
5. **Query reuse** - Same query, different variables

---

## 📚 Learn More

- [GraphQL Variables](https://graphql.org/learn/queries/#variables)
- [Shopify GraphQL API](https://shopify.dev/docs/api/admin-graphql)
- [GraphQL Best Practices](https://graphql.org/learn/best-practices/)

---

## 🧹 Clean & Simple

**What we're using:**
- ✅ `shopify-graphql.ts` - Simple axios wrapper with GraphQL variables
- ✅ GraphQL variables for all dynamic values
- ✅ Proper TypeScript types

**What we removed:**
- ❌ `@shopify/shopify-api` package (too complex for our needs)
- ❌ `shopify-sdk.ts` (unused)
- ❌ String interpolation (security risk)

**Result:** Production-ready GraphQL with minimal dependencies!

---

## ✅ Verification

Test it works:
```bash
npm run webhook:list
npm run webhook:check-scopes
```

You should see your webhooks and scopes listed with no errors!

**All scripts are now production-ready with proper GraphQL variable usage.** 🎉
