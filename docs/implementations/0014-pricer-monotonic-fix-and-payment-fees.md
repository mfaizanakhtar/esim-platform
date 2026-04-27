# Pricer Monotonic Fix + Payment-Fee Overhead

**ID:** 0014 · **Status:** shipped · **Owner:** faizanakhter
**Shipped:** 2026-04-27 · **PRs:** _pending_

## What it does

Three things:

1. **Fixes a class of monotonic violations** where the pricer produced identical prices for variants that should be strictly ordered (e.g. `2GB/2d` and `2GB/3d` both ending at $2.99).
2. **Adds payment-fee overhead** to the cost-floor calculation. Admins can configure `paymentFeePercent` (default 0.029) and `paymentFeeFixed` (default 0.30) — Shopify Payments shapes — so margin tiers are computed on a cost that already absorbs the processor fee.
3. **Adds a read-only audit script** at `fulfillment-engine/scripts/audit-pricing.ts` that dumps every variant for any list of countries and flags violations in `same_data` / `same_days` / `diagonal` categories.

## Why

The previous monotonic enforcement had two structural gaps that produced the user-reported bug:

- **Group key included `planType`**, so `Day-Pass` and `Total Data` variants for the same data/validity were never compared against each other. Customers see them on the same product page and expect a coherent price ladder.
- **Two independent passes** (first across data, then across validity) missed *diagonal* pairs — where one variant has both more data AND more days than another. The classic "1GB/3d=$3 vs 2GB/2d=$3" case never triggered a bump.

Separately, Shopify takes 2.9% + $0.30 per transaction on every sale; that wasn't reflected in the cost floor, so low-cost SKUs were being priced below their true gross cost.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/src/services/pricingEngine.ts` | Replaced `enforceMonotonicPricing` with a partial-order sweep; added `paymentFeePercent` / `paymentFeeFixed` to `PricingParams`; added `applyPaymentFees`; absorbed fees into `calculateFloors`; rounding now happens before monotonic so the step survives rounding; group key dropped from `country:planType` to just `country` |
| `fulfillment-engine/src/api/admin.ts` | Added range validation for `paymentFeePercent`, `paymentFeeFixed`, `monotonicStep` on `POST /pricing/generate-suggestions` |
| `fulfillment-engine/src/services/__tests__/pricingEngine.test.ts` | Added diagonal-violation tests, payment-fee-absorption tests, and an explicit regression test for the `2GB/2d == 2GB/3d == $2.99` bug |
| `fulfillment-engine/scripts/audit-pricing.ts` | Read-only Prisma script that dumps variants per country and flags monotonic violations (categorized by `same_data` / `same_days` / `diagonal`); supports `--json`, `--field=proposedPrice`, `--group=country` |
| `dashboard/src/hooks/usePricing.ts` | Mirrored `paymentFeePercent` / `paymentFeeFixed` in the dashboard `PricingParams` shape; UI defaults to Shopify-recommended values |
| `dashboard/src/pages/Pricing.tsx` | Added "Payment Fee %" and "Payment Fee Fixed" inputs to the `SmartPricingDialog` |
| `docs/api-admin.md` | Documented `POST /pricing/generate-suggestions` and the new params |

## Touchpoints

- Smart-pricing job (`generateSuggestions` in `pricingEngine.ts`) — orchestration unchanged in shape, but ordering of "round → monotonic" is reversed
- Pricing dashboard `/pricing` — params dialog
- `PricingRun` table — params JSON now contains the two new fee fields

## Algorithm change

`enforceMonotonicPricing()` now enforces:

> For any A, B in the same group, if `A.dataMb ≤ B.dataMb AND A.validityDays ≤ B.validityDays AND (A.dataMb < B.dataMb OR A.validityDays < B.validityDays)`, then `B.price ≥ A.price + step`.

Implementation is a single O(N²) sweep: sort by `(dataMb + validityDays, dataMb, validityDays)` and for each variant, find the max price among all strict predecessors. N is small (≤ ~50 variants per country), so the cost is negligible.

`priceLocked` variants are still anchors — they are not modified, but they participate in the predecessor scan.

## Gotchas / non-obvious decisions

- **Backend defaults for payment fees are 0**, not 2.9% / $0.30. This keeps every existing pricing run reproducible until the admin explicitly opts in via the dashboard. The dashboard `DEFAULT_PRICING_PARAMS` ships the Shopify-shaped values as the recommended UX default.
- **Group key no longer includes `planType`** — Day-Pass and Total Data variants now share one ladder per country. This is intentional: customers see them on the same page.
- **One pre-existing test changed expected behaviour** (`enforceMonotonicPricing › locked variants › does not modify locked variants`): a low-priced locked variant no longer suppresses bumps from earlier predecessors. Under the partial-order sweep, every successor must respect *all* its predecessors, not just the immediate prior element.
- **Payment-fee math approximates** retail-side fees against cost (not retail), to avoid a circular `retail = (cost + 0.30) / (1 - 0.029) * markup` solve. The markup absorbs the small delta — fine for normal SKUs, slightly under-recovers fees on very low-margin SKUs.
- **Rounding now precedes monotonic** in `generateSuggestions`. With the previous order, two variants both clamped to `$2.99` could be bumped to `$3.99` then rounded back into different `.99` slots — but if the bump was small (< 0.50), rounding could erode the gap. Reversing the order guarantees `roundedPrice[B] ≥ roundedPrice[A] + step`.

## Verification

- Backend: `npm run verify` in `fulfillment-engine/` — 839 tests pass, including new diagonal & payment-fee tests.
- Dashboard: `npm run type-check`.
- Audit script: `railway shell --service esim-api` then `npx tsx scripts/audit-pricing.ts`. Re-run after a smart-pricing job with `--field=proposedPrice` to confirm violations dropped to zero.

## Future work / known gaps

- Region templates (`regionCode`) are still skipped by the pricer — no `countryCode`, no path through `calculateCostFloors` / `generateSuggestions`. Tracked separately.
- The audit script can't run from local due to Railway internal-only DB hostname. Run it inside `railway shell` or as a one-off Railway job.
- A circular-solve mode for payment-fee math (compute on retail) could be added if precision matters for very low-margin tiers.
