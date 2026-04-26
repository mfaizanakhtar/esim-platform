# Region Schema + CRUD + Discovery + Templates + Mapping + Dashboard

**ID:** 0002 · **Status:** shipped · **Owner:** faizanakh
**Shipped:** 2026-04-26 · **PRs:** #226 (schema + CRUD), #227 (discovery), #228 (template generation), #229 (region-aware mapping), #_TBD_ (dashboard parity)

## What it does

Introduces a first-class `Region` entity (e.g. `EU30`, `ASIA4`, `GCC6`) and extends `ShopifyProductTemplate` so country and region templates coexist. Admin CRUD under `/admin/regions` curates canonical country groupings; `GET /admin/regions/suggestions` discovers candidate regions from the live provider catalog. `POST /admin/product-templates/generate` gains a REGION mode that materializes per-region Shopify product templates with `REGION-<code>-...` SKUs, scaled prices, and a strict-coverage skip. Both structured matching (`/sku-mappings/structured-match[/jobs]`) and AI mapping (`/sku-mappings/ai-map/jobs`) recognise REGION SKUs and apply strict-coverage filtering: a regional Shopify SKU resolves only to a provider catalog row whose `countryCodes` is a superset of the canonical region's countries. The dashboard now exposes the entire region workflow without curl: a new `/regions` page lists discovery suggestions with 1-click Accept buttons (calling the new `POST /admin/regions/accept-suggestion`), and the existing "Generate All Templates" button on `/product-templates` materializes BOTH country and region templates in one click. End-to-end, regional eSIMs can be defined, generated, mapped, and sold without leaving the dashboard.

## Why

