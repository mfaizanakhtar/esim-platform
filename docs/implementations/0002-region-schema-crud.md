# Region Schema + CRUD + Discovery + Template Generation

**ID:** 0002 · **Status:** in progress · **Owner:** faizanakh
**Shipped:** in progress · **PRs:** #226 (schema + CRUD), #227 (discovery), #_TBD_ (template generation)

## What it does

Introduces a first-class `Region` entity (e.g. `EU30`, `ASIA4`, `GCC6`) and extends `ShopifyProductTemplate` so country and region templates coexist. Adds admin CRUD endpoints under `/admin/regions` so operators can curate canonical country groupings via the dashboard. Adds `GET /admin/regions/suggestions`: a read-only discovery endpoint that aggregates the live `ProviderSkuCatalog` and proposes Region rows the admin can review and save. Extends `POST /admin/product-templates/generate` with a `templateType: "REGION"` branch that materializes per-region Shopify product templates with `REGION-<code>-...` SKUs, scaled prices, and a strict-coverage check that skips regions no provider can fulfil. Together these are the schema, discovery, and template foundation for regional SKUs — provider matching (structured + AI) lands in the next PR.

## Why

Both FiRoam and TGT sell regional packages (Asia, Europe, GCC, Global) at much better unit prices than per-country plans. Today the catalog is country-keyed (`ShopifyProductTemplate.countryCode @unique`), so we can't expose regional Shopify products and can't structurally match regional Shopify SKUs to the right provider regional SKUs. We need a stable canonical region identifier (used in SKUs) plus a managed coverage list (used for strict-coverage matching against provider catalogs).

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/prisma/schema.prisma` | Adds `Region` model; `templateType` + `regionCode` on `ShopifyProductTemplate`; `countryCode` made nullable |
| `fulfillment-engine/prisma/migrations/20260426000001_add_region_support/migration.sql` | Creates `Region` table + indexes; backfills `templateType='COUNTRY'`; adds `regionCode` FK with `ON DELETE SET NULL` |
| `fulfillment-engine/src/api/admin.ts` | New `GET/POST/PATCH/DELETE /admin/regions` endpoints + `GET /admin/regions/suggestions` + REGION branch on `POST /product-templates/generate` (with `buildRegionTemplateVariants` and `regionHasProviderCoverage` helpers) |
| `fulfillment-engine/src/services/regionService.ts` | Discovery service: `buildRegionSuggestions()` aggregates provider catalog → groups → INTERSECTION/UNION suggestions; pure functions `normalizeLabel`/`inferParentCode` for label canonicalization |
| `fulfillment-engine/src/services/__tests__/regionService.test.ts` | 18 unit tests covering normalization, intersection/union math, suggestion emission rules, edge cases (invalid country codes, empty arrays, unionLimit) |
| `fulfillment-engine/src/api/__tests__/admin.test.ts` | Region CRUD + suggestions + REGION template generation integration tests (40+ cases total) |
| `fulfillment-engine/src/services/pricingEngine.ts` | Skips variants whose template has no `countryCode` (region templates are not priced through the country-only path yet) |
| `fulfillment-engine/src/services/competitorScraper.ts` | Filters out region templates when discovering countries to scrape |

## Touchpoints

- Prisma schema + generated client (everything that imports `Region` or `ShopifyProductTemplate`)
- Admin API surface (`/admin/regions/*`)
- Provider catalog (read-only consumer for discovery)
- Pricing engine and competitor scraper — both made `countryCode`-null-safe
- No changes to: webhook, `provisionEsim`, vendor providers, customer-facing extensions, email path

## Data model

**New `Region` model:** `code` (unique, used in SKUs), `parentCode` (groups variants like `EU`, `ASIA`), `name`, `description?`, `countryCodes` (Json array), `isActive`, `sortOrder`. Indexed on `parentCode` and `isActive`.

**Modified `ShopifyProductTemplate`:**
- New `templateType` (default `"COUNTRY"`) discriminator.
- New `regionCode` nullable + `@unique` + FK to `Region.code` (`ON DELETE SET NULL`).
- Existing `countryCode` is now nullable + `@unique` (was `String @unique`).

Migration: `20260426000001_add_region_support`. Hand-written SQL — backfills `templateType` via column DEFAULT, drops `NOT NULL` on `countryCode`, adds new indexes and FK. Existing rows automatically become `templateType='COUNTRY'` with their `countryCode` intact.

## Gotchas / non-obvious decisions

- **Why nullable + single-column unique on both `countryCode` and `regionCode` instead of composite `(templateType, code)`?** Composite uniques would have forced every existing call site (`findUnique({ where: { countryCode: 'DE' } })`) to switch to `findUnique({ where: { templateType_countryCode: { ... } } })` — large blast radius. PostgreSQL treats NULL as distinct in unique indexes, so a nullable `@unique` column gives partial-unique semantics for free: REGION rows with `countryCode = NULL` coexist freely; populated values stay globally unique. Same trick on `regionCode`. Application code is responsible for ensuring exactly one of the two is set per row.
- **Why no encoding of country codes in the SKU?** A SKU like `REGION-EU-30D-FIXED-DE_NL_FR_AT_BE...` would blow past readable length and any membership change would force renaming SKUs (breaking metafields, reporting, customer references). The region code is stable; the canonical country list lives in `Region.countryCodes` and can change without touching SKUs.
- **Why hard-delete (with FK SET NULL) instead of soft-delete?** Soft-delete would leave SKUs pointing at inactive regions silently. Hard-delete with `ON DELETE SET NULL` makes orphaned templates visible (their `regionCode` becomes NULL) so an admin must explicitly fix them.
- **Region `code` is immutable via PATCH.** It's embedded in SKUs that are already in customer hands and Shopify metafields — renaming it would break references everywhere. The `Region.code` field has no PATCH branch.
- **`parentCode` validation is stricter than `code`** (no dashes, max 16 chars). Parent codes are pure family labels (`EU`, `ASIA`); the dash is only useful in variant codes (`AMERICAS-NA3`).
- **Pricing engine + competitor scraper changes are minimal but necessary.** They were written against `countryCode: String` (non-null). Now they skip rows where `countryCode` is NULL — region templates aren't in those code paths' scope yet (Phase 4+ adds region-aware pricing).
- **Discovery groups by *exact* normalized vendor label, not by inferred parent code.** That means `EU` and `Europe` show up as two separate groups (both with `parentCode: "EU"`) when providers use different labels. This is intentional — auto-merging would let one provider's quirky label silently absorb another's coverage, hiding mismatches. The admin reconciles by saving one canonical `Region` and ignoring the other group.
- **Discovery skips entries with empty `countryCodes`.** Some vendor regional SKUs have a `region` label but no member country list — we can't propose coverage from those rows, so they're filtered out at the suggestion stage.
- **`UNION` suggestions can have empty `providersAvailable`.** That signals "no single provider can fulfil this region under strict-coverage matching" — the suggestion exists for visibility but the admin should usually prefer the INTERSECTION variant or restrict the region.
- **Suggestion endpoint is read-only and idempotent.** It runs each call against the live catalog; no caching, no DB writes. Cheap because catalog rows are O(thousands), not O(millions).
- **Region templates use the same fixed validity/volume matrix as country templates**, just with a price multiplier (default `2.5×`). This keeps the variant set predictable across regions and means existing pricing UI/code doesn't need a region-specific code path. Per-variant coverage filtering can be added later if specific (data, validity) combinations turn out not to be fulfillable.
- **Strict-coverage check skips entire regions, not individual variants.** If no provider catalog row covers all of `region.countryCodes`, the region template isn't generated at all — better to emit nothing than emit a Shopify product no one can fulfil. Variant-level filtering would be a v2 enhancement when we have richer variant→provider matching data.
- **Region template handle is `region-<slug>`, not `<slug>`.** Prevents collisions with future country slugs (e.g. an admin who later defines a `JP` region wouldn't conflict with the country-keyed `jp` template).
- **`countryCode: null` is set explicitly on the REGION upsert update path.** If an admin reassigns a template's identity from COUNTRY to REGION (an unusual but possible flow), we must clear the old country pointer or the unique constraint stops them from creating the new region's country sibling.
- **Default 2.5x multiplier is conservative.** It's a placeholder until competitor pricing for regions exists; admins can override per call via `priceMultiplier` until the pricing engine learns about regions properly (future work).

## Related docs

- `docs/database.md` — schema reference for `Region` and the new `ShopifyProductTemplate` shape
- `docs/api-admin.md` — `/admin/regions` endpoint reference

## Future work / known gaps

- **Region-aware mapping** (Phase 5) — coverage filter in structured + AI mapping paths so regional Shopify SKUs only resolve to provider catalog rows that cover every country in the region.
- **Per-variant coverage filtering** — current behaviour skips an entire region if any country isn't covered. Future improvement: skip individual (data, validity) variants where no provider has matching `parsedJson`, so partial regions can still expose the variants that ARE fulfillable.
- **Push to Shopify** — Phase 4 generates DB records only. The existing `POST /admin/product-templates/push-to-shopify` flow needs verification (or extension) for region-flavoured templates.
- **Dashboard UI** for region CRUD + suggestions review + generate trigger — backend is ready; the React dashboard pages are deferred.
- **Pricing for region templates** — pricing engine currently skips region templates; the multiplier-based prices are placeholders until a region-specific cost-floor + competitor strategy exists.
- **Discovery doesn't auto-merge synonyms** (e.g. `EU` and `Europe`) — intentional for safety, but a future enhancement could surface merge suggestions when two groups share a `parentCode`.
