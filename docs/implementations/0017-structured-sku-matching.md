# Structured SKU matching (deterministic region + plan + duration)

**ID:** 0017 · **Status:** shipped · **Owner:** backfill
**Shipped:** pre-log · **PRs:** pre-log

## What it does

For Shopify SKUs that follow our canonical naming format (`<COUNTRY|REGION>-<region>-<data>-<duration>-<FIXED|DAYPASS>`), `parseShopifySku` extracts `{ kind, regionCode, dataMb, validityDays, packageType }` deterministically. The structured matcher (`/admin/structured-map` route) then queries `ProviderSkuCatalog` rows whose `parsedJson.regionCodes`, `dataMb`, `validityDays`, and `packageType` all match — using JSONB containment for REGION SKUs (catalog must cover *all* advertised countries) and array-length checks for COUNTRY SKUs (no falling back to a multi-region plan unless `relaxRegion=true`). Output is a sorted draft list (cheapest cost-effective match first), no AI involvement.

## Why

When Shopify SKUs follow our naming convention, deterministic matching is faster, cheaper (no OpenAI calls), and explainable (you can read the SQL and predict the result). It catches the common case before the AI mapper has to do anything; AI is reserved for SKUs that don't fit the format or for which structured matching returned empty.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/src/utils/parseShopifySku.ts` | Regex-based SKU parser; returns `null` on malformed inputs |
| `fulfillment-engine/src/utils/countryCodes.ts` | ISO ↔ display name conversion; handles FiRoam's display-name catalog rows |
| `fulfillment-engine/src/api/admin.ts` (`/admin/structured-map`) | Endpoint that runs the JSONB queries and ranks candidates |

## Touchpoints

- DB: `ProviderSkuCatalog.parsedJson` (read), `Region.countryCodes` (read for REGION SKUs)
- AI mapping: structured matcher's empty result triggers AI fallback in some flows
- Dashboard: structured-map drafts surface alongside AI drafts in the same UI

## Data model

- No tables of its own. Reads `ProviderSkuCatalog.parsedJson` and `Region.countryCodes`.

## Gotchas / non-obvious decisions

- **Parser is strict and returns `null` for non-canonical SKUs.** Only `FIXED` or `DAYPASS` package suffixes are accepted. Trial / Beta / Sample SKUs return null — callers must handle null and skip, not crash.
- **`dataMb` is the canonical unit; the parser converts `GB → MB` (×1024).** Catalog `parsedJson` uses the same unit by GPT-prompt convention. If a parser anywhere stores GB or KB, every match in that row breaks silently.
- **REGION matching uses JSONB *containment*, not substring/intersection.** `catalog.countryCodes @> region.countryCodes` — the catalog row's set must be a superset of the region's. `Region: ["DE","FR"]` matches catalog `["DE","FR","IT"]` but NOT catalog `["DE"]`. This is the strict-coverage rule from `0002-region-schema-crud`.
- **COUNTRY matching uses `jsonb_array_length(...) = 1` in strict mode.** A SKU like `COUNTRY-DE-…` only matches catalog rows whose `regionCodes` is exactly `["DE"]`. Multi-country plans (`["DE","FR"]`) are excluded unless `relaxRegion=true`. This prevents accidentally selling an EU plan as a Germany-only product.
- **Specificity is a tie-breaker, price is the primary sort.** Among matches, smaller `countryCodes` arrays score higher *for ranking ties*, but the primary order is cheapest `netPrice` first. Don't read the matcher and assume "fewest countries wins".
- **Multi-region SKU names aren't supported.** The regex requires a single region segment. `EU-AF-5GB-30D-FIXED` returns `null`. Use one SKU per region; rely on the catalog row to cover both if needed.
- **REGION SKUs without a backing `Region` row return zero drafts silently.** If an operator creates a `REGION-AFRICA-…` SKU but never adds the `AFRICA` `Region` row, structured matching always returns empty. The dashboard surfaces this as "no suggestions" — not as an error.
- **`packageType` mismatch always rejects.** A `FIXED` SKU never matches a `DAYPASS` catalog row even if `dataMb`/`validityDays` line up. Type parity is non-negotiable; pricing semantics differ.
- **Daypass parity check uses the catalog's heuristic.** FiRoam catalog daypass rows have `?` in `productCode`; TGT use `productType: 'DAILY_PACK'`. If a third indicator surfaces, structured matching mis-classifies and rejects valid candidates.
- **Validity matches exactly by default.** Tolerance only kicks in with `relaxValidity=true` — most flows leave it false, so `30D` SKU never matches a `28D` catalog row. Don't introduce tolerance in the parser instead; keep the parser deterministic and put fuzz at the matcher.
- **The `regionCodes` JSON in `parsedJson` is the source of truth, not the catalog's `region` column.** GPT-mini parses the vendor's free-text into `parsedJson.regionCodes`; matchers query that. The legacy `region` column (single string) is a hint, not authoritative.

## Related docs

- `docs/sku-mapping.md` — structured matching workflow
- `docs/api-admin.md` — `/admin/structured-map`
- `docs/database.md` — `Region`, `ProviderSkuCatalog`
- `0002-region-schema-crud.md` — strict-coverage origin

## Future work / known gaps

- Multi-region SKU support (e.g., `EU+AFRICA`) would require a parser change *and* a Region "union" concept.
- The parser is regex-based and silently drops malformed SKUs. A "parse with reason" variant would help operators understand why a SKU isn't being matched.
