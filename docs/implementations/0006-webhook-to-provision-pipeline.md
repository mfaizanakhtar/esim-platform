# Webhook → Provision pipeline (orders/paid → enqueue)

**ID:** 0006 · **Status:** shipped · **Owner:** backfill
**Shipped:** pre-log · **PRs:** pre-log

## What it does

When Shopify fires `orders/paid`, the webhook handler verifies the HMAC, parses each line item, creates one `EsimDelivery` row per line item (idempotent on `orderId + lineItemId`), pre-generates an `accessToken` so the storefront extension can start polling immediately, fire-and-forgets a `provisioning` metafield write to the order, and enqueues a `provision-esim` pg-boss job per line item. The handler returns `200` quickly so Shopify doesn't retry; all vendor work happens in the worker.

## Why

Shopify webhooks are time-bounded — handlers must respond fast or Shopify retries. Vendor provisioning (FiRoam sync call, TGT async hand-off) can take seconds and may fail transiently, so it has to live in a job with a retry policy, not in the HTTP handler. Splitting the flow this way also means the worker can be scaled independently from the API and we get free per-line-item retry on vendor flakes.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/src/api/webhook.ts` | `POST /webhook/orders/paid` — HMAC, parse, idempotency, enqueue |
| `fulfillment-engine/src/utils/idempotency.ts` | Tiny helper for the canonical `orderId::lineItemId` key |
| `fulfillment-engine/src/shopify/webhooks.ts` | `verifyShopifyWebhook` HMAC check (used by both paid + cancelled handlers) |
| `fulfillment-engine/src/worker/jobs/provisionEsim.ts` | The job this handler enqueues; resolves SKU mappings → vendor → finalize |
| `fulfillment-engine/src/queue/jobQueue.ts` | pg-boss queue init (job retry policy lives in the `queue.send` options) |

## Touchpoints

- Webhook handler (`POST /orders/paid`)
- Worker job: `provision-esim`
- Shopify metafield write (fire-and-forget) so the order-status extension can render "provisioning" immediately
- DB model: `EsimDelivery`
- HMAC verification using `SHOPIFY_CLIENT_SECRET`

## Data model

- `EsimDelivery` row created in `pending` status, with `accessToken` (UUID, used by extension to poll), `topupIccid` (nullable, encrypted) if the line item had an `_iccid` property, and `sku`/`variantId` carried from the line item.
- No new migration tied to this entry — schema details live in `docs/database.md`.

## Gotchas / non-obvious decisions

- **Webhook responds 200 even on internal error.** Returning a non-2xx triggers Shopify retries which would explode the dead-letter pile; we log the error and acknowledge anyway, then rely on the dashboard to surface failures. Don't "fix" this by returning 4xx/5xx.
- **Topic header check.** We accept the same URL being subscribed to multiple Shopify topics — if `x-shopify-topic` isn't `orders/paid` we 200 + `ignored: true` instead of erroring.
- **Idempotency key is `orderId + lineItemId`, not order-level.** A single Shopify order with multiple eSIM line items must produce multiple deliveries, so the unique key has to include the line item.
- **Top-up detection lives here, not in the worker.** Line items carry an `_iccid` property when the customer is buying a top-up; we encrypt and store it on the delivery row at intake. The worker decrypts it later when calling the vendor.
- **One exception to the "no vendor calls in webhook" rule:** we fire-and-forget a `writeDeliveryMetafield` call so the thank-you page can show "eSIM being set up" before the worker even starts. Failures are non-fatal and a brief double-write race with `finalizeDelivery` is harmless because metafield writes are idempotent.
- **Line items with `variant_id: null` are skipped, not failed.** Shipping/discount/free-gift lines hit the same webhook; skipping with a warn log is correct.
- **Retry policy:** `retryLimit: 3, retryDelay: 60s, expireInSeconds: 3600`. Set in `queue.send` options at enqueue time, not in pg-boss config — keep them visible at the call site.

## Related docs

- `docs/api-public.md` — webhook URL + headers
- `docs/shopify.md` — app scopes, webhook registration, HMAC
- `docs/security.md` — HMAC verification details
- `docs/worker-jobs.md` — `provision-esim` job spec
- `docs/database.md` — `EsimDelivery` model

## Future work / known gaps

None known — this part of the pipeline has been stable. If we ever migrate off pg-boss, the only call-site to change is `queue.send` in `webhook.ts` and the symmetric one in `cancelEsim`.
