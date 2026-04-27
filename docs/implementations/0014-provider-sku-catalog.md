# Provider SKU catalog (vendor product cache + embeddings)

**ID:** 0014 · **Status:** shipped · **Owner:** backfill
**Shipped:** pre-log · **PRs:** pre-log

## What it does

`ProviderSkuCatalog` is the local cache of every vendor product we can sell. FiRoam catalog rows are ingested from `FiRoamClient.getPackages` (admin endpoint + script), TGT rows from `tgtClient.listProducts`. Each row is upserted on `(provider, skuId, productCode)`. After every sync, two fire-and-forget background tasks run: (1) `embeddingService` computes a pgvector embedding of the product description for AI matching, (2) GPT-4o-mini parses the row into a structured `parsedJson` (`dataMb`, `validityDays`, `regionCodes`, etc.) used by structured matching. Rows that disappear from the vendor API are soft-deactivated (`isActive=false`), never hard-deleted.

## Why

We need a cached, queryable copy of every vendor product to (a) drive structured + AI mapping without round-tripping every search to the vendor, (b) stay sortable/filterable in the dashboard, (c) survive vendor API outages. The catalog is the source of truth for `providerCatalogId` references on `ProviderSkuMapping` rows; renaming or removing a catalog row leaks into every mapping that links to it.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/prisma/schema.prisma` (`ProviderSkuCatalog`) | Schema, including the pgvector `embedding` column (raw migration only) |
| `fulfillment-engine/src/services/embeddingService.ts` | OpenAI embedding compute, advisory-lock backfill, parsedJson generation |
| `fulfillment-engine/src/api/admin.ts` (provider-catalog routes) | Sync endpoints (`/admin/provider-catalog/sync/*`), parse-all, deactivation logic |
| `fulfillment-engine/scripts/fetch-firoam-skus.ts` | One-shot CLI for FiRoam catalog ingest |

## Touchpoints

- DB: `ProviderSkuCatalog` (and the raw-migration `embedding` column not in `schema.prisma`)
- AI/AI mapping: `embeddingService.embed`, `parseCatalogEntry`
- Admin API + dashboard `Catalog.tsx` page
- Foreign-key dependency from `ProviderSkuMapping.providerCatalogId`

## Data model

- `ProviderSkuCatalog` columns include `provider`, `skuId`, `productCode`, `productName`, `parsedJson` (JSONB), `rawPayload` (JSONB), `countryCodes` (JSONB array), `isActive`, `lastSyncedAt`, plus the raw-SQL `embedding vector(1536)` column.
- Unique constraint: `(provider, skuId, productCode)`.

## Gotchas / non-obvious decisions

- **`embedding` is a pgvector column NOT in `schema.prisma`.** Prisma can't represent vector types; the column is added by raw migration and read/written via raw SQL (`<=>` cosine operator, `::vector` casts). Don't try `catalogEntry.embedding` — it's `undefined`.
- **FiRoam vs TGT have asymmetric upsert keys.** FiRoam rows store the integer `skuId`; TGT rows use `skuId = ''` because TGT has no SKU tier, only `productCode`. The unique key shape is the same but the *semantics* differ — don't pattern-match TGT ingest against FiRoam.
- **`countryCodes` shape differs by provider.** FiRoam stores **display names** (`["Germany", "France"]`); TGT stores **ISO codes** (`["DE", "FR"]`). Code that iterates this column must normalise via `firoamNameToCode` first.
- **`region` is sometimes null.** FiRoam sets `region = sku.countryCode` (2-letter ISO); TGT sets `region = null` and puts coverage in `countryCodes`. Structured matching handles both, but raw queries that assume `region IS NOT NULL` miss every TGT row.
- **Embedding compute runs fire-and-forget.** Sync returns 200 before embeddings exist. A session-level Postgres advisory lock (`0xeb4c`) prevents concurrent backfills. Killing a backfill mid-run leaves the lock held until the connection drops — operators shouldn't restart in tight loops.
- **Embedding + `parsedJson` are NOT atomic.** Either can succeed without the other. AI mapping needs `embedding`; structured matching needs `parsedJson`. A row may be findable by one path and invisible to the other.
- **Vendor packages with empty `packageData` silently skip.** No row is created, no error surfaces. The sync report counts these but doesn't list them — operators who don't see their new product must dig into `FiRoamClient.getPackages` directly.
- **Deactivation is sync-relative, not API-relative.** Rows where `lastSyncedAt < syncStartedAt` get `isActive=false`. So "is this product gone forever?" requires a *successful* sync — partial syncs can falsely deactivate live rows. Don't write logic that treats `isActive=false` as authoritative without checking the latest `lastSyncedAt`.
- **`rawPayload` is provider-shaped.** For FiRoam, it includes denormalised SKU metadata (`skuId`, `priceid`, `skuCountryCodes`) used at mapping-create time to derive the three-part `providerSku`. TGT's `rawPayload` is just the bare API response. Provider-aware code reads.
- **`parsedJson` parse uses GPT-4o-mini in batches of 20.** OpenAI quota errors mid-batch leave later rows unparsed; only `POST /admin/provider-catalog/parse-all` retries. There's no automatic backoff loop.

## Related docs

- `docs/sku-mapping.md` — catalog surface, sync endpoints
- `docs/database.md` — `ProviderSkuCatalog` fields
- `docs/vendors.md` — what each vendor's catalog response looks like
- `docs/env-vars.md` — `OPENAI_API_KEY`

## Future work / known gaps

- Hard-deleting deactivated rows older than N months would reclaim DB space, but isn't urgent.
- A "diff vs last sync" view in the dashboard would surface silent skips and renames; not built.
