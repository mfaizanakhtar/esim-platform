# TGT Technology eSIM API Integration

> **Document Type**: Integration  
> **Status**: ✅ Current  
> **Last Updated**: 2026-03-08  
> **Purpose**: TGT Technology vendor API client implementation

---

## Overview

Complete integration with TGT Technology's eSIM provisioning API for ordering and managing eSIM cards.
TGT is a second vendor alongside FiRoam; both implement the same `VendorProvider` interface so they
are interchangeable from the worker/job layer perspective.

**Key differences from FiRoam:**

| Aspect | TGT | FiRoam |
|--------|-----|--------|
| Auth | OAuth2 Bearer token (24-hour TTL) | Session token via GET login |
| Request format | `application/json` | `application/x-www-form-urlencoded` |
| Signature | Callback verification only | Every request |
| Fulfillment | Async callback + optional polling | Synchronous response |
| Sandbox | ✅ Provided | ❌ Not available |
| Cancellation | ❌ Not supported | ✅ `cancelOrder()` available |

---

## ⚠️ Critical API Requirements

### HTTP Method & Content Type

All API calls (except OAuth) use **POST** with `application/json; charset=UTF-8`.

```
POST https://enterpriseapi.tugegroup.com:8070/openapi/<path>
Authorization: Bearer <accessToken>
Content-Type: application/json; charset=UTF-8
```

OAuth token endpoint:
```
POST /oauth/token
{ "accountId": "...", "secret": "..." }
```

### Signature Algorithm — Callback Verification Only

TGT signatures appear **only on incoming callbacks** (webhooks from TGT → our server).
Our outgoing API calls do **not** require a signature; they rely on the Bearer token.

Signature generation steps (used to verify callbacks):

1. Take the full callback payload **excluding** the `sign` field
2. Recursively flatten all nested fields using dot-notation keys  
   e.g. `data.orderInfo.orderNo` → `"data.orderInfo.orderNoxxx"`
3. Skip: `sign` field, `null`/`undefined` values, empty strings
4. Sort all `keyvalue` pairs alphabetically (ASCII order)
5. Concatenate all pairs with **no separator**
6. Wrap with secret: `secret + concatenated + secret`
7. MD5 hash the result (lowercase hex)

```typescript
// Implemented in src/vendor/tgtClient.ts
export function flattenParams(value: unknown, parentKey = '', out: string[] = []): string[] {
  // recursively flattens nested objects using dot-notation keys
  // skips: sign key, null/undefined, empty strings
  // arrays use index: data.orderInfo.0.orderNo
}

export function createTgtSignature(payload: unknown, secret: string): string {
  const pairs = flattenParams(payload); // excludes sign field
  pairs.sort();                          // ASCII sort
  const signSource = `${secret}${pairs.join('')}${secret}`;
  return crypto.createHash('md5').update(signSource, 'utf8').digest('hex');
}

// Verify an incoming callback:
TgtClient.verifyCallbackSignature(payloadWithoutSign, receivedSign, secret);
```

**Example** (from TGT docs):  
Parameters `foo:1, bar:2, foo_bar:3, sign:xxx`  
→ Filter: `bar:2, foo:1, foo_bar:3`  
→ Sort: `bar2, foo1, foo_bar3`  
→ Concat: `bar2foo1foo_bar3`  
→ Sign: `MD5(secret + "bar2foo1foo_bar3" + secret)`

---

## Authentication

TGT uses OAuth2 with a short-lived Bearer token.

### Token Flow

```
POST /oauth/token
{ accountId, secret }
→ { code: "0000", data: { accessToken, expires: 86400 } }
```

- Token is valid for **24 hours** (86400 seconds)
- `TgtClient` caches the token in memory and refreshes automatically
- Refresh triggers **5 minutes before expiry** (buffer to avoid mid-request expiry)
- If API returns code `2003` (token invalid) or `2004` (token unknown) → auto-retry with fresh token

```typescript
// Token auto-management is internal to TgtClient — callers never call authIfNeeded()
// Simply call any method and auth is handled transparently:
const client = new TgtClient();
const { products } = await client.listProducts({ pageNum: 1, pageSize: 100 });
```

### Environment Variables

