# Admin API Reference

**Base path:** `/admin/*`
**Auth:** `x-admin-key: <ADMIN_API_KEY>` header (or `?apiKey=` for SSE)
**Source:** `fulfillment-engine/src/api/admin.ts`

---

## Deliveries

### GET /admin/deliveries
List all deliveries (no shop-level filter — returns all).

**Query params:**
| Param | Default | Description |
|-------|---------|-------------|
| `status` | — | Filter: `pending\|provisioning\|vendor_ordered\|polling\|awaiting_callback\|delivered\|failed\|cancelled` |
| `limit` | 50 | Max 200 |
| `offset` | 0 | Pagination offset |

**Response:** `{ total, limit, offset, deliveries[] }` — all fields except `payloadEncrypted`

---

### GET /admin/deliveries/:id
Get single delivery. Decrypts `payloadEncrypted` and returns as `esimPayload`.

**Response:** `{ ...delivery, esimPayload: { lpa, activationCode, iccid, ... }, esimOrders[] }`

---

### POST /admin/deliveries/:id/retry
Re-enqueue a failed or stuck delivery.

**Response:** `{ ok: true, message }`

---

### POST /admin/deliveries/:id/resend-email
Resend the delivery email for an already-delivered eSIM.

**Response:** `{ ok: true, messageId }`

---

## SKU Mappings

### GET /admin/sku-mappings
List all mappings.

**Query params:** `provider`, `isActive`, `search`, `limit=100`, `offset=0`

**Response:** `{ total, mappings[] }` — each mapping includes linked `catalogEntry`

---

### POST /admin/sku-mappings
Create a single mapping.

**Body:**
```json
{
  "shopifySku": "EU-5GB-30D",
  "provider": "firoam",
  "providerSku": "120:826-0-?-1-G-D:14094",
  "packageType": "fixed",
  "daysCount": null,
  "providerConfig": {},
  "isActive": true
}
```
If `providerCatalogId` is given instead of `providerSku`, fields are auto-derived from the catalog entry.

---

### PUT /admin/sku-mappings/:id
Partial update a mapping.

---

### DELETE /admin/sku-mappings/:id
Soft-delete (sets `isActive=false`).

---

### DELETE /admin/sku-mappings
Delete all mappings. Optional `?provider=firoam` to scope.

---

## SKU Mapping Bulk Operations

### POST /admin/sku-mappings/bulk
Create multiple mappings in one request.

**Body:**
```json
{
  "mappings": [ { "shopifySku": "...", "provider": "firoam", "providerSku": "..." } ],
  "forceReplace": false
}
```
Partial success is possible — returns per-item results.

---

### PUT /admin/sku-mappings/reorder
Batch update priorities.

**Body:** `{ "skuMappings": [{ "id": "...", "priority": 1 }] }`

---

### POST /admin/sku-mappings/smart-pricing
Auto-reorder mappings by price (lowest price = highest priority). Skips `priorityLocked` entries.

**Query:** `?provider=firoam` (optional)

---

## AI Mapping

### POST /admin/sku-mappings/ai-map/jobs
Start an AI mapping job.

**Body:**
```json
{
  "provider": "firoam",
  "unmappedOnly": true
}
```

**Response:** `{ jobId: "..." }`

**Flow:**
1. Gets unmapped Shopify SKUs (or all if `unmappedOnly=false`)
2. Runs pgvector similarity search → top candidates per SKU
3. Sends batches to GPT-4o-mini for proposed matches
4. Stores drafts in `AiMapJob.draftsJson`

---

### GET /admin/sku-mappings/ai-map/stream
**SSE endpoint.** Streams AI job progress in real-time.

**Query:** `?jobId=<id>&apiKey=<key>`

**Events:** `draft` (proposed mapping found), `done`, `error`

---

### GET /admin/sku-mappings/ai-map/jobs
List all AI jobs. **Query:** `limit`, `offset`

---

### GET /admin/sku-mappings/ai-map/jobs/:id
Get job details including all drafts and unmatched SKUs.

---

### DELETE /admin/sku-mappings/ai-map/jobs/:id
Delete an AI job record.

