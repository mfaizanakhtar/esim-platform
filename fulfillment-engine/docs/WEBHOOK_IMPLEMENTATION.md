# Shopify Webhook Integration - Implementation Summary

> **Document Type**: Integration  
> **Status**: ✅ Current  
> **Last Updated**: 2026-03-01  
> **Purpose**: Webhook handler implementation details and flow

---

## 🎯 What Was Built

Successfully integrated Shopify order webhooks to automatically provision eSIMs when orders are paid.

---

## 🔧 Technical Approach

### Challenge

Shopify Dev Dashboard apps using client credentials OAuth **cannot** create webhooks directly via GraphQL API mutations. The mutation returns:

```
"You cannot create a webhook subscription with the specified topic"
```

This differs from:

- **Shopify CLI apps** (with shopify.app.toml config)
- **Custom apps** (created in Shopify admin)

### Solution

Multi-step process combining Shopify CLI and GraphQL API:

1. **Installed Shopify CLI**

   ```bash
   npm install -g @shopify/cli @shopify/app
   ```

2. **Created shopify.app.toml** with webhook configuration

   ```toml
   [webhooks]
   api_version = "2026-01"

   [[webhooks.subscriptions]]
   topics = [ "orders/paid" ]
   uri = "/webhook/orders/paid"
   ```

3. **Deployed via CLI** to register webhook infrastructure

   ```bash
   shopify app deploy
   ```

4. **Created GraphQL scripts** that now work post-deployment
   - `register-http-webhook.ts` - Register new webhooks
   - `update-webhook.ts` - Update webhook URLs
   - `delete-webhook.ts` - Remove webhooks
   - `list-webhooks.ts` - View all webhooks

5. **Key Discovery: Scope Names**
   - Must use `read_orders` (not `read_all_orders`)
   - Required scopes: `read_orders,write_fulfillments,customer_read_orders`

---

## 📁 Files Created/Modified

### New Scripts

```
scripts/
├── register-http-webhook.ts    # Working webhook registration via GraphQL
├── update-webhook.ts           # Update webhook URL (for ngrok changes)
├── delete-webhook.ts           # Delete webhooks
├── list-webhooks.ts           # List all registered webhooks
├── check-scopes.ts            # Verify app has correct scopes
├── get-webhook-secret.ts      # Attempt to get webhook secret (not available via API)
├── debug-webhook.ts           # Debug webhook creation issues
└── test-topics.ts            # Test multiple webhook topics
```

### New Configuration

```
shopify.app.toml               # App config for Shopify CLI (scopes, webhooks)
```

### Updated Files

```
package.json                   # Added npm scripts for webhook management
QUICKSTART.md                  # Complete guide for local development
.env                          # SHOPIFY_WEBHOOK_SECRET = CLIENT_SECRET
```

### Core Integration (Already Built)

```
src/
├── shopify/
│   ├── client.ts             # GraphQL Admin API client with auto token refresh
│   └── webhooks.ts           # HMAC verification utilities
├── api/
│   └── webhook.ts            # Fastify route handler for orders/paid
├── worker/
│   ├── index.ts              # Worker process that provisions eSIMs
│   └── jobs/
│       └── provisionEsim.ts  # Job handler for async provisioning
└── queue/
    └── jobQueue.ts           # pg-boss wrapper for job management
```

---

## 🚀 How It Works

### Flow

1. **Customer pays** for order in Shopify store
2. **Shopify fires** `orders/paid` webhook to ngrok URL
3. **API server receives** webhook at `/webhook/orders/paid`
4. **HMAC verified** using `SHOPIFY_WEBHOOK_SECRET` (CLIENT_SECRET)
5. **Idempotency check** prevents duplicate processing
6. **Delivery record created** for each line item in database
7. **Job enqueued** in pg-boss queue
8. **Worker picks up job** and processes asynchronously
9. **Variant metafields fetched** to get FiRoam plan code
10. **FiRoam API called** to provision eSIM
11. **Delivery record updated** with vendor reference and encrypted payload
12. **Email sent** with QR code and activation instructions (TODO)
13. **Fulfillment created** in Shopify (TODO)

### Authentication

- **OAuth:** Client credentials grant (24hr access tokens, auto-refresh)
- **Webhook HMAC:** CLIENT_SECRET used for signature verification
- **Scopes:** read_orders, write_fulfillments, customer_read_orders

---

## 📋 NPM Scripts

### Development

```bash
npm run dev              # Start API server (port 3000)
npm run dev:worker       # Start worker process
npm run dev:all          # Start both (using concurrently)
npm run ngrok           # Start ngrok tunnel
```

### Webhook Management

```bash
npm run webhook:register <url>      # Register new webhook
npm run webhook:list                # List all webhooks
npm run webhook:update <id> <url>   # Update webhook URL
npm run webhook:delete <id>         # Delete webhook
npm run webhook:check-scopes        # Verify app scopes
```

### Database

```bash
npm run prisma:generate    # Generate Prisma client
npm run prisma:migrate     # Run migrations
```

### Testing

```bash
npm run test:component     # Test FiRoam integration
npm test                  # Run all tests
```

---

## 🔄 Handling ngrok URL Changes

Every time ngrok restarts (free plan), you get a new URL. Two options:

### Option 1: Update Existing Webhook (Faster)

```bash
# 1. Get webhook ID
npm run webhook:list

# 2. Update URL
npm run webhook:update gid://shopify/WebhookSubscription/YOUR_ID https://new-url.ngrok-free.dev
```

