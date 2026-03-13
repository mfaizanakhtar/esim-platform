# Shopify eSIM Backend - Quick Start Guide

> **Document Type**: Setup & Deployment  
> **Status**: ✅ Current  
> **Last Updated**: 2026-03-01  
> **Purpose**: Local development environment setup

---

## 🎯 Overview

This backend automatically provisions and delivers eSIMs after a successful Shopify payment. It uses:

- **Shopify Dev Dashboard App** with client credentials OAuth
- **GraphQL Admin API** for webhook management and order data
- **ngrok** for local development and testing
- **pg-boss** for async job processing

---

## 🚀 Initial Setup (One Time)

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup Database

```bash
npx prisma migrate dev
npx prisma generate
```

### 3. Configure Environment

Your `.env` should already have:

- `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` from Dev Dashboard
- `SHOPIFY_WEBHOOK_SECRET` set to your CLIENT_SECRET (for HMAC verification)
- `SHOPIFY_SHOP_DOMAIN` set to your store
- FiRoam credentials configured

---

## 🔧 Local Development Workflow

### Step 1: Start All Services

**Terminal 1 - API Server:**

```bash
npm run dev
```

**Terminal 2 - Worker Process:**

```bash
npm run dev:worker
```

**Terminal 3 - ngrok (expose local server):**

```bash
npm run ngrok
```

Copy the HTTPS URL from ngrok output (e.g., `https://abc123.ngrok-free.dev`)

### Step 2: Register Webhook

**First time or after ngrok URL changes:**

```bash
npm run webhook:register https://YOUR-NGROK-URL
```

Example:

```bash
npm run webhook:register https://bodhi-contractible-leilani.ngrok-free.dev
```

This will register the `orders/paid` webhook and display the webhook ID.

### Step 3: Configure Product Metafields

For each eSIM product variant in Shopify admin:

1. Go to **Products** → Select product → Select variant
2. Scroll to **Metafields** section
3. Add these metafields:
   - **Namespace:** `vendor`, **Key:** `planCode`, **Value:** FiRoam package code (e.g., `5GB-7DAYS-GLOBAL`)
   - **Namespace:** `delivery`, **Key:** `type`, **Value:** `qr`

### Step 4: Test with Order

1. Create test order in Shopify admin
2. Add an eSIM product with configured metafields
3. Mark order as **Paid**
4. Watch logs in Terminal 1 (API) and Terminal 2 (Worker)

---

## 📋 Webhook Management Commands

### List All Webhooks

```bash
npm run webhook:list
```

Shows all registered webhooks with IDs, topics, and URLs.

### Update Webhook URL (When ngrok Changes)

```bash
npm run webhook:update <webhook-id> <new-ngrok-url>
```

Example:

```bash
npm run webhook:update gid://shopify/WebhookSubscription/2144974635338 https://new-url.ngrok-free.dev
```

**Pro tip:** Save your webhook ID from the initial registration!

### Delete Webhook

```bash
npm run webhook:delete <webhook-id>
```

Example:

```bash
npm run webhook:delete gid://shopify/WebhookSubscription/2144974635338
```

### Check App Scopes

```bash
npm run webhook:check-scopes
```

Verifies your app has the required scopes for webhook operations.

---

## 🔄 When ngrok URL Changes

Every time you restart ngrok, you get a new URL (unless you have a paid plan). Here's what to do:

### Option 1: Update Existing Webhook (Recommended)

```bash
# 1. Get your webhook ID
npm run webhook:list

# 2. Update with new URL
npm run webhook:update gid://shopify/WebhookSubscription/YOUR_ID https://new-url.ngrok-free.dev
```

### Option 2: Delete and Re-register

```bash
# 1. Delete old webhook
npm run webhook:delete gid://shopify/WebhookSubscription/YOUR_ID

# 2. Register new webhook
npm run webhook:register https://new-url.ngrok-free.dev
```

**No server restart needed!** The webhook URL is on Shopify's side, not in your app.

---

## 🔍 What Changed to Make Webhooks Work

### The Problem

- Dev Dashboard apps with client credentials grant **cannot** create webhooks via the GraphQL API's `webhookSubscriptionCreate` mutation (it returns "cannot create webhook subscription with specified topic")
- This differs from Shopify CLI apps (with TOML config) and custom apps (created in admin)

### The Solution

After testing multiple approaches, discovered that:

1. **Shopify CLI `deploy`** command can register webhooks from `shopify.app.toml`
2. **Direct GraphQL mutation** works AFTER the app is deployed via CLI
3. The key was using the correct scope: `read_orders` (not `read_all_orders`)

### What Was Done

1. Installed Shopify CLI: `npm install -g @shopify/cli @shopify/app`
2. Created `shopify.app.toml` with app configuration and webhook definition
3. Deployed app: `shopify app deploy` (this registered the webhook config)
4. Created `register-http-webhook.ts` script that uses the GraphQL mutation successfully
5. Updated scopes to `read_orders,write_fulfillments,customer_read_orders`

### Key Files Created/Updated

- **shopify.app.toml** - App configuration with webhook definition
- **scripts/register-http-webhook.ts** - Working webhook registration
- **scripts/update-webhook.ts** - Update webhook URL when ngrok changes
- **scripts/delete-webhook.ts** - Remove webhooks
- **package.json** - Added npm scripts for webhook management