```bash
TGT_BASE_URL=https://enterpriseapi.tugegroup.com:8070/openapi  # default; sandbox below
TGT_ACCOUNT_ID=your-account-id
TGT_SECRET=your-api-secret
TGT_ENABLED=true
TGT_FULFILLMENT_MODE=hybrid        # polling | callback | hybrid (default)
TGT_POLL_INTERVAL_SECONDS=15       # default 15s between poll attempts
TGT_POLL_MAX_ATTEMPTS=8            # default 8 attempts before fallback
TGT_CALLBACK_SECRET=               # override; falls back to TGT_SECRET if absent

# Sandbox base URL (for testing):
# TGT_BASE_URL=https://enterpriseapisandbox.tugegroup.com:8070/openapi
```

---

## eSIM Ordering Flow

### 1. Product Discovery

```typescript
const result = await client.listProducts({
  pageNum: 1,
  pageSize: 100,
  lang: 'en',
  productType: 'DATA_PACK',  // optional: DATA_PACK | DAILY_PACK
  cardType: 'M1',            // optional filter by card type
});
// result.products: TgtProduct[]
// result.total: number
```

**`TgtProduct`** fields used for SKU matching:

| Field | Example | Description |
|-------|---------|-------------|
| `productCode` | `A-002-ES-AU-T-30D/180D-3GB(A)` | **Required for ordering** |
| `productName` | `Israel 3GB/30 Days (M1)` | Display name |
| `netPrice` | `1.10` | Wholesale price (USD) |
| `productType` | `DATA_PACK` / `DAILY_PACK` | Plan type |
| `usagePeriod` | `30` | Active days after activation |
| `validityPeriod` | `180` | Days the QR remains valid before activation |
| `dataTotal` | `3` | Data amount (`null` = unlimited) |
| `dataUnit` | `GB` | Unit |
| `activeType` | `AUTO_ACTIVATE` / `ACTIVATE_ON_ORDER` | When activation starts |
| `cardType` | `M1` / `C4` / `F2` | Carrier card type |
| `countryCodeList` | `["IL"]` | ISO 3166 country codes covered |

### 2. Order Placement

```typescript
const { orderNo } = await client.createOrder({
  productCode: 'A-002-ES-AU-T-30D/180D-3GB(A)', // from listProducts
  channelOrderNo: 'delivery-id-123',              // max 100 chars; use deliveryId
  idempotencyKey: crypto.randomUUID(),            // UUID v4; reuse on retry
  email: 'customer@example.com',                  // optional: TGT sends QR to customer
  startDate: '2026-04-01',                        // optional: ACTIVATE_ON_ORDER only
});
// Returns: { raw, orderNo: "SE2026..." }
```

**Important**: The `idempotencyKey` is critical for retries. If a request times out, reuse the
**exact same** `idempotencyKey` — TGT will return the existing order rather than creating a duplicate.

**`activeType` behaviour:**
- `AUTO_ACTIVATE`: omit `startDate`; timer starts when customer installs eSIM
- `ACTIVATE_ON_ORDER`: provide `startDate` in `YYYY-MM-DD` format (UTC+0, must be ≥ now)

### 3. Credential Resolution

After `createOrder`, TGT processes asynchronously. Credentials (LPA QR code + ICCID) arrive either via:
- **Callback** (webhook from TGT → `POST /tgt/callback`)
- **Polling** (our job calls `queryOrders` until `qrCode` is populated)
- **Hybrid** (poll first, fall back to await callback if polls exhaust)

```typescript
// Check if an order has credentials yet:
const resolved = await client.tryResolveOrderCredentials(orderNo);
if (resolved.ready) {
  const { lpa, activationCode, iccid } = resolved;
  // lpa format: "LPA:1$server.toprsp.com$ACTIVATION_CODE"
}
```

The LPA string has 3 `$`-separated parts:
```
LPA:1 $ <RSP server address> $ <activation code>
```

### 4. Query Orders

```typescript
const { orders } = await client.queryOrders({
  orderNo: 'SE2026...',       // by TGT order number
  // OR iccid: '8999...'      // by ICCID
  // OR channelOrderNo: '...' // by our order number
  lang: 'en',
});
```

`TgtOrderInfo` key fields:

