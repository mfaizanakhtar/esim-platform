# Public API Reference

No authentication required. CORS enabled for all origins.

**Source:** `fulfillment-engine/src/api/usage.ts`, `fulfillment-engine/src/api/esim.ts`

---

## eSIM Usage Tracking

### GET /api/esim/usage
Search for eSIM usage data. Used by the Shopify usage page (`/pages/esim-usage`).

**Query:** `?q=<search_term>`

**Search logic:**
| Input | Match type | Result |
|-------|-----------|--------|
| Contains `@` | Email | Multi-result grid |
| Matches `/^\d+$/` | Order number | Single result |
| Anything else | ICCID | Single result |

**Single result response:**
```json
{
  "iccid": "8901260...",
  "orderNum": "#1001",
  "region": "EU",
  "packageName": "5GB / 30 days",
  "provider": "firoam",
  "status": 0,
  "usage": {
    "totalMb": 5120,
    "usedMb": 1024,
    "remainingMb": 4096,
    "usagePercent": 20
  },
  "validity": {
    "days": 30,
    "beginDate": "2026-04-01",
    "endDate": "2026-05-01"
  }
}
```

**Multi-result response (email or multi-eSIM order search):**
```json
{
  "results": [
    { "iccid": "...", "orderNum": "#1001", "usage": { ... } },
    { "iccid": "...", "orderNum": "#1001", "usage": { ... } }
  ]
}
```

**Error responses:**
- `404` — no eSIM found for query
- `502` — vendor API unavailable

**Notes:**
- ICCID lookup is O(1) via `iccidHash` index (no full-table scan)
- FiRoam: fetches live usage from vendor API
- TGT: fetches live usage from vendor API

---

## Order Status (Extension Polling)

### GET /esim/order-status/:orderId
Returns all delivery statuses for an order. Used by checkout thank-you page extensions.

**Response (order with deliveries):**
```json
{
  "status": "delivered",
  "accessToken": "uuid-first",
  "deliveries": [
    { "lineItemId": "123", "variantId": "456", "status": "delivered", "accessToken": "uuid-1" },
    { "lineItemId": "124", "variantId": "789", "status": "provisioning" }
  ]
}
```

**Response (no deliveries):**
```json
{ "status": null, "deliveries": [] }
```

Top-level `status`/`accessToken` are backward-compatible (first delivery only). `accessToken` is only present when the first delivery's status is `"delivered"`. `deliveries[]` contains all line items with per-item `lineItemId`, `variantId`, `status`, and `accessToken` (when delivered).

### GET /esim/order-deliveries/:orderId
Returns all deliveries for an order. Used by customer account extensions.

**Response:**
```json
{
  "deliveries": [
    { "lineItemId": "123", "status": "delivered", "accessToken": "uuid-1" },
    { "lineItemId": "124", "status": "provisioning" }
  ]
}
```

Each entry includes `lineItemId`, `status`, and `accessToken` (only when `status === "delivered"`).

---

## Delivery Status Polling

### GET /esim/delivery/:token
Poll delivery status by access token. Used by the Shopify UI extension while customer waits on order status page.

**Params:** `:token` — UUID access token from `EsimDelivery.accessToken`

**Response:**
```json
{
  "status": "delivered",
  "accessToken": "uuid-here",
  "lpa": "lpa://...",
  "activationCode": "...",
  "iccid": "8901260...",
  "usageUrl": "https://sailesim.com/pages/esim-usage?iccid=...",
  "isTopup": false
}
```

**Status values during polling:**
- `pending` — job not yet started
- `provisioning` — job running
- `vendor_ordered` — TGT order created, waiting for credentials
- `polling` — actively polling TGT
- `awaiting_callback` — waiting for TGT webhook
- `delivered` — credentials available (lpa, activationCode, iccid populated)
- `failed` — provisioning failed
- `cancelled` — order was cancelled

The UI extension polls this endpoint every 5 seconds until `status === 'delivered'`.

---

## TGT Callback (Internal)

### POST /api/tgt/callback
Receives async credential delivery from TGT. Not for public use — TGT calls this.

**Auth:** HMAC-SHA256 signature (`TGT_CALLBACK_SECRET` or falls back to `TGT_SECRET`)

**Body:** TGT order fulfillment payload with `orderNo`, `lpa`, `activationCode`, `iccid`
