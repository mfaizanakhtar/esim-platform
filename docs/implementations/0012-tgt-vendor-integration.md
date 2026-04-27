# TGT vendor integration (async + polling + callback)

**ID:** 0012 · **Status:** shipped · **Owner:** backfill
**Shipped:** pre-log · **PRs:** pre-log

## What it does

`TgtClient` is the HTTP layer for TGT Technology: token-based auth with a flatten-and-MD5 signature scheme, `createOrder`/`renewOrder`/`createTopup` for provisioning, `queryOrders` for status, and `verifyCallbackSignature` for inbound callbacks. `TgtProvider` adapts a `ProviderSkuMapping` row to the right call (sync `createTopup` for `-C4-` daily packages, async `createOrder`/`renewOrder` for everything else) and decides whether to block-poll or return `pending: true` based on `TGT_FULFILLMENT_MODE`. The `tgt-poll-order` worker job and `POST /webhook/tgt/callback` handler are the two async completion paths; both converge into `finalizeDelivery`.

## Why

TGT does not return credentials synchronously for most product codes — they finish provisioning out-of-band and either let us poll `queryOrders` or push a callback when ready. We need both because: (a) some merchant deployments don't have a public callback URL, (b) callbacks are flaky on TGT's side, so polling is the safety net, (c) different product codes (especially the C4 daypass top-up) actually do return synchronously and shouldn't pay the polling cost. The `polling | callback | hybrid` mode env var lets the same code support all three deployment shapes.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/src/vendor/tgtClient.ts` | HTTP + flatten-MD5 signing + token cache + `verifyCallbackSignature` |
| `fulfillment-engine/src/vendor/tgtSchemas.ts` | Zod schemas; covers `accessToken` vs `token`, `orderInfo` object-or-array, dual `iccid` placement |
| `fulfillment-engine/src/vendor/providers/tgt.ts` | Adapter — C4 vs renewal branching, idempotency keys, blocking vs pending return |
| `fulfillment-engine/src/vendor/tgtConfig.ts` | `getTgtFulfillmentMode`, poll interval, max attempts, callback secret |
| `fulfillment-engine/src/worker/jobs/tgtPoll.ts` | The `tgt-poll-order` job — requeues itself, converges with `finalizeDelivery` |
| `fulfillment-engine/src/api/tgtCallback.ts` | `POST /webhook/tgt/callback` — verifies signature, parses LPA, calls finalize |

## Touchpoints

- Worker jobs: `provision-esim` (calls TGT provider), `tgt-poll-order` (self-requeues), `cancel-esim` (TGT branch)
- HTTP: `POST /webhook/tgt/callback`
- Env vars: `TGT_BASE_URL`, `TGT_ACCOUNT_ID`, `TGT_SECRET`, `TGT_CALLBACK_SECRET` (falls back to `TGT_SECRET`), `TGT_FULFILLMENT_MODE`, `TGT_POLL_INTERVAL_SECONDS`, `TGT_POLL_MAX_ATTEMPTS`
- DB: `EsimDelivery.status` transitions through `provisioning → polling | awaiting_callback | vendor_ordered → delivered | failed`

## Data model

- No TGT-owned tables. TGT does NOT persist orders the way FiRoam does (no `EsimOrder` row). The delivery row is the source of truth, with `vendorReferenceId = orderNo` linking back to TGT.

## Gotchas / non-obvious decisions

- **Signature is `md5(secret + flattenedParams + secret)`, NOT `md5(params + secret)`.** Params are flattened to dotted paths (`orders.0.id`), null/undefined/empty-string skipped, sorted, and concatenated with no separators. Don't change the flattening order or skip rules — the signature breaks.
- **Token field name varies between docs and sandbox.** Docs say `accessToken`, sandbox returns `token`. Both are accepted. Don't tighten the schema.
- **Token re-fetch on error codes `2003`/`2004`.** These mean "token expired"; we transparently retry once with a fresh token. Don't bubble the error to the caller.
- **`createOrder` deliberately omits the `email` field.** TGT will send their own QR-code email if you provide one, which would double-send and confuse customers. Don't add it back even if a future schema reads it.
- **`idempotencyKey` is required on every provision/renew/topup call.** Derived from `deliveryId` (e.g. `topup-${deliveryId}`), with a UUID fallback. Without this, retries double-charge — TGT does NOT dedupe at their end without our key.
- **C4 product codes are synchronous; everything else is async.** `productCode.includes('-C4-')` → `createTopup` returns immediately; `M1`/`C2`/`F2` → `createOrder` or `renewOrder` returns `pending: true`. Don't try to await credentials in the async path.
- **`queryOrders` may return `qrCode` in malformed shape.** The handler expects `LPA:1$smdp$activation`; if it doesn't start with `LPA:` we log and skip rather than throw, so TGT can retry the callback later.
- **Activation code is the third `$`-segment of `qrCode`.** Both the poll job and the callback parse it the same way; if you change one, change both.
- **Callback `orderInfo` may be a single object OR an array.** The handler normalises to array. Don't assume shape.
- **Callback signature exclusion.** The `sign` field is removed from the body before re-signing for verification. Forgetting this gives 401s for valid callbacks.
- **Polling job converges to two terminal states by mode.** `polling` mode at max attempts → `failed`. `hybrid` mode at max attempts → `awaiting_callback` (we still expect TGT to call). Don't collapse these — they have different operational meanings.
- **Polling job exits early if delivery is already `delivered`.** Critical because the callback might land first and finalize; the poll then becomes a no-op.
- **`TGT_CALLBACK_SECRET` falls back to `TGT_SECRET`.** Most deployments use the same secret for both; the fallback exists so a single env var works in dev. Production should set both explicitly.

## Related docs

- `docs/vendors.md` — TGT endpoints, fulfillment modes, callback shape
- `docs/worker-jobs.md` — `tgt-poll-order` job spec
- `docs/api-public.md` — TGT callback endpoint
- `docs/env-vars.md` — `TGT_*` variables

## Future work / known gaps

- TGT has no cancel API — already documented in `0008-cancel-esim-flow`.
- `qrCode` parser is fragile; if TGT ever changes the LPA format, the split-on-`$` breaks. A more lenient regex parser would be safer but hasn't been needed.
- Polling defaults (15s × 8 attempts = 2 min) are tuned for the typical TGT response time. Heavily loaded TGT instances have taken longer; revisit if we see polling-exhausted errors with valid callbacks landing minutes later.