---

## Shopify SKUs

### GET /admin/shopify-skus
List Shopify variants from DB cache.

**Query params:** `sku`, `status` (`all|mapped|unmapped`), `provider`, `search`, `limit`, `offset`

**Response:** `{ skus[], total }`

---

### POST /admin/shopify-skus/sync
Fetch all variants from Shopify and upsert into `ShopifyVariant` table.

**Response:** `{ synced: 7266 }`

---

### POST /admin/shopify-skus/bulk-delete
Delete variants from Shopify AND remove from `ShopifyVariant` DB cache.

**Body:** `{ "skus": ["gid://shopify/ProductVariant/123"] }`

---

## Provider Catalog

### GET /admin/provider-catalog
List catalog entries.

**Query:** `provider`, `search`, `parsed` (`true|false`), `limit`, `offset`

**Response:** `{ total, entries[] }`

---

### POST /admin/provider-catalog/sync
Sync vendor catalogs. Calls vendor list APIs and upserts into `ProviderSkuCatalog`.

**Body:** `{ "providers": ["firoam", "tgt"] }` (omit for all)

After sync, auto-generates embeddings for new entries.

---

### POST /admin/provider-catalog/parse-all
AI-parse all catalog entries to extract structured data (`regionCodes`, `dataMb`, `validityDays`).

**Body:** `{ "provider": "firoam" }` (optional)

---

### POST /admin/provider-catalog/embed-backfill
Generate missing embeddings for catalog entries that don't have them.

**Response:** `{ backfilled: N }`

---

## Structured Matching

### POST /admin/sku-mappings/structured-map/jobs
Run deterministic structured matching (no AI). Parses Shopify SKU metadata and matches against catalog parsed data.

**Body:** `{ "provider": "firoam", "unmappedOnly": true }`

**Response:** `{ jobId, drafts[], unmatched[] }`

---

## Providers

### GET /admin/providers
List registered vendors.

**Response:** `{ providers: ["firoam", "tgt"] }`

---

## Regions

Canonical groupings of countries used by region-type Shopify product templates. The `code` is referenced in regional Shopify SKUs (`REGION-<code>-...`); `countryCodes` is the strict canonical coverage advertised to customers. See [`docs/database.md`](database.md#region) for schema.

### GET /admin/regions

List regions.

**Query params:**
| Param | Description |
|-------|-------------|
| `active` | `true` or `false` — filter by `isActive` |
| `parentCode` | Filter by parent group (e.g. `EU`, `ASIA`); uppercase normalized |

**Response:** `{ total, regions[] }` — each region includes `templateCount`.

---

### GET /admin/regions/:code

Get a single region by code (case-insensitive on input).

**Response:** Region object, or `404` if not found.

---

### POST /admin/regions

Create a region.

**Body:**
```json
{
  "code": "EU30",
  "parentCode": "EU",
  "name": "Europe (30 countries)",
  "description": "EEA + UK + CH",
  "countryCodes": ["DE", "FR", "AT", "..."],
  "isActive": true,
  "sortOrder": 0
}
```

Validation:
- `code`: uppercase A–Z / 0–9 / `-`, length 2–32 (auto-uppercased)
- `parentCode`: uppercase A–Z / 0–9, length 2–16 (auto-uppercased)
- `name`: non-empty string
- `countryCodes`: non-empty array of ISO 3166-1 alpha-2 codes (auto-uppercased + deduped); each must be exactly 2 letters
- `isActive`, `sortOrder`: optional (defaults `true`, `0`)

**Response:** `201` + region object, or `400` for validation errors, or `409` if `code` already exists.

---

### PATCH /admin/regions/:code

Partial update. Region `code` is immutable (it's referenced by SKUs). Other fields accept the same validation as POST.

**Response:** Updated region, or `400` for validation errors / no fields, or `404` if not found.

---

### DELETE /admin/regions/:code

Hard-delete a region. Templates referencing it (via `regionCode`) are not cascaded — their `regionCode` is set to `NULL` (orphaned), so the admin can reassign or delete them.

**Response:** `{ ok: true, deleted: "EU30" }`, or `404` if not found.
