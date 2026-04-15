# Vendor Integrations

## FiRoam

**Type:** Synchronous — credentials returned immediately in API response
**Source:** `fulfillment-engine/src/vendor/firoamClient.ts`, `src/vendor/providers/firoam.ts`

### Authentication
- Login with phone + password → receive session token
- Token cached with auto-refresh
- Every request signed with MD5 using `FIROAM_SIGN_KEY`

### providerSku Format

FiRoam mappings use two formats in `providerSku`:

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
- Price ID: read from catalog `rawPayload.priceid`, or fetched via `getPackages(skuId)` if not cached

### Key APIs
| Method | Purpose |
|--------|---------|
| `getPackages(skuId)` | Fetch daypass package options |
| `addEsimOrder(payload)` | Create eSIM order → returns `{ vendorId, lpa, activationCode, iccid }` |
| `getPackageUsage(iccid)` | Live usage stats for usage page |

### Catalog Sync
Endpoint: `GET /skus` → array of SKU objects
Stored fields: `skuId`, `productCode` (apiCode), `skuName`, `netPrice`, raw payload

---

## TGT Technology

**Type:** Asynchronous — order created first, credentials come later via polling or webhook
**Source:** `fulfillment-engine/src/vendor/tgtClient.ts`, `src/vendor/providers/tgt.ts`

### Authentication
- OAuth 2.0 client credentials flow
- Short-lived tokens, auto-refreshed
- `TGT_ACCOUNT_ID` + `TGT_SECRET`

### Fulfillment Modes

Configure via `TGT_FULFILLMENT_MODE`:

| Mode | Behavior |
|------|----------|
| `hybrid` (default) | Poll first (up to `TGT_POLL_MAX_ATTEMPTS` × `TGT_POLL_INTERVAL_SECONDS`s), then await callback |
| `polling` | Poll only, no callback expected |
| `callback` | Skip polling entirely, wait for TGT webhook |

### providerSku Format
TGT uses simple `productCode` strings. Example: `GLOBAL-1GB-7D`

### Key APIs
| Method | Purpose |
|--------|---------|
| `createOrder(payload)` | Place async order → returns `orderNo` |
| `queryOrders({ iccid })` | Find existing order (for top-up / renewal) |
| `tryResolveOrderCredentials(orderNo)` | Poll for `lpa`, `activationCode`, `iccid` |
| `createTopup(payload)` | Data top-up for C4 daily pack (synchronous) |
| `renewOrder(payload)` | Async renewal (M1/C2/F2 plans) |
| `getDataUsage(iccid)` | Live usage stats for usage page |

### Top-Up vs Renewal
- **C4 daily pack:** Synchronous top-up → `createTopup()` → returns `topupNumber` immediately
- **M1/C2/F2 plans:** Async renewal → `renewOrder()` → returns `orderNo` → poll/callback

### Idempotency
TGT accepts an `idempotencyKey` (UUID per delivery). On retries, the same key prevents duplicate orders.

### Callback Webhook
TGT POSTs to `POST /api/tgt/callback` when credentials are ready.
- Verified via HMAC-SHA256 (`TGT_CALLBACK_SECRET` or falls back to `TGT_SECRET`)
- Triggers `finalize-delivery` job immediately

### Catalog Sync
Endpoint: `listProducts()` → array of product objects
Stored fields: `productCode`, `productName`, `productType`, raw payload

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