Both FiRoam and TGT sell regional packages (Asia, Europe, GCC, Global) at much better unit prices than per-country plans. Today the catalog is country-keyed (`ShopifyProductTemplate.countryCode @unique`), so we can't expose regional Shopify products and can't structurally match regional Shopify SKUs to the right provider regional SKUs. We need a stable canonical region identifier (used in SKUs) plus a managed coverage list (used for strict-coverage matching against provider catalogs).

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/prisma/schema.prisma` | Adds `Region` model; `templateType` + `regionCode` on `ShopifyProductTemplate`; `countryCode` made nullable |
| `fulfillment-engine/prisma/migrations/20260426000001_add_region_support/migration.sql` | Creates `Region` table + indexes; backfills `templateType='COUNTRY'`; adds `regionCode` FK with `ON DELETE SET NULL` |
| `fulfillment-engine/src/api/admin.ts` | Region CRUD + suggestions + REGION template generation + REGION branch in `findStructuredMatches` (JSONB `@>` strict-superset) + REGION branch in AI mapping post-filter (uses pre-fetched region map) + `POST /regions/accept-suggestion` + combined `country` & `region` response when `templateType` omitted on `/product-templates/generate` |
| `dashboard/src/pages/Regions.tsx` | **NEW** — discovery suggestions cards + saved regions table; 1-click Accept; edit/delete dialogs |
| `dashboard/src/hooks/useRegions.ts` | **NEW** — React Query hooks (`useRegions`, `useRegionSuggestions`, `useAcceptSuggestion`, `useUpdateRegion`, `useDeleteRegion`) |
| `dashboard/src/App.tsx` | New `/regions` lazy route registered between `/catalog` and `/pricing` |
| `dashboard/src/components/layout/AppShell.tsx` | Sidebar nav entry "Regions" (Globe icon) between Catalog and Products |
| `dashboard/src/hooks/useProductTemplates.ts` | `GenerateResult` now optionally exposes `country` and `region` blocks for the combined response |
| `dashboard/src/pages/ProductTemplates.tsx` | "Generate All Templates" toast surfaces both counts; `summarizeGenerate()` helper handles combined + legacy shapes |
| `fulfillment-engine/src/utils/parseShopifySku.ts` | Adds `kind: 'COUNTRY' \| 'REGION'` discriminator + new `REGION-<code>-...` regex |
| `fulfillment-engine/src/services/regionService.ts` | Discovery service: `buildRegionSuggestions()` aggregates provider catalog → groups → INTERSECTION/UNION suggestions; pure functions `normalizeLabel`/`inferParentCode` for label canonicalization |
| `fulfillment-engine/src/services/__tests__/regionService.test.ts` | 18 unit tests covering normalization, intersection/union math, suggestion emission rules, edge cases (invalid country codes, empty arrays, unionLimit) |
| `fulfillment-engine/src/utils/__tests__/parseShopifySku.test.ts` | Tests for REGION SKU recognition, embedded-dash region codes, `kind` discriminator on COUNTRY/legacy outputs |
| `fulfillment-engine/src/api/__tests__/admin.test.ts` | Region CRUD + suggestions + REGION template generation + REGION SKU coverage matching integration tests (45+ cases total) |
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
- **REGION SKU specificity** is `catalog.countryCodes.length` (smaller = tighter fit) — the *opposite* relationship from COUNTRY SKUs which use `parsedJson.regionCodes.length`. Two providers covering the same region: the one selling a 4-country pack beats the one selling a 30-country pack, because the tighter pack is usually cheaper and dedicated.
- **JSONB `@>` is the strict-coverage primitive.** `catalog.countryCodes @> ['DE','FR','AT']::jsonb` returns true iff the catalog row's array includes every code on the right. Encodes the rule "provider must cover all advertised countries" with a single index-friendly clause — no application-level filtering needed at the DB layer.
- **AI mapping pre-fetches Region rows once per job**, not per draft. `regionCountriesByCode` is built up-front from `prisma.region.findMany()` and captured by closures. This keeps the post-filter sync (filter callbacks can't be async) without N+1 lookups when GPT proposes many REGION matches.
- **AI mapping has TWO post-filter sites** (vector path and fallback path) that must stay in sync — both apply the same REGION branch. The fallback path is dead code in normal operation (vector search is on by default) but is exercised when pgvector is unavailable.
- **REGION SKU with unknown region code returns empty drafts immediately**, before any catalog query runs. Avoids wasting a JSONB scan when the SKU points at a region we never created — also surfaces the misconfiguration faster than silently matching nothing.
- **Existing tests that exercise AI/structured mapping had to be updated** to default-mock `prisma.region.findMany` to `[]`. The pre-fetch is now in the hot path for every mapping job; tests that don't care about REGION still need the mock to return an array (otherwise `.length` blows up). Set in the top-level `beforeEach` so tests don't have to know about it.
- **`/product-templates/generate` defaults to BOTH branches when `templateType` is omitted, not COUNTRY-only.** This is the core UX change in Phase 6 — the dashboard's bare `{}` body now produces both kinds of templates from a single click. Explicit `templateType: "COUNTRY"` and `templateType: "REGION"` callers keep their previous single-branch behavior (backward compatible for any external integrations).
- **`accept-suggestion` re-runs discovery on every call** rather than caching suggestion → row mappings. Cheap (catalog rows are O(thousands)), keeps the endpoint stateless, and means a stale suggestion code (e.g. provider sync changed since the user opened the page) returns 404 instead of creating a misaligned region. The dashboard surfaces the 404 inline on the row.
- **Auto-derived region name uses a small parent-name lookup table** (`PARENT_NAMES` in admin.ts: `EU → "Europe"`, `ASIA → "Asia"`, etc.) so the saved row reads as "Europe (3 countries)" not "EU (3 countries)". Falls back to the parent code itself for unknown parents. Editable post-creation via the dashboard or `PATCH /admin/regions/:code`.
- **Combined dry-run returns both block shapes** so the dashboard can preview the full effect of clicking Generate. Each block keeps its existing dry-run shape (`toGenerate` for country, `plans` for region) so dry-run-aware tooling doesn't have to special-case combined mode.
- **Region delete uses `window.confirm` not a custom dialog.** Dashboard convention elsewhere uses a custom modal but for a single inline destructive action with a clear blast radius (orphans templates via `ON DELETE SET NULL`), the browser confirm is faster to ship and keeps the page lean. Can be upgraded later if needed.

## Related docs

- `docs/database.md` — schema reference for `Region` and the new `ShopifyProductTemplate` shape
- `docs/api-admin.md` — `/admin/regions` endpoint reference

## Future work / known gaps

- **Per-variant coverage filtering** — current behaviour skips an entire region if any country isn't covered. Future improvement: skip individual (data, validity) variants where no provider has matching `parsedJson`, so partial regions can still expose the variants that ARE fulfillable.
- **Push to Shopify** — Phase 4 generates DB records only. The existing `POST /admin/product-templates/push-to-shopify` flow needs verification (or extension) for region-flavoured templates.
- **Dashboard UI** for region CRUD + suggestions review + generate trigger — backend is ready; the React dashboard pages are deferred.
- **Pricing for region templates** — pricing engine currently skips region templates; the multiplier-based prices are placeholders until a region-specific cost-floor + competitor strategy exists.
- **Discovery doesn't auto-merge synonyms** (e.g. `EU` and `Europe`) — intentional for safety, but a future enhancement could surface merge suggestions when two groups share a `parentCode`.
- **AI prompt doesn't yet send the region's country list** to GPT for REGION SKUs. Today GPT picks a candidate by display-name similarity and the deterministic post-filter rejects sub-coverage hits. Including the country list in the prompt would help GPT pick smarter candidates upfront.
- **Vector pre-filter for REGION SKUs** — the top-20 candidates from cosine similarity may all fail the strict-coverage filter. A future enhancement could pre-filter candidates by coverage before GPT, so we don't waste a GPT call on a guaranteed-rejection batch.
