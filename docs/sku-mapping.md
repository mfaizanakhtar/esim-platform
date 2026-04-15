# SKU Mapping System

Maps Shopify product variant SKUs → vendor product codes. At provisioning time, the system looks up the mapping to determine which vendor and product to use.

**Source:** `fulfillment-engine/src/api/admin.ts`, `src/services/embeddingService.ts`

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

**Matching logic:**
1. Parse Shopify SKU → extract `{ regionCodes, dataMb, validityDays }`
2. Compare against catalog `parsedJson` fields
3. Best match per provider wins (ranked by `regionCodes` specificity)

No AI involved — fully deterministic. Good for well-structured SKU names.

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
2. Generate embeddings for each catalog entry (OpenAI `text-embedding-ada-002`, 1536 dims)
3. For each batch of Shopify SKUs: cosine similarity search → top 20 catalog candidates
4. Send candidates to GPT-4o-mini with structured output schema
5. GPT proposes match with confidence
6. Drafts streamed via SSE as they're produced
7. User reviews drafts in dashboard → approves → bulk create

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
