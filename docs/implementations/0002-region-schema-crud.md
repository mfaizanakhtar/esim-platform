# Region Schema + CRUD + Discovery

**ID:** 0002 · **Status:** in progress · **Owner:** faizanakh
**Shipped:** in progress · **PRs:** #226 (schema + CRUD), #_TBD_ (discovery)

## What it does

Introduces a first-class `Region` entity (e.g. `EU30`, `ASIA4`, `GCC6`) and extends `ShopifyProductTemplate` so country and region templates coexist. Adds admin CRUD endpoints under `/admin/regions` so operators can curate canonical country groupings via the dashboard. Adds `GET /admin/regions/suggestions`: a read-only discovery endpoint that aggregates the live `ProviderSkuCatalog` and proposes Region rows the admin can review and save. Together these are the schema + API foundation for regional SKUs — template generation and provider matching land in subsequent PRs.

## Why

Both FiRoam and TGT sell regional packages (Asia, Europe, GCC, Global) at much better unit prices than per-country plans. Today the catalog is country-keyed (`ShopifyProductTemplate.countryCode @unique`), so we can't expose regional Shopify products and can't structurally match regional Shopify SKUs to the right provider regional SKUs. We need a stable canonical region identifier (used in SKUs) plus a managed coverage list (used for strict-coverage matching against provider catalogs).

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/prisma/schema.prisma` | Adds `Region` model; `templateType` + `regionCode` on `ShopifyProductTemplate`; `countryCode` made nullable |
| `fulfillment-engine/prisma/migrations/20260426000001_add_region_support/migration.sql` | Creates `Region` table + indexes; backfills `templateType='COUNTRY'`; adds `regionCode` FK with `ON DELETE SET NULL` |
| `fulfillment-engine/src/api/admin.ts` | New `GET/POST/PATCH/DELETE /admin/regions` endpoints + `GET /admin/regions/suggestions` (region CRUD section near bottom of file) |
| `fulfillment-engine/src/services/regionService.ts` | Discovery service: `buildRegionSuggestions()` aggregates provider catalog → groups → INTERSECTION/UNION suggestions; pure functions `normalizeLabel`/`inferParentCode` for label canonicalization |
| `fulfillment-engine/src/services/__tests__/regionService.test.ts` | 18 unit tests covering normalization, intersection/union math, suggestion emission rules, edge cases (invalid country codes, empty arrays, unionLimit) |
| `fulfillment-engine/src/api/__tests__/admin.test.ts` | Region CRUD test suite + suggestions endpoint integration tests (33+ cases total) |
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

## Related docs

- `docs/database.md` — schema reference for `Region` and the new `ShopifyProductTemplate` shape
- `docs/api-admin.md` — `/admin/regions` endpoint reference

## Future work / known gaps

- **Region template generation** (Phase 4) — extend `POST /admin/product-templates/generate` with a REGION branch + strict-coverage filter.
- **Region-aware mapping** (Phase 5) — coverage filter in structured + AI mapping paths.
- **Dashboard UI** for region CRUD + suggestions review — backend is ready; the React dashboard pages are deferred.
- **Pricing for region templates** — pricing engine currently skips region templates; needs a region-specific cost-floor + competitor strategy later.
- **Discovery doesn't auto-merge synonyms** (e.g. `EU` and `Europe`) — intentional for safety, but a future enhancement could surface merge suggestions when two groups share a `parentCode`.
