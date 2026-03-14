# Architectural Decisions & Known Gotchas

> Persistent knowledge that isn't obvious from the code. Keep this file trim.
> Session history and commit details live in git log.

---

## Active Status

| Area | Status |
|------|--------|
| Backend (fulfillment-engine) | ✅ Complete — 367 tests passing |
| Monorepo structure | ✅ Phases 1-5 done (pnpm workspaces, git history preserved) |
| Dashboard (dashboard/) | ⬜ Not scaffolded — Phases 6-12 pending |
| TGT sandbox integration | ✅ Live E2E verified 2026-03-14 — auth, products, order, poll, credentials all working |
| Current branch | `main` |

**Next action**: Scaffold `dashboard/` (Phase 6) — see [`fulfillment-engine/docs/MONOREPO_MIGRATION_PLAN.md`](fulfillment-engine/docs/MONOREPO_MIGRATION_PLAN.md) for full phase plan.

---

## Shopify Webhook Gotchas (Production Lessons)

These are non-obvious and have caused production issues. Always apply when modifying webhook code:

1. **Shopify sends numeric IDs as strings** — use `z.coerce.number()` not `z.number()` for `id`, `variant_id`, `product_id`
2. **`customer`, `customer.email`, and most fields can be null** — use `.nullable().optional()` on all Shopify fields
3. **Non-orders/paid topics hit the endpoint** — add a topic guard early: skip if `x-shopify-topic !== 'orders/paid'`
4. **Gift card line items have `variant_id: null`** — skip with a warning, don't throw (would block the entire order)
5. **Email fallback chain** — try in order: `customer.email` → `contact_email` → `email` → `billing_address.email`

---

## Architectural Decisions

**Why pg-boss instead of Redis/BullMQ?**
PostgreSQL is already required. Avoiding a second infrastructure dependency (Redis) for a low-volume system (≤1000 eSIMs total).

**Why two separate processes (API + Worker)?**
Webhook handler must return 200 to Shopify within seconds. Vendor API calls can take 10-30s. The job queue decouples them cleanly.

**Why AES encryption for eSIM credentials?**
LPA strings and activation codes are sensitive — if the DB is compromised, credentials shouldn't be readable in plaintext. Encryption key stored in env var.

**Why a VendorProvider interface?**
Two vendors (FiRoam sync, TGT async) with different protocols. The interface lets the worker job stay vendor-agnostic — vendor selection happens via `ProviderSkuMapping.provider`.

**TGT fulfillment modes (callback/polling/hybrid)**
TGT orders are asynchronous. Three modes are supported via env var `TGT_FULFILLMENT_MODE`:
- `callback` — wait for TGT to POST to `/webhook/tgt/callback`
- `polling` — worker polls TGT API at intervals
- `hybrid` (default) — poll first, fall back to awaiting callback

**TGT auth token field name discrepancy**
TGT's docs describe the `/oauth/token` response field as `accessToken`, but the actual API
(confirmed on sandbox 2026-03-14) returns it as `token`. `TgtTokenInfoSchema` accepts both
(`accessToken ?? token`) so this is handled, but don't trust the field name in TGT docs.

**TGT sandbox account activation**
A new TGT sandbox account requires explicit API activation by TGT's FAE team — credentials alone
are not enough. Symptom: `/oauth/token` returns `code=2001: Insufficient interface permission`
even with the correct `accountId`/`secret`. Resolution: email TGT FAE and ask them to enable
API access for the account. Typically resolved within one business day.

---

## Known Issues / Active Considerations

1. **Cross-module type sharing** — dashboard and fulfillment-engine share no types yet. Consider `@esim/types` shared package post-Phase 12.
2. **Admin API key in URL** — never pass `ADMIN_API_KEY` as a URL query param; always use `x-admin-key` header.
3. **Railway root directory** — Railway is configured with root dir `fulfillment-engine/`. Don't move `railway.json`.
4. **dashboard/ is empty** — don't add any backend code to `dashboard/`; it's reserved for the React frontend scaffold.

---

## Auth Contract (Backend ↔ Dashboard)

| Variable | Set In | Read By |
|----------|--------|---------|
| `ADMIN_API_KEY` | Railway env (fulfillment-engine) | fulfillment-engine — protects all `/admin/*` routes |
| `VITE_API_URL` | Vercel/Railway env (dashboard) | dashboard — base URL for admin API |

Dashboard flow: user types API key → stored in Zustand authStore (sessionStorage) → every request sends `x-admin-key: <key>` header.