### Option 2: Delete and Re-register

```bash
# 1. Delete old webhook
npm run webhook:delete gid://shopify/WebhookSubscription/YOUR_ID

# 2. Register new webhook
npm run webhook:register https://new-url.ngrok-free.dev
```

**Pro tip:** Pay $8/mo for ngrok static URL to avoid this entirely.

---

## 🔐 Security

### HMAC Verification

Every webhook is verified using HMAC-SHA256 signature:

```typescript
const hmac = crypto
  .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
  .update(rawBody, 'utf8')
  .digest('base64');

if (hmac !== shopifyHmac) {
  return reply.status(401).send({ error: 'Invalid signature' });
}
```

### Idempotency

Prevents duplicate provisioning even if Shopify retries webhook:

```typescript
const idempotencyKey = generateIdempotencyKey(orderId, lineItemId);

const existing = await prisma.esimDelivery.findFirst({
  where: {
    orderId: order.id.toString(),
    lineItemId: lineItem.id.toString(),
  },
});

if (existing) {
  console.log('⚠️  Duplicate webhook, skipping');
  return; // Return 200, but don't process
}
```

### Encrypted Storage

Sensitive eSIM data (LPA strings, activation codes) stored encrypted at rest:

```typescript
payloadEncrypted: CryptoJS.AES.encrypt(JSON.stringify(vendorData), ENCRYPTION_KEY).toString();
```

---

## 📊 Database Schema

### EsimDelivery

```prisma
model EsimDelivery {
  id                 String   @id @default(cuid())
  shop               String
  orderId            String
  orderName          String
  lineItemId         String
  variantId          String
  customerEmail      String
  vendorReferenceId  String?
  payloadEncrypted   String?
  status             DeliveryStatus
  lastError          String?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  attempts           DeliveryAttempt[]
}

enum DeliveryStatus {
  PENDING
  PROVISIONING
  DELIVERED
  FAILED
  REFUNDED
}
```

### DeliveryAttempt

```prisma
model DeliveryAttempt {
  id           String   @id @default(cuid())
  deliveryId   String
  channel      String   // 'email' | 'sms'
  result       String
  createdAt    DateTime @default(now())

  delivery     EsimDelivery @relation(fields: [deliveryId], references: [id])
}
```

---

## ✅ What Works Now

- [x] Shopify webhook registration via GraphQL API
- [x] Webhook HMAC verification
- [x] Idempotency checks for duplicate webhooks
- [x] Async job processing with pg-boss
- [x] eSIM provisioning via FiRoam API
- [x] Variant metafield retrieval for vendor plan codes
- [x] Encrypted storage of sensitive eSIM data
- [x] Automatic access token refresh (24hr client credentials)
- [x] Webhook URL updates when ngrok changes
- [x] Complete local development workflow

---

## 🚧 TODO (Next Steps)

- [ ] Email delivery with QR code generation
- [ ] Shopify fulfillment creation after successful provisioning
- [ ] Customer retrieval page (GET /delivery/:token)
- [ ] Retry logic for failed FiRoam API calls
- [ ] Webhook for refunds (orders/cancelled, refunds/create)
- [ ] Admin dashboard for viewing/resending deliveries
- [ ] Monitoring and alerting for failed jobs
- [ ] Production deployment (Render/Railway)

---

## 🐛 Debugging Tips

### View Webhook Requests

```bash
# ngrok web interface
open http://localhost:4040
```

### Check pg-boss Queue

```sql
-- See pending jobs
SELECT * FROM pgboss.job
WHERE name = 'provision-esim' AND state = 'created'
ORDER BY createdon DESC;

-- See failed jobs
SELECT * FROM pgboss.job
WHERE name = 'provision-esim' AND state = 'failed'
ORDER BY createdon DESC;
```

### Check Delivery Records

```sql
-- See all deliveries
SELECT id, orderName, status, vendorReferenceId, createdAt
FROM "EsimDelivery"
ORDER BY createdAt DESC;

-- See failed deliveries
SELECT * FROM "EsimDelivery"
WHERE status = 'FAILED';
```

### Test FiRoam Connection

```bash
npm run test:component
```

### Verify Shopify Client

```bash
npm run webhook:check-scopes
```

---

## 📖 Key Learnings

1. **Dev Dashboard apps are different** from CLI apps and custom apps
   - Cannot create webhooks directly via GraphQL (requires CLI deploy first)
   - Scopes configured in UI, not via API
   - CLIENT_SECRET is the webhook HMAC secret

2. **Scope naming matters**
   - Use `read_orders` not `read_all_orders` for webhooks
   - `read_all_orders` is newer but may not be recognized everywhere

3. **Shopify CLI is required** for initial webhook infrastructure
   - Deploy via CLI registers the app configuration
   - After that, GraphQL mutations work for managing webhooks

4. **Idempotency is critical**
   - Shopify retries webhooks if response is slow or times out
   - Must check database before processing to prevent duplicates

5. **Client credentials grant**
   - 24hr access tokens require auto-refresh logic
   - No OAuth flow needed for backend-only integration
   - Simpler than authorization code grant for this use case

---

## 🎓 Resources

- [Shopify Admin API](https://shopify.dev/docs/api/admin)
- [Webhooks Documentation](https://shopify.dev/docs/api/webhooks)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli)
- [Client Credentials Grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials)
- [pg-boss](https://github.com/timgit/pg-boss)

---

**Status:** ✅ Webhook integration fully functional and ready for testing
