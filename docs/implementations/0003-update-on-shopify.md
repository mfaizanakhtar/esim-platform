# Update on Shopify (non-destructive template sync)

**ID:** 0003 · **Status:** shipped · **Owner:** mfaizanakhtar
**Shipped:** 2026-04-27 · **PRs:** TBD

## What it does

Adds a second action in the Product Templates dashboard — **Update on Shopify** — that pushes template changes (image, title, description, status, vendor, tags, SEO, prices on existing variants) to products already on Shopify, **without** creating new variants and **without** deleting existing ones. The matching is by SKU code. Templates whose `shopifyProductId` is null are skipped (you still need the existing **Push to Shopify** for first-time creation). Operators get a refresh path that doesn't risk regenerating SKUs they don't want.

Also switches the merchant-facing flag image source from `flagcdn.com/w640/{cc}.png` (a 64–128px native PNG that Shopify upscales blurrily and processes for ~130 ms on every unique cache MISS) to `flagcdn.com/{cc}.svg` (vector, ~1–3 KB, no Shopify image-processing penalty). Inline `<img>` in product description bumped to SVG with `width="20"`.

## Why

We discovered the live storefront was rendering tiny / blurry flag images and felt laggy on first paint. Root cause was twofold:

1. The pushed image URL was a 640px-claimed PNG whose actual native resolution is ~64–128px. Shopify upscales on render, producing a larger, blurrier file (2.6 KB native → 6.3 KB upscaled).
2. Each unique transform URL is a CDN cache MISS that takes ~130 ms of imagery-processing time on first request. Storefront with 50 cards = 50 misses per first visitor.

Re-pushing existing products with a fixed image URL was painful because the existing **Push to Shopify** path is destructive — it deletes and recreates all variants every time (`deleteMany: {}` in admin.ts:1641, plus `productVariantsBulkCreate` in client.ts:1194). For an image-only change, that's unnecessary destruction and a real risk if SKU schemas have drifted between dashboard and Shopify. So we needed a non-destructive update path.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/src/shopify/client.ts` | New methods `replaceProductMedia`, `getProductVariantsBySku`, `updateExistingVariantsBySku` (matches by SKU; skips would-be-new SKUs). |
| `fulfillment-engine/src/api/admin.ts` | New endpoint `POST /product-templates/update-on-shopify`. Background job pattern mirrors the existing push endpoint. Also: 5 flagcdn URLs switched to SVG. |
| `dashboard/src/hooks/useProductTemplates.ts` | New `useUpdateOnShopify()` hook (mirrors `usePushToShopify`). |
| `dashboard/src/pages/ProductTemplates.tsx` | Two new buttons: top-bar "Update on Shopify" (disabled until at least one template is pushed) and selection-toolbar "Update Selected". Confirmation dialogs explain "no new SKUs created". |

## Touchpoints

- Dashboard: `ProductTemplates` page (only).
- Backend: `fulfillment-engine/src/api/admin.ts` admin endpoints.
- Shopify Admin API: `productUpdate`, `productCreateMedia`, `productDeleteMedia`, `productVariantsBulkUpdate` (no `productVariantsBulkCreate`, no `productDelete`).
- Storefront image URLs: any flag-rendered card / drawer / description fragment will see the SVG once an Update has run for that product.

## Data model

No schema changes. Uses the existing `ShopifyProductTemplate.shopifyProductId` as the gate (NULL → skipped) and `ShopifyProductTemplateVariant.sku` as the matching key.

## Gotchas / non-obvious decisions

- **SKU is the join key, not GID.** We refetch variants by querying `product.variants(first: 250)` and indexing by `sku`. If a merchant manually edits a SKU code in Shopify Admin and our template still has the old code, that variant is silently skipped. (Logged in `skippedSkus` for visibility.) This is intentional — better than silently overwriting a SKU we don't recognize.
- **Update never creates variants.** If a template has new variants beyond what's on Shopify, those are reported in the response's `skippedSkus` field but NOT created. The merchant must run `Push to Shopify` with `force: true` to handle SKU schema additions. This is the whole point of the new button — refresh existing without churning SKUs.
- **`replaceProductMedia` deletes all media first.** That means the entire product gallery is wiped and rebuilt on every update. Acceptable for our case (one image per product) but if we ever support multi-image products via templates, this needs a smarter diff.
- **Price-only updates already had a path.** `POST /pricing/approve-and-push` (admin.ts:2400) approves proposed prices and pushes price-only updates. The new endpoint is broader (image + description + title + everything), but for pure price-refresh after a pricing run, the existing approve-and-push is still the right tool.
- **SVG vs raster.** flagcdn's SVG endpoint is `/{cc}.svg` (no `wXXX` prefix). We chose flagcdn over alternatives (`hatscripts/circle-flags`, `flagicons.lipis.dev`) because we were already using flagcdn — no new domain dependency, same lowercase ISO code.
- **Existing pushed products still show the old PNG flag** until you run `Update on Shopify` against them. The SVG change only affects new pushes and explicit updates.

## Related docs

- `docs/architecture.md` — Shopify integration overview (no edit needed; the admin-API surface is unchanged).
- `fulfillment-engine/AGENTS.md` — adds `update-on-shopify` to the list of admin endpoints (follow-up).

## Future work / known gaps

- Add a "dry run" UI affordance — the endpoint already supports `dryRun: true`, but the dashboard always sends `false`.
- Surface `skippedSkus` in the toast so the merchant sees which template variants weren't on Shopify.
- Consider auto-running pricing approve before update, gated by a checkbox in the confirm dialog.
