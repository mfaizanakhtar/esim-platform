# Database Schema

**Engine:** PostgreSQL with pgvector extension
**ORM:** Prisma
**Source:** `fulfillment-engine/prisma/schema.prisma`

---

## EsimDelivery

Core record. One per Shopify line item. Tracks provisioning from start to finish.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (cuid) | Primary key |
| `shop` | String | Shopify store domain (e.g., `sailesim.myshopify.com`) |
| `orderId` | String | Shopify order ID |
| `orderName` | String | Human-readable order (e.g., `#1001`) |
| `lineItemId` | String | Shopify line item ID — part of idempotency key |
| `variantId` | String | Shopify product variant ID |
| `customerEmail` | String? | Delivery email address |
| `vendorReferenceId` | String? | Vendor's order reference |
| `provider` | String? | `firoam` or `tgt` |
| `iccidHash` | String? (indexed) | HMAC-SHA256(iccid, ENCRYPTION_KEY) — enables O(1) ICCID lookup |
| `payloadEncrypted` | String? | AES-256-GCM encrypted `{ vendorId, lpa, activationCode, iccid }` |
| `accessToken` | String? (unique) | UUID written to Shopify metafield; UI extension polls with this |
| `topupIccid` | String? | If top-up: existing ICCID to renew |
| `sku` | String? | Cached Shopify variant SKU |
| `status` | String | See status values below |
| `lastError` | String? | Last error message |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |

**Status values:** `pending` → `provisioning` → `vendor_ordered` → `polling` → `awaiting_callback` → `delivered` | `failed` | `cancelled`

**Idempotency key:** `(orderId, lineItemId)` — checked before creating a new delivery

---

## ProviderSkuMapping

Maps a Shopify SKU to a vendor product code. Multiple mappings per SKU (tried in priority order).

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (cuid) | Primary key |
| `shopifySku` | String | Shopify variant SKU string |
| `provider` | String | `firoam` or `tgt` |
| `providerSku` | String | Vendor product code (format varies by provider) |
| `providerConfig` | Json? | Extra vendor-specific config |
| `name` | String? | Friendly name |
| `region` | String? | e.g., `EU`, `Global` |
| `dataAmount` | String? | e.g., `5GB` |
| `validity` | String? | e.g., `30 days` |
| `isActive` | Boolean | Soft-delete flag |
| `priority` | Int | Lower = tried first. `1` is highest priority |
| `priorityLocked` | Boolean | Protects from smart-pricing reorder |
| `mappingLocked` | Boolean | Requires unlock to edit or delete |
| `packageType` | String | `fixed` or `daypass` |
| `daysCount` | Int? | Daypass packages only — number of days |
| `providerCatalogId` | String? | FK to `ProviderSkuCatalog` |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |

**Unique:** `(shopifySku, provider)` — one mapping per SKU per provider

---

## ProviderSkuCatalog

Synced vendor product catalog. Source of truth for AI mapping.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (cuid) | Primary key |
| `provider` | String | `firoam` or `tgt` |
| `productCode` | String | Vendor's canonical product code |
| `skuId` | String | FiRoam: `sku.skuid`; TGT: `""` |
| `skuName` | String? | FiRoam human-readable name |
| `productName` | String | Display name |
| `productType` | String? | |
| `region` | String? | Vendor's region label |
| `countryCodes` | Json? | Array of ISO country codes |
| `dataAmount` | String? | e.g., `5GB` |
| `validity` | String? | e.g., `30 days` |
| `netPrice` | Decimal? | Cost price |
| `currency` | String? | |
| `rawPayload` | Json? | Full raw vendor API response |
| `parsedJson` | Json? | `{ regionCodes: string[], dataMb: number, validityDays: number }` — extracted by AI parser |
| `isActive` | Boolean | |
| `lastSyncedAt` | DateTime | Last time this entry was synced from vendor |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |

**Vector column:** `embedding vector(1536)` — managed via raw SQL migration, not in Prisma schema. Used for cosine similarity search in AI mapping.

**Unique:** `(provider, skuId, productCode)`

---

## ShopifyVariant

Cache of Shopify product variants. Populated via `POST /admin/shopify-skus/sync`.

| Field | Type | Notes |
|-------|------|-------|
| `variantId` | String (unique) | Shopify GID: `gid://shopify/ProductVariant/123` |
| `sku` | String | Variant SKU string |
| `productTitle` | String? | Parent product name |
| `variantTitle` | String? | Variant option label |
| `price` | Decimal? | Listed price |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | Acts as `syncedAt` |

---

## AiMapJob

Tracks AI-powered SKU → catalog matching jobs.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (cuid) | Primary key |
| `status` | String | `running` → `done` \| `error` \| `interrupted` |
| `provider` | String? | Filter applied |
| `unmappedOnly` | Boolean | Whether only unmapped SKUs were processed |
| `totalBatches` | Int? | Total batches planned |
| `completedBatches` | Int | Batches finished |
| `foundSoFar` | Int | Draft matches found |
| `draftsJson` | Json | Array of proposed mappings |
| `unmatchedSkusJson` | Json | SKUs with no match found |
| `warning` | String? | |
| `error` | String? | |
| `createdAt` | DateTime | |
| `completedAt` | DateTime? | |

---

## DeliveryAttempt

Audit log of job executions for a delivery.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (cuid) | Primary key |
| `deliveryId` | String | FK to `EsimDelivery` |
| `channel` | String | `provision`, `email`, `fulfillment`, etc. |
| `result` | String? | Outcome or error message |
| `createdAt` | DateTime | |

---

## EsimOrder

TGT-specific async order record. Created when TGT order is placed; updated when credentials arrive.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (cuid) | Primary key |
| `deliveryId` | String? | FK to `EsimDelivery` |
| `vendorReferenceId` | String (unique) | TGT `orderNo` |
| `payloadJson` | Json? | TGT API response |
| `payloadEncrypted` | String? | Encrypted credentials |
| `status` | String | `created` → `fulfilled` \| `failed` |
| `lastError` | String? | |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |

---

## Migrations

Located in `fulfillment-engine/prisma/migrations/`. Run with:

```bash
cd fulfillment-engine && npm run prisma:migrate
```

Notable migrations:
- `20260401000001_add_catalog_embedding` — enables pgvector extension, adds `embedding vector(1536)` column and HNSW index on `ProviderSkuCatalog`
- `20260408000001_add_shopify_variant` — adds `ShopifyVariant` table
