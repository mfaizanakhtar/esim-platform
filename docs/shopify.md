# Shopify Integration

## App Configuration

**File:** `fulfillment-engine/shopify.app.toml`
**App:** `esim_fulfillment`
**Store:** `sailesim.myshopify.com`
**Partner Dashboard client ID:** `1d9541e35a5924941f451d33bf1c4c8f`

```toml
client_id = "1d9541e35a5924941f451d33bf1c4c8f"
application_url = "https://dashboard.sailesim.com"
embedded = true
api_version = "2026-04"
```

**Required scopes:**
```
read_orders, write_orders, read_products,
read_merchant_managed_fulfillment_orders,
write_merchant_managed_fulfillment_orders,
read_themes, write_themes,
write_draft_orders, read_draft_orders
```

---

## Webhooks

Registered on `sailesim.myshopify.com`. HMAC verified using `SHOPIFY_CLIENT_SECRET`.

| Topic | Endpoint | Purpose |
|-------|----------|---------|
| `orders/paid` | `POST /webhook/orders/paid` | Main provisioning trigger |
| `orders/cancelled` | `POST /webhook/orders/cancelled` | Cancel eSIM for order |

**Registering webhooks:**
```bash
cd fulfillment-engine
npm run webhook:register "https://api.sailesim.com"
```

> `SHOPIFY_SHOP_DOMAIN` must be the `.myshopify.com` domain (not custom domain) for Admin API calls.

### orders/paid Handler
1. Verify HMAC (`SHOPIFY_CLIENT_SECRET`)
2. Extract customer email (fallback chain: `customer.email` → `contact_email` → `email` → `billing_address.email`)
3. For each line item with `variant_id`:
   - Idempotency check: skip if `(orderId, lineItemId)` already exists
   - Detect top-up via `_iccid` line item property
   - Create `EsimDelivery { status: 'pending' }`
   - Write provisioning metafield (fire-and-forget)
   - Enqueue `provision-esim` job (3 retries × 60s, 1hr expiry)
4. Return `200` immediately (non-blocking)

---

## Metafield Schema

**Namespace:** `esim`
**Key:** `delivery_tokens`
**Type:** JSON

Written to the order by the API. Read by the UI extension.

```json
{
  "<lineItemId>": {
    "status": "provisioning",
    "accessToken": "uuid",
    "lpa": "lpa://...",
    "activationCode": "...",
    "iccid": "8901260...",
    "usageUrl": "https://sailesim.com/pages/esim-usage?iccid=...",
    "isTopup": false
  }
}
```

---

## UI Extension

**Location:** `fulfillment-engine/extensions/esim-order-status/`
**Deploy:** `shopify app deploy --force` from `fulfillment-engine/`

### Surfaces

| Target | File | Where it appears |
|--------|------|-----------------|
| `customer-account.order-status.announcement.render` | `OrderStatusAnnouncement.tsx` | Customer account order status page |
| `customer-account.order-status.cart-line-item.render-after` | `OrderStatusBlock.tsx` | Per-line-item in customer account |
| `purchase.thank-you.announcement.render` | `ThankYouAnnouncement.tsx` | Post-checkout thank you page |
| `purchase.thank-you.cart-line-item.render-after` | `ThankYouBlock.tsx` | Per-line-item on thank you page |
| `customer-account.order.action.*` | `OrderActionMenuItem.tsx`, `OrderBlock.tsx` | Cancel eSIM action |

### Extension Settings

Configured per-surface in Shopify Admin (Checkout editor or Customer accounts editor):

| Setting key | Value | Purpose |
|-------------|-------|---------|
| `backend_url` | `https://api.sailesim.com` | API for delivery polling |
| `storefront_url` | `https://sailesim.com` | Storefront link in thank-you block |

**Where to set:**
- **Thank-you page:** Shopify Admin → Settings → Checkout → Customize → click eSIM block → settings panel
- **Customer account:** Shopify Admin → Settings → Customer accounts → Customize → click eSIM block → settings panel

### Key Features
- Polls `/esim/delivery/:token` every 5 seconds until `status === 'delivered'`
- Shows QR code when `lpa` is available
- Rotating provisioning messages while waiting
- Handles multiple eSIMs per order

---

## Theme — eSIM Usage Page

**Theme:** Rise (active theme on `sailesim.myshopify.com`)
**Files:** `shopify-sailesim/` (local copy of the theme)

### Custom Files

| File | Purpose |
|------|---------|
| `templates/page.esim-usage.liquid` | Page template — sets `window.ESIM_API_BASE` |
| `assets/esim-usage.js` | SPA logic — search, display, polling |
| `assets/esim-usage.css` | Styles |

### Pushing Theme Changes

```bash
cd shopify-sailesim
shopify theme push \
  --store sailesim.myshopify.com \
  --theme-id <theme-id> \
  --only templates/page.esim-usage.liquid \
  --only assets/esim-usage.js \
  --only assets/esim-usage.css
```

Only push the 3 custom files — never push the whole theme folder (would overwrite merchant customizations).

### Creating the Usage Page
In Shopify Admin → Online Store → Pages:
- Title: `My eSIM Usage`
- Template: `page.esim-usage`

---

## Store Migration Checklist

When migrating to a new Shopify store:

- [ ] Create new app in Partner Dashboard → get new `client_id` + `client_secret`
- [ ] Install app on new store → get new `shpat_...` access token
- [ ] Update `shopify.app.toml` `client_id`
- [ ] Update Railway env vars (both `esim-api` and `esim-worker`):
  ```bash
  ./.claude/skills/railway/shopify-vars.sh \
    --shop new-store.myshopify.com \
    --client-id <id> \
    --client-secret <secret> \
    --access-token <shpat_...> \
    --custom-domain new-domain.com
  ```
- [ ] Register webhooks: `npm run webhook:register "https://api.new-domain.com"`
- [ ] Deploy extension: `shopify app deploy --force`
- [ ] Set extension settings in Shopify Admin (backend_url + storefront_url on all surfaces)
- [ ] Pull theme, copy 3 custom files, push only those files
- [ ] Create eSIM usage page in Shopify Admin
- [ ] Update `SHOPIFY_SHOP_DOMAIN` to `.myshopify.com` (not custom domain!)