| Field | Description |
|-------|-------------|
| `orderNo` | TGT system order number |
| `qrCode` | LPA string (populated after provisioning) |
| `orderStatus` | `NOTACTIVE` / `ACTIVATED` / `INUSE` / `USED` / `EXPIRED` |
| `profileStatus` | `nodownload` / `downloaded` / `activated` |
| `cardInfo.iccid` | ICCID (also at `order.iccid` for some card types) |

### 5. Usage Query

```typescript
const { usage } = await client.getUsage(orderNo);
// usage.dataTotal, usage.dataUsage, usage.dataResidual (in MB)
```

---

## Fulfillment Modes

TGT's asynchronous nature requires a strategy decision per deployment. The mode is controlled by
`TGT_FULFILLMENT_MODE` env var.

### Mode: `callback` (Pure Async)

```
createOrder() → return { pending: true }
                            ↓ (minutes later)
               TGT calls POST /tgt/callback
               tgtCallback.ts → finalizeDelivery()
```

- Best latency: credentials arrive as soon as TGT is ready
- Requires public callback URL configured in TGT portal
- If callback never arrives: delivery stays `awaiting_callback`

### Mode: `polling` (Blocking Poll)

```
createOrder() → poll queryOrders() every N seconds × M attempts
               → credentials found → finalizeDelivery()
               → exhausted → status: 'failed'
```

- Worker job blocks until credentials arrive or fail
- Does not require callback URL
- Use in sandbox/testing where callbacks are unavailable

### Mode: `hybrid` (Default — Recommended)

```
createOrder() → queue tgt-poll-order job
               → poll up to maxAttempts
               → credentials found → finalizeDelivery()
               → exhausted → status: 'awaiting_callback' (wait for webhook)
```

- Fastest typical delivery (polling catches most orders within seconds)
- Callback catches edge cases where provisioning is delayed
- Never fails permanently from polling exhaustion alone

### Mode Configuration

```typescript
// src/vendor/tgtConfig.ts
getTgtFulfillmentMode()       // 'polling' | 'callback' | 'hybrid'
getTgtPollIntervalSeconds()   // default: 15
getTgtPollMaxAttempts()       // default: 8
getTgtCallbackSecret()        // TGT_CALLBACK_SECRET || TGT_SECRET
isTgtEnabled()                // TGT_ENABLED === 'true'
```

---

## API Endpoints Implemented

| Method | Endpoint | HTTP | Purpose |
|--------|----------|------|---------|
| `authIfNeeded()` | `/oauth/token` | POST | Get/refresh Bearer token |
| `listProducts(params)` | `/eSIMApi/v2/products/list` | POST | Paginated product catalogue |
| `createOrder(params)` | `/eSIMApi/v2/order/create` | POST | Place eSIM order |
| `queryOrders(params)` | `/eSIMApi/v2/order/orders` | POST | Filter orders by orderNo/iccid/channelOrderNo |
| `getUsage(orderNo)` | `/eSIMApi/v2/order/usage` | POST | Real-time data usage |
| `tryResolveOrderCredentials(orderNo)` | (wraps queryOrders) | — | Poll until LPA is available |

**Endpoints in TGT docs but not yet implemented:**

- `/eSIMApi/v2/products/detail` — single product lookup by productCode
- `/eSIMApi/v2/order/renew` — renewal (extend existing eSIM)
- `/eSIMApi/v2/order/list` — paginated order listing
- `/eSIMApi/v2/account/balance` — check account balance
- `/eSIMApi/v2/iccid/profile` — profile/install status by ICCID
- `/eSIMApi/v2/order/terminate` — terminate C4-type orders
- `/eSIMApi/v2/order/topup/create` — data top-up (C4 daily plans)

---

## Callback Handler

**Route**: `POST /tgt/callback`  
**File**: `src/api/tgtCallback.ts`

Flow:
1. Parse body against `TgtCallbackSchema` (Zod)
2. Verify HMAC signature using `TgtClient.verifyCallbackSignature()`
3. Find delivery by `vendorReferenceId = orderNo`
4. If `qrCode` starts with `LPA:` → call `finalizeDelivery()`
5. Always return `{ code: "0000", msg: "success" }` (even on business errors)

