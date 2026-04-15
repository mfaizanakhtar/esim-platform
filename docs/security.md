# Security

## Credential Encryption

All eSIM credentials are encrypted before being stored in the database.

**Algorithm:** AES-256-GCM
**Key:** `ENCRYPTION_KEY` env var (32 bytes, hex-encoded)
**Source:** `fulfillment-engine/src/utils/crypto.ts`

**What's encrypted:**
- `EsimDelivery.payloadEncrypted` → `{ vendorId, lpa, activationCode, iccid }`
- `EsimOrder.payloadEncrypted` → TGT order payload

**ICCID lookup without decryption:**
- `iccidHash = HMAC-SHA256(iccid, ENCRYPTION_KEY)` stored as indexed field
- Usage page searches by `iccidHash` → O(1) lookup, no full table scan, no decryption needed for lookup

---

## Webhook Signature Verification

**Shopify webhooks:**
- Header: `X-Shopify-Hmac-Sha256`
- Key: `SHOPIFY_CLIENT_SECRET`
- Algorithm: HMAC-SHA256 over raw request body
- Source: `fulfillment-engine/src/shopify/webhooks.ts`

**TGT callback webhook:**
- Key: `TGT_CALLBACK_SECRET` (falls back to `TGT_SECRET`)
- Same HMAC-SHA256 approach

**Important:** Always verify against the raw request body (before any JSON parsing). Fastify's `rawBody` plugin is used for this.

---

## Admin API Authentication

**Method:** API key in request header
**Header:** `x-admin-key: <ADMIN_API_KEY>`
**Fallback:** `?apiKey=<key>` query param (for SSE endpoints — browsers can't set headers on EventSource)
**Source:** `requireAdminKey()` helper in `fulfillment-engine/src/api/admin.ts`

**Development:** If `ADMIN_API_KEY` is not set, all admin routes are unprotected (no auth check). Never deploy without this set.

---

## Sensitive Data Rules

1. **Never log LPA, activation codes, or ICCIDs** — only log hashes or reference IDs
2. **Never return `payloadEncrypted` from admin API** — the list and detail endpoints strip this field; detail endpoint decrypts and returns `esimPayload` instead
3. **Never store email in ICCID lookup** — the usage page `?iccid=` flow doesn't pass email to avoid PII in shared links
4. **No shop-level data isolation** — single-tenant system; one `ADMIN_API_KEY` has access to all deliveries

---

## Network Security

- **CORS:** Dashboard URL allowed via `DASHBOARD_URL` env var; usage API has open CORS (public endpoint)
- **Rate limiting:** 100 requests per 15 minutes on admin routes
- **HTTPS only:** All traffic via Railway's TLS termination
