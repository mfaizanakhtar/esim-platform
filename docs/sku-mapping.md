# SKU Mapping System

Maps Shopify product variant SKUs → vendor product codes. At provisioning time, the system looks up the mapping to determine which vendor and product to use.

**Source:** `fulfillment-engine/src/api/admin.ts`, `src/services/embeddingService.ts`

---

## Shopify SKU Format

Two stable formats coexist depending on `ShopifyProductTemplate.templateType`:

| Template | SKU pattern | Examples |
|----------|-------------|----------|
| COUNTRY | `<CC>-<volume>-<days>D-<TYPE>` | `DE-5GB-30D-FIXED`, `JP-1GB-1D-DAYPASS` |
| REGION  | `REGION-<regionCode>-<volume>-<days>D-<TYPE>` | `REGION-EU30-5GB-30D-FIXED`, `REGION-ASIA4-1GB-7D-FIXED`, `REGION-GCC6-2GB-1D-DAYPASS` |

`<TYPE>` is `FIXED` (total-data plan) or `DAYPASS` (per-day plan). The region code is **stable** — country membership lives in `Region.countryCodes` and can change without renaming SKUs.

For region SKUs, the matching layer (Phase 5) MUST apply strict-coverage filtering: a provider catalog row is only eligible if its `countryCodes` is a superset of `Region.countryCodes` for the SKU's region code.

---

## How Mapping Works at Provisioning

1. Webhook receives Shopify line item with a `sku` string
2. Query `ProviderSkuMapping WHERE shopifySku = sku AND isActive = true ORDER BY priority`
3. Try each mapping in order until one succeeds
4. Pass `providerSku` + `providerConfig` + `packageType` + `daysCount` to the selected vendor

**Priority:** Lower number = tried first. `1` is highest priority.

---

## Three Ways to Create Mappings

### 1. Manual

Create via dashboard UI or API:

```bash
POST /admin/sku-mappings
{
  "shopifySku": "EU-5GB-30D",
  "provider": "firoam",
  "providerSku": "120:826-0-1-1-G-D:14094",
  "packageType": "fixed"
}
```

### 2. Structured Matching (Deterministic)

Parses Shopify SKU metadata and matches against catalog's `parsedJson`.

```bash
POST /admin/sku-mappings/structured-map/jobs
{ "provider": "firoam", "unmappedOnly": true }
```

**Matching logic — branches by SKU `kind`:**

**COUNTRY SKUs** (`DE-5GB-30D-FIXED`, `EU-1GB-7D-DAYPASS`, etc.):
1. Parse → extract `{ regionCode, dataMb, validityDays, skuType }`
2. Filter catalog by `parsedJson.regionCodes ? regionCode` (JSONB)
3. Best match per provider wins (smaller `regionCodes` = more targeted)

**REGION SKUs** (`REGION-EU30-5GB-30D-FIXED`, `REGION-ASIA4-1GB-1D-DAYPASS`, etc.):
1. Parse → extract `{ regionCode, dataMb, validityDays, skuType, kind: 'REGION' }`
2. Look up `Region` row by `code`; fail (empty drafts) if missing or `countryCodes` is empty
3. **Strict-coverage filter:** `catalog.countryCodes @> region.countryCodes` (JSONB containment) — provider catalog must cover EVERY advertised country
4. Best match per provider wins (smaller `countryCodes` = tighter fit, less waste)

Both branches enforce the same data/validity match (with relax options) and the same DAYPASS/FIXED type-parity rule. No AI involved — fully deterministic.

### 3. AI Mapping (GPT-4o-mini + pgvector)

Best for ambiguous or non-standard SKU names.

```bash
# Start job
POST /admin/sku-mappings/ai-map/jobs
{ "provider": "firoam", "unmappedOnly": true }

# Stream real-time progress
GET /admin/sku-mappings/ai-map/stream?jobId=<id>&apiKey=<key>

# Approve drafts
POST /admin/sku-mappings/bulk
{ "mappings": [...drafts], "forceReplace": true }
```

**AI mapping flow:**
1. Fetch all unmapped Shopify SKUs + full catalog
2. Pre-fetch active `Region` rows once (powers the REGION post-filter — see below)
3. Generate embeddings for each catalog entry (OpenAI `text-embedding-ada-002`, 1536 dims)
4. For each batch of Shopify SKUs: cosine similarity search → top 20 catalog candidates
5. Send candidates to GPT-4o-mini with structured output schema
6. GPT proposes match with confidence
7. **Hard post-filter** (deterministic, runs after GPT regardless of its output):
   - Type-parity (DAYPASS SKU ↔ daypack catalog row)
   - Data and validity match (subject to `relaxOptions`)
   - **COUNTRY SKUs:** `entry.parsedJson.regionCodes` must include the SKU's regionCode
   - **REGION SKUs:** `entry.countryCodes ⊇ region.countryCodes` (strict-coverage; uses the pre-fetched Region map)
8. Drafts streamed via SSE as they're produced
9. User reviews drafts in dashboard → approves → bulk create

The post-filter is the safety net — even if GPT confidently proposes a sub-coverage REGION match, the strict-coverage rule rejects it deterministically.

---

## Catalog Management

The vendor catalog must be synced before AI mapping can work.

### Sync Catalog

```bash
POST /admin/provider-catalog/sync
{ "providers": ["firoam", "tgt"] }
```

Calls vendor list APIs and upserts into `ProviderSkuCatalog`. Auto-generates embeddings for new entries.

### Parse Catalog (AI)

Extracts structured data from raw vendor payloads:

```bash
POST /admin/provider-catalog/parse-all
{ "provider": "firoam" }
```

**Output format (`parsedJson`):**
```json
{
  "regionCodes": ["DEU", "FRA", "GBR"],
  "dataMb": 5120,
  "validityDays": 30
}
```

Used by structured matching and as context for AI matching.

### Backfill Embeddings

If embeddings are missing (e.g., after catalog sync without OpenAI key):

```bash
POST /admin/provider-catalog/embed-backfill
```

Available as a button in the dashboard Catalog page.

---

## Daypass Packages

Daypass mappings use `packageType: "daypass"` and `daysCount`.

**FiRoam:** `providerSku` apiCode contains `?` as placeholder:
```
providerSku: "120:826-0-?-1-G-D:14094"
daysCount: 7
```
At provisioning: `?` is replaced with `7` → `826-0-7-1-G-D`

**Type-parity rule:** Shopify SKU `productCode` must contain `?` to match as daypass. This prevents mismatches between fixed and daypass catalog entries.

**Validity display:** For daypass mappings the customer email's `Validity` line is derived from `daysCount` (formatted as `"N day"` / `"N days"`), not from the free-text `validity` column. This guarantees the displayed duration cannot drift from what was actually ordered at the vendor. The `validity` column may exist on a daypass row for legacy reasons but is ignored by the email path. Fixed-package mappings continue to use `validity` verbatim.

---

## Smart Pricing

Auto-reorder mappings by price (lowest cost = highest priority):

```bash
POST /admin/sku-mappings/smart-pricing?provider=firoam
```

Skips mappings with `priorityLocked=true`. Use `priorityLocked` to protect manually-set priorities.

---

## Locks

| Lock | Purpose |
|------|---------|
| `priorityLocked` | Protects mapping from smart-pricing reorder |
| `mappingLocked` | Requires explicit unlock before editing or deleting |
