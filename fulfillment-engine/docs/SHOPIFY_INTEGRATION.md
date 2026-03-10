# Shopify Integration Setup

> **Document Type**: Integration  
> **Status**: ✅ Current  
> **Last Updated**: 2026-03-01  
> **Purpose**: Shopify Custom App setup and webhook configuration

---

## Overview

This backend integrates with Shopify to automatically provision and deliver eSIMs when orders are paid.

**Flow:**

1. Customer pays for eSIM product in Shopify
2. Shopify sends `orders/paid` webhook to backend
3. Backend verifies HMAC, creates delivery record, enqueues job
4. Worker provisions eSIM from FiRoam vendor
5. Backend sends QR code email and creates fulfillment

---

## Prerequisites

1. **Shopify Dev Dashboard App**
   - Go to https://dev.shopify.com/dashboard/
   - Create new app
   - Configure scopes (Admin API access scopes):
     - `read_orders` - Read order details
     - `read_products` - Read product/variant metafields
     - `read_merchant_managed_fulfillment_orders` - Read fulfillment orders
     - `write_merchant_managed_fulfillment_orders` - Create fulfillments
   - Install to your store
   - Get Client ID and Client Secret from Settings page

2. **Environment Variables**

   ```bash
   SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
   SHOPIFY_CLIENT_ID=xxxxx
   SHOPIFY_CLIENT_SECRET=xxxxx
   SHOPIFY_WEBHOOK_SECRET=xxxxx  # From webhook configuration
   ```

3. **Product Metafields**
   Each eSIM product variant must have metafields:
   - `vendor.planCode` - FiRoam package code
   - `vendor.productId` - (optional) FiRoam product ID
   - `delivery.type` - `qr` or `activation_code`

---

## Local Development

### 1. Start the API server

```bash
npm run dev
```

### 2. Start the worker process

```bash
npm run worker
```

### 3. Expose local server with ngrok

```bash
./scripts/ngrok.sh
```

Copy the HTTPS URL (e.g. `https://abc123.ngrok.io`)

### 4. Register webhook in Shopify Dev Dashboard

- Go to your app in Dev Dashboard
- Navigate to **Configuration → Webhooks**
- Add webhook:
  - **Event:** `orders/paid`
  - **URL:** `https://YOUR-NGROK-URL/webhook/orders/paid`
  - **API version:** `2026-01`
- Save and copy the **Webhook Signing Secret**
- Add to `.env` as `SHOPIFY_WEBHOOK_SECRET`

### 5. Test with a Shopify order

- Create test order in Shopify admin
- Mark as paid
- Check logs:

  ```bash
  # API logs
  npm run dev

  # Worker logs
  npm run worker
  ```

---

## Production Deployment

1. Deploy API and Worker as separate processes
2. Use public HTTPS URL for webhooks
3. Configure webhooks in Shopify Dev Dashboard with production URL
4. Monitor logs and job queue health

---

## Webhook Security

- All webhooks are HMAC-verified using `X-Shopify-Hmac-Sha256` header
- Invalid signatures are rejected with 401
- Idempotency ensures duplicate webhooks don't create duplicate orders

---

## Troubleshooting

### Webhook not received

- Check ngrok is running and URL is correct
- Verify webhook is registered in Dev Dashboard
- Check Shopify webhook delivery logs

### HMAC verification fails

- Ensure `SHOPIFY_WEBHOOK_SECRET` matches Dev Dashboard
- Check raw body is preserved (no automatic parsing)

### eSIM provisioning fails

- Check worker logs for FiRoam API errors
- Verify variant metafields are configured
- Check FiRoam credentials in `.env`

### Token expires

- Client refreshes tokens automatically every 24 hours
- Check `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` are correct