**Critical**: TGT retries callbacks every 5 seconds for up to 2 hours if we don't return `0000`.
Always return success even if the delivery is already finalized (idempotency is handled inside
`finalizeDelivery()` via a first-wins DB write).

```typescript
// Response TGT always expects:
return reply.send({ code: '0000', msg: 'success' });
```

**Callback supports multiple eventTypes:**

| `eventType` | Description |
|-------------|-------------|
| `1` | Card issuance notification (standard eSIM) |
| `2` | Renewal notification |
| `3` | Push mode (SMS-push US cards) |

`orderInfo` is a **single object** for eventType 1/3, and a **JSON array** for eventType 2 (renewal).
The callback handler normalises both cases.

---

## Polling Job

**Job name**: `tgt-poll-order`  
**File**: `src/worker/jobs/tgtPoll.ts`  
**Handler**: `handleTgtPoll(data: TgtPollJobData)`

The polling job is enqueued by `TgtProvider.provision()` in `callback` or `hybrid` mode.

```typescript
interface TgtPollJobData {
  deliveryId: string;
  orderNo: string;
  attempt: number;    // starts at 1
  maxAttempts: number;
  mode: 'hybrid' | 'polling';
}
```

State machine:

```
credentials ready?
  → yes: finalizeDelivery() → reason: 'resolved'
  → no + attempt < maxAttempts: requeue with attempt+1 → reason: 'requeued'
  → no + attempt >= maxAttempts + mode=polling: status='failed' → reason: 'poll_exhausted'
  → no + attempt >= maxAttempts + mode=hybrid: status='awaiting_callback' → reason: 'poll_exhausted'
```

---

## Provider Interface

**File**: `src/vendor/providers/tgt.ts`  
**Class**: `TgtProvider implements VendorProvider`

The provider bridges the generic `VendorProvider` contract used by the worker layer to the TGT-specific
`TgtClient`:

```typescript
const provider = new TgtProvider();
const result = await provider.provision(config, ctx);
// config.providerSku = productCode (e.g. 'A-002-ES-AU-T-30D/180D-3GB(A)')
// config.providerConfig.startDate = optional start date
// ctx.deliveryId → used as channelOrderNo (max 100 chars, sliced)
// ctx.customerEmail → forwarded to TGT for direct QR email
```

Return shapes:
- **Callback/Hybrid mode**: `{ vendorOrderId, lpa: '', pending: true }` — polling job handles rest
- **Polling mode** (sync): returns full `{ vendorOrderId, lpa, activationCode, iccid }` only when ready;
  throws `VendorError` if maxAttempts exhausted

---

## Data Persistence

TGT orders follow the same `EsimDelivery` table flow as FiRoam:

| Field | Value |
|-------|-------|
| `vendorReferenceId` | TGT `orderNo` (e.g. `SE2026...`) |
| `payloadEncrypted` | AES-encrypted JSON `{ vendorId, lpa, activationCode, iccid }` |
| `status` | `pending` → `polling` / `awaiting_callback` → `delivered` / `failed` |

Sensitive fields (LPA, activation code, ICCID) are **always AES-encrypted at rest** via `src/utils/crypto.ts`.

---

## Testing

### Unit Tests

Fast mocked tests, no credentials required:

```bash
npm test
```

**Available unit tests:**

| File | What it covers |
|------|----------------|
| `src/vendor/__tests__/tgtConfig.test.ts` | Config parsing, defaults, fallbacks |
| `src/vendor/providers/__tests__/tgt.provider.test.ts` | Provider in callback/polling/hybrid modes |
| `src/worker/jobs/__tests__/tgtPoll.test.ts` | Poll handler state machine (6 scenarios) |

### Integration Tests (Live API)

Real API calls against TGT. Requires credentials and explicit opt-in flags.

```bash
# Authenticate + list products only (safe, no orders placed)
TGT_INTEGRATION=true \
TGT_ACCOUNT_ID=your-account-id \
TGT_SECRET=your-secret \
npx vitest run src/tests/tgt.integration.test.ts -t "should authenticate and fetch products"

# Full e2e: place real order + poll + generate QR + HTML/Markdown report
TGT_INTEGRATION=true \
TGT_E2E_ORDERS=true \
TGT_ACCOUNT_ID=your-account-id \
TGT_SECRET=your-secret \
TGT_TEST_EMAIL=you@example.com \
npx vitest run src/tests/tgt.integration.test.ts
```

