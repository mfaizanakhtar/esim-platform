# Finalize delivery (encrypt, email, fulfillment, metafield)

**ID:** 0007 · **Status:** shipped · **Owner:** backfill
**Shipped:** pre-log · **PRs:** pre-log

## What it does

`finalizeDelivery` is the single idempotent function that closes a delivery once vendor credentials are in hand. It encrypts the eSIM payload, writes it to the `EsimDelivery` row in a first-wins update (`status != 'delivered'`), sends the customer email (delivery email, or a top-up variant if the line item carried an `_iccid`), creates the Shopify fulfillment, and writes the `delivered` metafield to the order. It is called from `provisionEsim` (sync FiRoam path), the TGT poll job, and the TGT callback handler — all converge here so each path gets the same side effects exactly once.

## Why

Vendors deliver credentials through three different channels (FiRoam synchronous response, TGT polling, TGT callback). Without a shared finalize path each channel would have its own "now send the email and fulfill the order" copy, and any one of them could double-send if a job retried. The first-wins `updateMany({ where: { status != 'delivered' } })` makes "already finalized" a database-level check, so retries from any path are safe.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/src/worker/jobs/finalizeDelivery.ts` | The function — payload encryption, first-wins write, email, fulfillment, metafield |
| `fulfillment-engine/src/services/email.ts` | `sendDeliveryEmail`, `sendTopupEmail`, `recordDeliveryAttempt`; Resend + QR + PDF |
| `fulfillment-engine/src/services/emailTemplates.ts` | HTML/text builders, LPA → SM-DP+ parser |
| `fulfillment-engine/src/shopify/client.ts` | `createFulfillment`, `writeDeliveryMetafield` |
| `fulfillment-engine/src/utils/crypto.ts` | `encrypt`/`decrypt` (AES-256-GCM), `hashIccid` (HMAC-SHA256) |

## Touchpoints

- Worker jobs: `provision-esim` (sync FiRoam), `tgt-poll-order`, TGT callback handler all call `finalizeDelivery`
- DB model: `EsimDelivery` (`payloadEncrypted`, `iccidHash`, `accessToken`, `status`)
- DB model: `DeliveryAttempt` (audit trail per email send)
- Resend (email provider) + Shopify Admin GraphQL (fulfillment + metafield)
- Storefront extension: reads the `delivered` metafield to render LPA + QR

## Data model

- Writes: `EsimDelivery.payloadEncrypted`, `iccidHash`, `accessToken`, `status='delivered'`, `vendorReferenceId`, optional `provider`.
- Inserts: one `DeliveryAttempt` row per email send (`channel: 'email'`, status string).
- No new migration — schema reference in `docs/database.md`.

## Gotchas / non-obvious decisions

- **First-wins is the idempotency primitive.** `updateMany({ where: { id, status: { not: 'delivered' } } })` returning `count: 0` is the signal that another path already finalized; we early-return `{ ok: true, alreadyDone: true }` and skip every side effect. Don't change this to `update({ where: { id } })` — that breaks idempotency under concurrent finalize calls.
- **ICCID is resolved before payload encryption.** For top-up deliveries the vendor doesn't return an ICCID, so we fall back to the stored encrypted `topupIccid`. Whatever ICCID we resolve is then used uniformly for `payloadEncrypted`, `iccidHash`, the email body, and the metafield.
- **`accessToken` is reused, not regenerated.** The webhook pre-generated a UUID at intake and the storefront extension is already polling that token; finalize must keep it consistent. Only generate a fresh UUID for legacy pre-token deliveries (defensive fallback).
- **Top-up vs new-eSIM email branching.** `delivery.topupIccid != null` flips the email path to `sendTopupEmail` (no LPA/QR — the top-up just adds data to an existing eSIM) and the metafield to `{ status: 'delivered', isTopup: true }`. The order extension renders differently for these.
- **Email failure is recorded but not thrown.** A failed email writes `failed:<reason>` to `DeliveryAttempt` and logs an error, but `finalizeDelivery` still returns `{ ok: true }` and the side-effects continue. Re-sending is a manual action from the dashboard.
- **Shopify fulfillment + metafield failures are also non-fatal.** Email already went out and the eSIM is delivered; the order will show as unfulfilled in Shopify until the merchant retries from the dashboard, but the customer is not blocked.
- **`SHOPIFY_CUSTOM_DOMAIN` is read at module load.** Default is `sailesim.com`. Used to build the usage-page URL embedded in both the email and the metafield.

## Related docs

- `docs/worker-jobs.md` — finalize is documented as the convergence point for all three vendor channels
- `docs/database.md` — `EsimDelivery` and `DeliveryAttempt` schemas
- `docs/security.md` — encryption + ICCID hashing
- `docs/shopify.md` — metafield shape, fulfillment endpoint

## Future work / known gaps

- Email retry currently happens by re-running the worker job or hitting the dashboard "resend email" action; there's no automatic retry for transient Resend failures. Could be added but hasn't been needed.
