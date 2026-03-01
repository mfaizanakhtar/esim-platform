# GraphQL: String Interpolation vs Variables

> **Document Type**: Developer  
> **Status**: ✅ Current  
> **Last Updated**: 2026-03-01  
> **Purpose**: Shopify GraphQL variable handling

---

## The Problem You Were Facing

When working with GraphQL, you were building queries like this:

```typescript
const url = "https://example.com";
const topic = "ORDERS_PAID";

const mutation = `
  mutation {
    webhookSubscriptionCreate(
      topic: ${topic}
      webhookSubscription: {
        callbackUrl: "${url}"
      }
    ) {
      webhookSubscription { id }
    }
  }
`;
```

This works, but it's:
- ❌ **Dangerous** - Vulnerable to injection attacks
- ❌ **Hard to maintain** - Mixing logic with query structure
- ❌ **Error-prone** - Quotes, escaping, formatting issues
- ❌ **Not type-safe** - No validation until runtime

---

## The Industry-Standard Solution: Variables

GraphQL has a built-in feature called **variables** specifically to solve this:

```typescript
const mutation = `
  mutation createWebhook($topic: WebhookSubscriptionTopic!, $url: String!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: {
        callbackUrl: $url
      }
    ) {
      webhookSubscription { id }
    }
  }
`;

// Pass variables separately
await graphqlQuery(mutation, {
  topic: 'ORDERS_PAID',
  url: 'https://example.com',
});
```

This is:
- ✅ **Secure** - GraphQL engine sanitizes variables
- ✅ **Clean** - Separation of concerns
- ✅ **Type-safe** - GraphQL validates types (`String!` = required string)
- ✅ **Reusable** - Same query, different variables

---

## Real-World Example

### Before (What You Had)
```typescript
async function registerWebhook(url: string) {
  const mutation = `
    mutation {
      webhookSubscriptionCreate(
        topic: ORDERS_PAID
        webhookSubscription: {
          callbackUrl: "${url}/webhook/orders/paid"
        }
      ) {
        webhookSubscription { id }
        userErrors { message }
      }
    }
  `;
  
  await shopifyGraphQL(mutation);
}
```

**Problems:**
- What if `url` contains quotes?
- What if someone passes malicious input?
- Hard to test different URLs
- Query structure mixed with data

### After (What You Have Now)
```typescript
async function registerWebhook(url: string) {
  const mutation = `
    mutation registerWebhook($topic: WebhookSubscriptionTopic!, $callbackUrl: String!) {
      webhookSubscriptionCreate(
        topic: $topic
        webhookSubscription: {
          callbackUrl: $callbackUrl
        }
      ) {
        webhookSubscription { id }
        userErrors { message }
      }
    }
  `;
  
  await graphqlQuery(mutation, {
    topic: 'ORDERS_PAID',
    callbackUrl: `${url}/webhook/orders/paid`,
  });
}
```

**Benefits:**
- GraphQL validates and escapes `callbackUrl`
- Type checking ensures `topic` is valid
- Clean separation of query and data
- Easy to test with different variable values
- Named operation shows up in Shopify logs

---

## Why This Matters

### Security Example

Imagine someone passes this URL:
```
https://evil.com" } webhookSubscription: { destroy: true } anotherField: "
```

**With string interpolation:**
```typescript
const query = `mutation { create(url: "${url}") }`
// Results in: mutation { create(url: "https://evil.com" } webhookSubscription: { destroy: true } anotherField: "") }
// 💥 Query hijacked!
```

**With variables:**
```typescript
const query = `mutation($url: String!) { create(url: $url) }`
graphqlQuery(query, { url: maliciousUrl })
// GraphQL treats entire string as one value: "https://evil.com\" } webhookSubscription..."
// ✅ Attack prevented!
```

---

## Best Practices (What You're Now Following)

1. **Always use variables for dynamic values**
   ```typescript
   // ✅ Good
   mutation($id: ID!) { delete(id: $id) }
   
   // ❌ Bad
   mutation { delete(id: "${id}") }
   ```

2. **Define variable types in mutation/query signature**
   ```typescript
   mutation createOrder(
     $email: String!,        # Required string
     $amount: Float!,        # Required number
     $metadata: JSON         # Optional JSON
   )
   ```

3. **Name your operations** (helps with logging/debugging)
   ```typescript
   // ✅ Good - shows up in Shopify logs as "registerWebhook"
   mutation registerWebhook($url: String!) { ... }
   
   // ❌ Bad - anonymous mutation
   mutation { ... }
   ```

4. **Separate concerns** - Query structure vs data
   ```typescript
   // Query defines WHAT you're doing
   const mutation = `mutation($data: Input!) { create(input: $data) }`
   
   // Variables define HOW you're doing it
   const variables = { data: { name: 'Product', price: 29.99 } }
   ```

---

## Learning Curve

Don't worry about the learning curve! You're now using GraphQL **the way it's meant to be used.**

- **String interpolation** = Easy to start, dangerous in production
- **Variables** = Slightly more code, but industry standard and secure

Every major GraphQL client (Apollo, Relay, urql) uses variables by default because they're the right way to do it.

---

## Resources

- [GraphQL Variables Docs](https://graphql.org/learn/queries/#variables)
- [GraphQL Security Best Practices](https://www.apollographql.com/blog/graphql/security/9-ways-to-secure-your-graphql-api-security-checklist/)
- [Shopify GraphQL Learning Kit](https://shopify.dev/docs/api/usage)

**You're now following production-ready GraphQL practices!** 🎉