**Test outputs** (written to `test-output/`):

- `tgt-esim-qr.png` — scannable QR code for the provisioned eSIM
- `tgt-test-result.html` — full HTML report with embedded QR, order details, install instructions
- `tgt-test-result.md` — markdown version

**Sandbox vs Production:**  
Use `TGT_BASE_URL=https://enterpriseapisandbox.tugegroup.com:8070/openapi` for integration tests
to avoid real charges. Sandbox products are test-only and cannot be activated on real devices.

**Note**: Unlike FiRoam, TGT provides a proper sandbox environment — always use it for integration tests.

### Verified Working (as of 2026-03-08)

- ✅ OAuth2 token acquisition and auto-refresh
- ✅ Token retry on `2003`/`2004` error codes
- ✅ `listProducts` with filtering
- ✅ `createOrder` with idempotencyKey
- ✅ `queryOrders` credential polling
- ✅ `tryResolveOrderCredentials` LPA extraction
- ✅ `getUsage` (for supported card types)
- ✅ Callback signature verification (HMAC MD5)
- ✅ Hybrid mode polling → `awaiting_callback` fallback
- ✅ QR code generation from LPA string

---

## Zod Schemas

All API responses are validated via Zod schemas in `src/vendor/tgtSchemas.ts`:

| Schema | Purpose |
|--------|---------|
| `TgtTokenResponseSchema` | OAuth token response |
| `TgtProductSchema` / `TgtProductsListResponseSchema` | Product catalogue |
| `TgtCreateOrderResponseSchema` | Order creation response |
| `TgtQueryOrdersResponseSchema` / `TgtOrderInfoSchema` | Order query response |
| `TgtUsageResponseSchema` | Usage data |
| `TgtCallbackSchema` | Incoming callback payload (with signature) |
| `TgtCallbackDataSchema` / `TgtCallbackOrderInfoSchema` | Callback payload inner types |

---

## Common Pitfalls

1. **Never check credentials inside the webhook handler** — handler must respond within 10 seconds;
   delegate to `finalizeDelivery()` which handles the DB write and email asynchronously
2. **Always return `{ code: "0000", msg: "success" }` from callback** — even on business errors;
   TGT will retry for 2 hours if you return anything else
3. **`idempotencyKey` must be unique per new order, identical on retry** — reuse the same UUID when
   retrying after a timeout; TGT returns the existing order, not a duplicate
4. **`channelOrderNo` max 100 characters** — `deliveryId` (UUID = 36 chars) is always safe
5. **`startDate` required for `ACTIVATE_ON_ORDER` products** — check `activeType` from `listProducts`
6. **No cancellation API** — unlike FiRoam, TGT has no cancel/refund endpoint for standard eSIMs;
   only C4-type cards support `terminate` (not yet implemented)
7. **ICCID location varies by card type** — check both `order.cardInfo?.iccid` and `order.iccid`;
   `tryResolveOrderCredentials()` handles this automatically
8. **`orderInfo` in callbacks can be object or array** — eventType 1/3 sends an object,
   eventType 2 (renewal) sends an array; handler normalises both
9. **Sandbox credentials are separate** — sandbox `accountId`/`secret` differ from production;
   switch both `TGT_BASE_URL` and credentials together
10. **Token lives in-process** — each worker restart requires a fresh token; the auto-auth logic
    handles this but means the first request after a restart has ~200ms auth overhead

---

## Vendor Documentation Reference

Full TGT API documentation: `thirdparty-documentation/TGT.txt` (3349 lines)

Key sections in vendor doc:
- Pages 1–7: Overview, quick start, API modes
- Pages 9–11: Authentication (OAuth token + refresh)
- Pages 11–16: Product catalogue API
- Pages 22–25: Create Order (Standard eSIM)
- Pages 35–43: Query Order endpoints
- Pages 60–73: Webhook callback format and signature algorithm
- Pages 73–75: Error code reference
- Pages 76–88: Appendix (product list, country/MCC codes)
