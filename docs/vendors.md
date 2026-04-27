# Vendor Integrations

Two vendors are currently integrated: **FiRoam** (synchronous) and **TGT Technology** (asynchronous). Both implement the `VendorProvider` interface in `src/vendor/types.ts`, enabling the provisioning engine to route orders to either vendor based on SKU mappings.

---

## Quick Comparison

| Aspect | FiRoam | TGT Technology |
|--------|--------|----------------|
| **Provisioning** | Synchronous — credentials in API response | Asynchronous — credentials via polling or callback |
| **Time to deliver** | <2 seconds | 5s – 5+ minutes |
| **Auth method** | Session token (login GET) + MD5 per-request signature | OAuth2 Bearer token (24h TTL) |
| **Request format** | `application/x-www-form-urlencoded` | `application/json` |
| **Cancellation** | ✅ API available | ❌ None — must cancel manually in TGT portal |
| **Renewal / topup** | ❌ Not implemented | ✅ `renewOrder()` + `createTopup()` |
| **Sandbox** | ❌ Production only | ✅ Separate sandbox credentials |
| **Callback handler** | Not needed | `POST /webhook/tgt/callback` |

---

## FiRoam

**Source:** `src/vendor/firoamClient.ts`, `src/vendor/providers/firoam.ts`
**Type:** Synchronous — all eSIM credentials returned immediately in the order creation response.

### Authentication

- `GET /api_order/login?phonenumber=...&password=...&sign=...`
- Returns a session token cached with 1-hour TTL and auto-refresh
- Every request signed with MD5 using `FIROAM_SIGN_KEY`
- No sandbox environment — all testing is against production

### providerSku Format

FiRoam SKU mappings use `providerSku` to encode the package:

**New format (preferred):**
```
skuId:apiCode:priceId
Example: 120:826-0-?-1-G-D:14094
```

**Legacy format:**
```
skuId:apiCode
Example: 156:14791
```

### Daypass Packages

- `apiCode` contains `?` as a placeholder: e.g., `826-0-?-1-G-D`
- At provisioning time, `?` is replaced with `daysCount` from the mapping
- `priceId`: read from `catalogEntry.rawPayload.priceid`, or fetched live via `getPackages(skuId)` if not cached

### Key APIs

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `loginIfNeeded()` | `GET /api_order/login` | Get/refresh session token |
| `addEsimOrder(payload)` | `POST /api_esim/addEsimOrder` | Place order → returns LPA, activationCode, ICCID |
| `getPackages(skuId)` | `POST /api_esim/getPackages` | Fetch daypass package options for priceId resolution |
| `cancelOrder(orderNum, iccids)` | `POST /api_esim/refundOrder` | Cancel and refund eSIM |
| `queryEsimOrder({ iccid })` | `POST /api_esim/queryEsimOrder` | Query order with usage stats |
| `getSkus()` | `POST /api_esim/getSkus` | Fetch all SKUs (catalog sync) |

### Response Shape (addEsimOrder)

FiRoam uses multiple field name variants depending on API version — the client normalises them all:

```json
{
  "code": 0,
  "data": {
    "orderNum": "EP-ORDER-123",
    "cardApiDtoList": [{
      "code":           "LPA:1$...$...",  // or
      "lpa":            "LPA:1$...$...",  // or
      "lpaString":      "LPA:1$...$...",  // or
      "sm_dp_address":  "LPA:1$...$...",  // — all normalised to lpa
      "activationCode": "ACT123",
      "iccid": "8999..."
    }]
  }
}
```

### Gotchas

- **Form-encoded requests** — POST bodies must be `application/x-www-form-urlencoded`, not JSON
- **Don't include `remark`** in cancel requests — causes signature validation errors
- **`cancelOrder()` requires `iccids`** even though the API docs mark it optional
- **No sandbox** — live orders are placed in production during any real test

### Catalog Sync