---

---

## ✅ Expected Log Output

### API Server Logs (Terminal 1)

```
✅ Job queue initialized
✅ Shopify client initialized
✅ Server listening on http://localhost:3000

[POST] /webhook/orders/paid
✅ HMAC verified
📦 Processing order #1001 with 2 line items
✅ Created delivery record: clxyz123-abc...
✅ Enqueued provisioning job
→ HTTP 200
```

### Worker Logs (Terminal 2)

```
🔧 Starting worker process...
✅ Worker registered for 'provision-esim' jobs

📦 Processing job: abc123-def...
🔍 Fetching variant metafields for gid://shopify/ProductVariant/123
📋 Vendor plan: 5GB-7DAYS-GLOBAL
🌐 Calling FiRoam API...
✅ eSIM provisioned: FiRoam_Order_456789
💾 Updated delivery record: DELIVERED
✅ Job abc123-def completed
```

### ngrok Dashboard (http://localhost:4040)

- View webhook requests in real-time
- Inspect request headers, body, and HMAC signature
- See response codes and timing

---

## 🐛 Troubleshooting

### Webhook Not Received

**Symptom:** Order marked as paid, but no logs in API server

**Solutions:**

1. Verify ngrok is running: `npm run ngrok`
2. Check webhook URL matches ngrok: `npm run webhook:list`
3. If URLs don't match: `npm run webhook:update <webhook-id> <ngrok-url>`
4. Test endpoint manually:
   ```bash
   curl -X POST https://YOUR-NGROK-URL/webhook/orders/paid \
     -H "Content-Type: application/json" \
     -d '{"test": true}'
   ```

### HMAC Verification Fails

**Symptom:** `❌ HMAC verification failed` in API logs

**Solutions:**

1. Verify `.env` has: `SHOPIFY_WEBHOOK_SECRET=your_client_secret`
2. Restart API server after changing .env
3. Check CLIENT_SECRET matches Dev Dashboard

### Worker Not Processing Jobs

**Symptom:** Webhook received, but job never completes

**Solutions:**

1. Check worker is running: Terminal 2 should show worker logs
2. Verify DATABASE_URL is correct in .env
3. Check pg-boss tables exist:
   ```bash
   npx prisma migrate dev
   ```
4. Check for errors in worker logs

### eSIM Provisioning Fails

**Symptom:** Job processed, but status is FAILED

**Solutions:**

1. Check variant metafields are configured (vendor.planCode)
2. Verify FiRoam credentials in .env
3. Check worker logs for specific error:
   ```
   ❌ FiRoam API error: Invalid package code
   ```
4. Test FiRoam connection:
   ```bash
   npm run test:component
   ```

### Duplicate eSIMs Provisioned

**Symptom:** Same order provisions multiple eSIMs

**This should never happen!** The system has idempotency checks.

If it does:

1. Check database for duplicate delivery records with same orderId + lineItemId
2. Review webhook logs - Shopify may be retrying due to slow responses
3. Ensure webhook handler returns 200 quickly (within 5 seconds)

---

## 📚 Additional Documentation

- **AGENTS.md** - Full system architecture and design principles
- **SHOPIFY_INTEGRATION.md** - Detailed Shopify integration guide
- **FiRoam_documentation.txt** - Vendor API reference
- **shopify.app.toml** - App configuration (scopes, webhooks, etc.)

---

## 🎓 Quick Reference

### Common Commands

```bash
# Development
npm run dev              # Start API server
npm run dev:worker       # Start worker
npm run ngrok           # Start ngrok tunnel

# Webhooks
npm run webhook:list                    # List all webhooks
npm run webhook:register <url>          # Register new webhook
npm run webhook:update <id> <url>       # Update webhook URL
npm run webhook:delete <id>             # Delete webhook
npm run webhook:check-scopes            # Verify app scopes

# Database
npx prisma migrate dev                  # Run migrations
npx prisma studio                       # Open database GUI

# Testing
npm run test:component                  # Test FiRoam integration
```

### Environment Variables

```bash
# Shopify (from Dev Dashboard)
SHOPIFY_SHOP_DOMAIN=yourstore.myshopify.com
SHOPIFY_CLIENT_ID=fb0eb60941e...
SHOPIFY_CLIENT_SECRET=shpss_89a02b...
SHOPIFY_WEBHOOK_SECRET=shpss_89a02b...  # Same as CLIENT_SECRET

# FiRoam
FIROAM_BASE_URL=https://bpm.roamwifi.hk
FIROAM_PHONE=923222825575
FIROAM_PASSWORD=esim825575
FIROAM_SIGN_KEY=1234567890qwerty...

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/esim
```

---

## 💡 Pro Tips

1. **Save your webhook ID** after first registration to make updates easier
2. **Use ngrok's paid plan** ($8/mo) to get a static URL that never changes
3. **Monitor ngrok dashboard** (http://localhost:4040) during testing
4. **Use Shopify's webhook testing** in Dev Dashboard to send test payloads
5. **Check pg-boss queue** in database to see pending/failed jobs:
   ```sql
   SELECT * FROM pgboss.job WHERE name = 'provision-esim' ORDER BY createdon DESC LIMIT 10;
   ```

---

**Ready to go!** 🚀

Start all three terminals, register your webhook, and create a test order.
