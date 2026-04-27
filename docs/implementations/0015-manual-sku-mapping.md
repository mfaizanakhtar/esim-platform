# Manual SKU mapping (Shopify SKU → vendor SKU, priority, locks)

**ID:** 0015 · **Status:** shipped · **Owner:** backfill
**Shipped:** pre-log · **PRs:** pre-log

## What it does

`ProviderSkuMapping` rows tell the provisioning job how to translate a Shopify line-item SKU into a vendor call. Each row is `(shopifySku, provider, providerSku)` plus pricing metadata, with a `priority` integer used for failover ordering and three independent flags (`isActive`, `priorityLocked`, `mappingLocked`) controlling soft-delete, smart-pricing immunity, and UI-edit immunity. The dashboard `SkuMappings` page (and admin API) covers single CRUD, bulk upsert, reorder, and a "smart pricing" flow that re-prioritises rows by netPrice. Rows can optionally link to a `ProviderSkuCatalog` row via `providerCatalogId` to auto-derive metadata.

## Why

Different Shopify products map to different vendor packages, sometimes with multiple eligible vendors per SKU (FiRoam fast + TGT cheaper). Storing this as data — not code — lets operators add a new product or switch vendors without a deploy. Priority + failover gives us "try FiRoam first, fall back to TGT" without `if (provider === 'firoam')` branches anywhere in the worker.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/src/api/admin.ts` (sku-mappings routes) | Single CRUD, bulk upsert, reorder, smart-pricing endpoints |
| `fulfillment-engine/prisma/schema.prisma` (`ProviderSkuMapping`) | Schema with the three flag columns and `providerCatalogId` foreign key |
| `dashboard/src/pages/SkuMappings.tsx` | List + edit UI |
| `dashboard/src/hooks/useSkuMappings.ts`, `useSkuMappingMutations.ts` | Data layer for the page |

## Touchpoints

- Worker job: `provision-esim` reads `ProviderSkuMapping.findMany({ shopifySku, isActive: true }).orderBy({ priority: 'asc' })`
- DB: `ProviderSkuMapping` ↔ optional FK to `ProviderSkuCatalog`
- Smart pricing run (entry `0018-smart-pricing-engine`) writes `priority` for non-locked rows

## Data model

- Composite "natural key" is `(shopifySku, provider, providerSku)`; not enforced as a unique constraint, but the bulk endpoint dedupes against it.
- `priority` is per-`shopifySku` only — two different SKUs both having `priority=1` is normal.

## Gotchas / non-obvious decisions

- **`priority=1` is *highest*, not lowest.** Sort is `ASC`. Don't refactor to "higher number is higher priority" — every operator-facing UI assumes ascending = better.
- **Three flags, three different intents:** `isActive=false` is the soft-delete (DELETE endpoint sets this, never hard-deletes). `priorityLocked=true` shields from smart-pricing only. `mappingLocked=true` is a UI-level guard against accidental edits/deletes — *not enforced server-side*. Don't conflate.
- **Smart pricing respects `priorityLocked` but ignores `mappingLocked`.** If you want a row immune to smart-pricing reorder, set `priorityLocked`. `mappingLocked` alone is not enough.
- **Auto-priority on create increments the max, even with gaps.** Delete priority `2` of `[1,2,3]` → next create gets `4`, not `2`. Run `/sku-mappings/reorder` to re-pack into `[1,2,3]`. Don't block creates while gaps exist; the gap is fine for failover.
- **`providerSku` format is provider-specific and unvalidated by the API.** FiRoam needs three parts (`skuId:apiCode:priceId`); TGT is just the bare productCode. The DB accepts any string. Mistakes don't surface until the worker tries to provision; check vendor logs if a delivery silently fails on the first attempt.
- **`packageType=daypass` requires `daysCount` but the schema doesn't enforce it.** Forgetting `daysCount` causes the FiRoam adapter to fail with a cryptic error at provision time. Always set explicitly when creating a daypass mapping.
- **`packageType` auto-detection is heuristic.** The bulk-from-catalog endpoint sets `daypass` if `productCode.includes('?')` (FiRoam) OR `productType === 'DAILY_PACK'` (TGT). For any third indicator, you'll silently get `fixed`. Pass `packageType` explicitly when you know.
- **`providerCatalogId` link auto-derives metadata, but explicit fields override.** If you link a wrong catalog row, then manually correct `name`, then re-link to the right row, the manual `name` *persists* until you set it to empty/null. Re-linking does not re-pull all fields.
- **Search is case-insensitive substring on three fields.** Querying `120:826-0-1` matches every FiRoam row containing that string. There's no exact-match endpoint. Use the row ID for unambiguous lookups.
- **Bulk `forceReplace=false` is idempotent for existing rows but assigns priorities only to new ones.** Calling bulk three times in a row never reorders. To reorder after bulk, follow up with the reorder endpoint.

## Related docs

- `docs/sku-mapping.md` — workflow + endpoint surface
- `docs/api-admin.md` — sku-mapping endpoints
- `docs/database.md` — `ProviderSkuMapping` columns

## Future work / known gaps

- A unique-constraint on `(shopifySku, provider, providerSku)` would catch duplicates at insert time; today the bulk endpoint dedupes in app code but single creates can write a duplicate.
- `mappingLocked` should probably be enforced server-side for delete; today the UI is the only gate.