`POST /admin/provider-catalog/sync` with `{provider:'firoam'}` calls `getSkus()` → for each SKU calls `getPackages()` → upserts every package into `ProviderSkuCatalog` keyed on `(provider, skuId, productCode)`.

**`countryCodes` normalization** (important): FiRoam's `getPackages()` response includes `supportCountry` as an array of **display names** (e.g. `["Germany","France"]`), not ISO codes. The sync runs each entry through `normalizeFiroamCountries()` (in `src/utils/firoamCountryCodes.ts`), which uses `firoamNameToCode()` to map names to ISO 3166-1 alpha-2 codes before storing in the canonical `countryCodes` column. Names not in the lookup map are dropped with a warning log (`firoam-sync: dropped country names not in firoamNameToCode map`) so unmappable countries can be spotted and added. The raw response is still preserved in `rawPayload.skuCountryCodes` for debugging.

This invariant is what lets region discovery, structured-match REGION branch (JSONB `@>`), and AI mapping post-filter all rely on `countryCodes` being uniform ISO codes regardless of provider.

---

## TGT Technology

**Source:** `src/vendor/tgtClient.ts`, `src/vendor/providers/tgt.ts`, `src/api/tgtCallback.ts`, `src/worker/jobs/tgtPoll.ts`
**Type:** Asynchronous — `createOrder()` returns an `orderNo` immediately; credentials arrive minutes later via polling or webhook callback.

### Authentication

- OAuth2 client credentials: `POST /oauth/token` with `TGT_ACCOUNT_ID` + `TGT_SECRET`
- Token cached with 24-hour TTL and auto-refresh
- No per-request signature required (Bearer token only)

### Fulfillment Modes

Configure via `TGT_FULFILLMENT_MODE` env var:

| Mode | Behavior | When to use |
|------|----------|-------------|
| `hybrid` **(default)** | Poll first (up to `TGT_POLL_MAX_ATTEMPTS` × `TGT_POLL_INTERVAL_SECONDS`s), then fall back to awaiting callback | Best for most cases |
| `polling` | Poll only — fail delivery if max attempts exhausted | When callbacks not available |
| `callback` | Skip polling entirely, wait for TGT webhook | When TGT credentials always arrive slowly |

Default polling config: 8 attempts × 15 seconds = up to ~105 seconds before falling back to callback.

### TGT Callback Webhook — Registration URL

**TGT must register this URL in their admin portal:**

```
POST https://api.sailesim.com/webhook/tgt/callback
```

**Handler file:** `src/api/tgtCallback.ts`
**Server registration:** `src/server.ts` — `app.register(tgtCallbackRoutes, { prefix: '/webhook/tgt' })`

**Signature verification:** MD5 (not HMAC-SHA256). TGT flattens and sorts the payload fields alphabetically, concatenates them, wraps with `TGT_CALLBACK_SECRET`, and MD5-hashes the result.

**TGT retries** the callback every 5 seconds for up to 2 hours if we don't respond with `{ code: "0000" }`. Our handler always returns `{ code: "0000", msg: "success" }` — even on internal errors — to prevent runaway retries. Idempotency is handled inside `finalizeDelivery()`.

**What TGT POSTs:**

```json
{
  "code": "0000",
  "msg": "success",
  "timestamp": "2026-03-15T12:34:56Z",
  "sign": "abc123...",
  "data": {
    "eventType": 1,
    "businessType": "ESIM",
    "orderInfo": {
      "orderNo": "SE2026031500001234",
      "qrCode": "LPA:1$esiminfra.toprsp.com$ACTIVATION_CODE",
      "iccid": "8999240100000000001234",
      "imsi": "310260000000001234",
      "msisdn": "+16505551234"
    }
  }
}
```

Note: `orderInfo` is a single object for `eventType` 1 and 3, but an **array** for `eventType` 2 (renewal). The handler normalises both.

### providerSku Format

TGT uses the `productCode` string directly. Example: `A-002-ES-AU-3G-30D-M1`

