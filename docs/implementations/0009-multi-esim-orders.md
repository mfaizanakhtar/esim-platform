# Multi-eSIM orders across all touchpoints

**ID:** 0009 · **Status:** shipped · **Owner:** backfill
**Shipped:** pre-log · **PRs:** pre-log

## What it does

A single Shopify order with multiple eSIM line items (or a quantity > 1 line item) now produces and surfaces multiple `EsimDelivery` rows uniformly across every touchpoint: the status endpoint returns a `deliveries[]` array (with backward-compatible top-level fields from the first), the usage endpoint returns a wrapped `{ deliveries: [...] }` payload when more than one is found (and a flat single-delivery shape when exactly one), and the storefront thank-you extension renders one card per line item with per-item status + LPA + QR. The webhook → provision pipeline already supported this at the DB level (idempotency keyed on `orderId + lineItemId`); this entry covers the read-side propagation.

## Why

Customers buy two eSIMs in one order — for themselves and a travel companion, or for two devices. Before this change every read path returned only the first delivery, so the second eSIM was effectively invisible on the thank-you page and the usage page. The fix had to preserve the single-delivery response shape for backward compatibility with older extension versions still in the wild on cached pages.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/src/api/esim.ts` | `GET /esim/order/:orderId/status` returns `deliveries[]` with per-item status + access token |
| `fulfillment-engine/src/api/usage.ts` | `handleOrderSearch` returns flat shape for 1 delivery, wrapped `{ deliveries: [...] }` for many |
| `fulfillment-engine/extensions/esim-order-status/src/ThankYouAnnouncement.tsx` | Multi-card render on the announcement banner |
| `fulfillment-engine/extensions/esim-order-status/src/ThankYouBlock.tsx` | Multi-card render on the post-purchase block |
| `fulfillment-engine/prisma/migrations/20260424000001_add_unique_order_line_item/migration.sql` | Unique index on `(orderId, lineItemId)` — dedupes any pre-existing duplicates and enforces per-line-item idempotency at the DB level |

## Touchpoints

- Public API: `/esim/order/:orderId/status`, `/usage` order search
- Shopify storefront extension: `esim-order-status` (announcement + block)
- DB: `EsimDelivery` queried via `findMany`, ordered by `createdAt`

## Data model

- No new table. The migration backfills (deletes) any pre-existing duplicate `(orderId, lineItemId)` rows, then adds a `UNIQUE` index on `(orderId, lineItemId)`. This makes the webhook handler's "already processed?" check effectively impossible to bypass — even concurrent webhook redeliveries can't create a duplicate.
- Schema reference: `docs/database.md`.

## Gotchas / non-obvious decisions

- **Backward-compatible response shape.** The status endpoint still returns the *first* delivery's `status` and `accessToken` at the top level, in addition to the new `deliveries[]` array. Older deployed extensions read the top-level fields; new extensions iterate `deliveries`. Don't drop the top-level shim.
- **Single vs many in `usage` is asymmetric.** When exactly one delivery is found the response is the *flat* historical shape; with two or more the response is `{ deliveries: [...] }`. This is intentional to keep simple lookups easy on the consumer side, but it means consumers need a small "if `deliveries` exists, iterate; else use flat" branch.
- **Per-line-item access tokens.** Each delivery has its own `accessToken` (generated at webhook intake), so the extension fetches `/esim/delivery/:token` once per card. Don't try to share a single token across deliveries.
- **Ordering.** Status endpoint orders by `createdAt: 'asc'` so the rendered cards stay in the order Shopify created the line items. Don't change to `desc` — UX feedback was that the order should match the receipt.
- **Top-up + new-eSIM in the same order.** Each delivery carries its own `topupIccid` flag; the extension renders a "top-up confirmation" card for top-up lines and a full LPA/QR card for new-eSIM lines side by side. Already handled by `finalizeDelivery`'s `isTopup` branching — see `0004`.

## Related docs

- `docs/api-public.md` — status endpoint + usage shape (already updated)
- `docs/database.md` — `EsimDelivery` indexes
- `docs/shopify.md` — extension behaviour change

## Future work / known gaps

- The flat-vs-wrapped shape switch in `/usage` is a wart. If we ever break the API we should always wrap; for now the asymmetry is preserved for older clients.
