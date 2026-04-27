# FiRoam vendor integration (synchronous provisioning)

**ID:** 0011 · **Status:** shipped · **Owner:** backfill
**Shipped:** pre-log · **PRs:** pre-log

## What it does

`FiRoamClient` is the HTTP layer for FiRoam: token-based auth with MD5 request signing, a one-step `addEsimOrder` (returns credentials immediately when `backInfo="1"`) or two-step (`addEsimOrder` then `getOrderInfo`), `queryEsimOrder` for usage / activation status, and `cancelOrder` for terminating an unactivated card. `FiRoamProvider` is the thin adapter that maps a `ProviderSkuMapping` row to a FiRoam call and returns the normalised `EsimProvisionResult`. FiRoam is the primary provider for SaileSim today and the only one whose provisioning is fully synchronous.

## Why

FiRoam returns credentials in milliseconds for every region they cover, so the provisioning job can call them, get an LPA + ICCID, and call `finalizeDelivery` in a single worker run. That makes them the lowest-friction vendor — no polling jobs, no callback handlers, no async state machine. Everything else in the backend (idempotency, error hierarchy, finalize) was designed assuming this synchronous shape works for the common case.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/src/vendor/firoamClient.ts` | HTTP + signing + token cache; `addEsimOrder`, `getOrderInfo`, `queryEsimOrder`, `cancelOrder`, normalisers |
| `fulfillment-engine/src/vendor/firoamSchemas.ts` | Zod schemas + the field-name fallback chain for response variants |
| `fulfillment-engine/src/vendor/providers/firoam.ts` | `VendorProvider` adapter — parses `providerSku`, picks daypass package, calls client |
| `fulfillment-engine/scripts/fetch-firoam-skus.ts` | One-shot ingest of FiRoam catalog into `ProviderSkuCatalog` |

## Touchpoints

- Worker job: `provision-esim` (sync path)
- Worker job: `cancel-esim` (FiRoam branch)
- DB: `EsimOrder` (FiRoam-only persistence of the raw order/cards), `ProviderSkuCatalog`, `ProviderSkuMapping`
- Env vars: `FIROAM_BASE_URL`, `FIROAM_PHONE`, `FIROAM_PASSWORD`, `FIROAM_SIGN_KEY`

## Data model

- `EsimOrder` rows are created on every `addEsimOrder` call (success or invalid-payload), with the encrypted payload, normalised cards, and a status. Schema lives in `docs/database.md`.

## Gotchas / non-obvious decisions

- **Signature algorithm is MD5 of URL-encoded params concatenated with no separators.** Easy to get wrong: missing `encodeURIComponent` or any separator (commas, `&`) breaks it silently. The exact construction lives in `firoamClient.ts` — copy from there for any new endpoint, don't re-invent.
- **Login is GET with query params, not POST.** FiRoam's quirk; don't "fix" it. Tokens are cached for ~1 hour with a 5-minute refresh buffer to avoid race conditions.
- **Cancellation cannot include a `remark` parameter.** Sending one breaks the signature on FiRoam's side. The cancel payload stays minimal — see the comment in `firoamClient.ts` cancel section.
- **Field-name fallback chain.** FiRoam has multiple co-deployed API versions. LPA may arrive as `code`, `lpa`, `lpaString`, or `sm_dp_address`; ICCID may arrive as `mobileNumber` in legacy responses. The normaliser chains all known names; if FiRoam ever ships a new field, **the data silently disappears** until we add it to the chain.
- **One-step vs two-step is detected by response shape.** When `addEsimOrder` returns both `orderNum` and `cardApiDtoList`/`cards`/`cardList`, we use it directly. Otherwise we follow up with `getOrderInfo`. Don't assume one path; always check.
- **Order data may be a bare string or an object.** When FiRoam acknowledges the order but defers cards, `data` is just the order number string. The schema and normaliser handle both.
- **Daypass lookup falls back from apiCode-exact to apiCode-prefix + data-amount match.** apiCode format isn't fully stable across regions; the second pass exists because we've seen valid daypass packages whose apiCode was non-exact-match. See `providers/firoam.ts:119-151`.
- **Daypass apiCode contains a `?` placeholder for day count.** The provider rewrites `?` → `daysCount` before sending. Don't pre-substitute when storing in the DB — keep the placeholder so the same row works for any duration.
- **`providerSku` is colon-delimited: `skuId:apiCode:priceId`.** Two-part form (`skuId:apiCode`) is legacy and falls back to vendor lookups for `priceId`. Catalog-linked rows use `providerCatalogId` and store `priceid` in `rawPayload`, skipping the lookup entirely.
- **Customer email is intentionally passed.** FiRoam can be configured to also send their own delivery email on top of ours. Confirm the merchant account setting before changing the customerEmail behaviour.
- **Persisting invalid payloads is deliberate.** When validation fails, we still write an `EsimOrder` row with `status: 'invalid_payload'` and the raw response. Don't `throw`-and-discard — losing the raw response makes vendor-bug investigations impossible.

## Related docs

- `docs/vendors.md` — endpoint reference, request/response shapes
- `docs/sku-mapping.md` — how `providerSku` is parsed
- `docs/env-vars.md` — `FIROAM_*` variables
- `docs/database.md` — `EsimOrder` model

## Future work / known gaps

- FiRoam keeps shipping field-name variants. A dedicated test that throws on "unknown shape" would catch this earlier — currently we only notice when a delivery email arrives without an LPA.
- We don't proactively refresh the token before the 1-hour expiry; we rely on the on-the-fly retry. Acceptable but adds latency to the first provision after expiry.