### Card Types

| Type | Topup method | Notes |
|------|-------------|-------|
| **M1, C2, F2** | Async `renewOrder()` | Renewal enqueues a new async order → polling/callback |
| **C4** | Sync `createTopup()` | Returns `topupNumber` immediately |

Identify card type from `productCode` suffix or `providerConfig.tgtPurchaseType` on the mapping.

### Key APIs

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `authIfNeeded()` | `POST /oauth/token` | Get/refresh Bearer token |
| `createOrder(payload)` | `POST /eSIMApi/v2/order/create` | Place new order → returns `orderNo` |
| `queryOrders({ iccid \| orderNo })` | `POST /eSIMApi/v2/order/orders` | Poll for credentials; also used in cancel checks |
| `tryResolveOrderCredentials(orderNo)` | wraps queryOrders | Poll until `qrCode` (LPA) is available |
| `listProducts()` | `POST /eSIMApi/v2/products/list` | Fetch product catalogue (catalog sync) |
| `createTopup(payload)` | `POST /eSIMApi/v2/order/topup/create` | Sync C4 daily pack topup |
| `renewOrder(payload)` | `POST /eSIMApi/v2/order/renew` | Async renewal for M1/C2/F2 |
| `getUsage({ iccid })` | `POST /eSIMApi/v2/order/usage` | Check data usage |

### Response Shape (queryOrders / callback)

```json
{
  "code": "0000",
  "msg": "success",
  "data": {
    "list": [{
      "orderNo": "SE2026...",
      "qrCode": "LPA:1$esiminfra.toprsp.com$ACT_CODE",
      "iccid": "8999...",
      "cardInfo": { "iccid": "8999..." },
      "profileStatus": "nodownload",
      "activatedStartTime": null,
      "orderStatus": "NOTACTIVE"
    }]
  }
}
```

- `qrCode` contains the full LPA string — activation code is `qrCode.split('$')[2]`
- ICCID may be at `order.iccid` OR `order.cardInfo.iccid` — both locations are checked

### Cancellation — No API Available

**TGT has no cancellation API.** When a cancel is triggered:

- **Not-yet-delivered** (status ≠ delivered): Marked `cancelled` in DB immediately. No vendor action needed.
- **Delivered, not yet activated** (no `profileStatus` or `activatedStartTime`): Marked `cancelled` in DB. Order tagged `esim-tgt-manual-cancel-needed` — **must cancel manually in the TGT portal**.
- **Delivered, already activated**: Cancel blocked. Order tagged `esim-cancel-failed` + `esim-activated`. Manual review required.

### Idempotency

Each new TGT order includes an `idempotencyKey` (UUID). If the same key is resent (on retry), TGT returns the existing order instead of creating a duplicate.

### Sandbox

TGT provides a sandbox environment. Switch by setting `TGT_BASE_URL` to:
```
https://enterpriseapisandbox.tugegroup.com:8070/openapi
```
with sandbox `TGT_ACCOUNT_ID` and `TGT_SECRET`.

### Catalog Sync

`GET /admin/sku-mappings/catalog/sync?provider=tgt` calls `listProducts()` (paginated) → stores all products in `ProviderSkuCatalog`.

---

## Adding a New Vendor

1. Create `src/vendor/<vendor>Client.ts` — HTTP client with auth + retry
2. Create `src/vendor/<vendor>Schemas.ts` — Zod schemas for all API responses
3. Create `src/vendor/providers/<vendor>.ts` — implement `VendorProvider` interface:
   ```typescript
   interface VendorProvider {
     name: string;
     provision(delivery: EsimDelivery, mapping: ProviderSkuMapping): Promise<VendorResult>;
     cancel?(delivery: EsimDelivery): Promise<void>;
   }
   ```
4. Register in `src/vendor/registry.ts`
5. Add env vars to `.env.example` and `docs/env-vars.md`
6. Add vendor docs section to this file
