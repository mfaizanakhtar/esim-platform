# Cancel eSIM flow (Shopify cancel webhook + admin cancel + worker job)

**ID:** 0008 · **Status:** shipped · **Owner:** backfill
**Shipped:** pre-log · **PRs:** pre-log

## What it does

Two entry points enqueue the same `cancel-esim` worker job: the Shopify `orders/cancelled` webhook (for every non-terminal delivery on the cancelled order) and the dashboard's `POST /admin/deliveries/:id/cancel` (with optional `refund: true`). The job inspects each delivery's status and provider, asks the vendor whether the customer has already activated the eSIM, cancels with the vendor when possible, updates the DB, writes a `cancelled`/`failed` metafield + Shopify order note + tag, and (if `refund=true`) calls `cancelShopifyOrder`. FiRoam supports cancel via API; TGT does not, so TGT cancellations mark the delivery `cancelled` in our DB and tag the order `esim-tgt-manual-cancel-needed`.

## Why

Customers cancel orders. We need a single, idempotent path that handles three different starting states (not-yet-provisioned / provisioned-not-activated / activated), respects vendor differences (FiRoam has a cancel API, TGT doesn't), and leaves a clear audit trail on the Shopify order so support can see what was auto-handled vs what needs a human.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/src/api/webhook.ts` | `POST /webhook/orders/cancelled` — finds non-terminal deliveries, enqueues `cancel-esim` per delivery |
| `fulfillment-engine/src/api/admin.ts` (`POST /deliveries/:id/cancel`) | Admin trigger with optional `refund` flag |
| `fulfillment-engine/src/worker/jobs/cancelEsim.ts` | The job — vendor activation check, vendor cancel, DB + Shopify side effects |
| `fulfillment-engine/src/vendor/firoamClient.ts` | `queryEsimOrder`, `cancelOrder` |
| `fulfillment-engine/src/vendor/tgtClient.ts` | `queryOrders` (TGT has no cancel API) |
| `fulfillment-engine/src/shopify/client.ts` | `writeDeliveryMetafield`, `appendOrderNote`, `addOrderTags`, `cancelShopifyOrder` |

## Touchpoints

- Webhook: `orders/cancelled`
- Admin route: `POST /admin/deliveries/:id/cancel`
- Worker job: `cancel-esim` (retryLimit 2)
- DB: `EsimDelivery.status` transitions to `cancelled` or stays `delivered` with `lastError` set if blocked
- Shopify: metafield, order note, tags (`esim-cancelled`, `esim-cancel-failed`, `esim-activated`, `esim-tgt-manual-cancel-needed`)
- Vendors: FiRoam (active query + cancel), TGT (active query only)

## Data model

- Writes only to existing fields: `EsimDelivery.status`, `lastError`. No new tables/columns for this flow.
- Audit trail lives on the Shopify order (note + tags), not in our DB.

## Gotchas / non-obvious decisions

- **Three branches by status, not by provider.** First branch: `cancelled`/`failed` → idempotent skip. Second: not-yet-`delivered` → mark cancelled, no vendor call. Third: `delivered` → vendor flow. Provider switching only happens inside the third branch.
- **Activation check is mandatory before vendor cancel.** If FiRoam shows `usedMb > 0` or `beginDate` set, or TGT shows `profileStatus`/`activatedStartTime`, we leave the delivery `delivered`, set `lastError: 'cancel_blocked: already activated'`, and tag the order `esim-activated` for human review. Auto-cancelling an activated eSIM is wrong — the customer has used data we can't refund.
- **TGT has no cancel API.** We mark our DB `cancelled` and tag `esim-tgt-manual-cancel-needed` so support remembers to cancel in the TGT portal. Don't try to call a `tgt.cancel(...)` — it doesn't exist.
- **Refund is an opt-in flag, not the default.** `cancelShopifyOrder` is only called when the caller passed `refund: true`. The Shopify `orders/cancelled` webhook does NOT pass `refund: true` because the merchant has already cancelled in Shopify; the admin route exposes the flag.
- **Refund failure is non-fatal and surfaces via `lastError`.** A failed `cancelShopifyOrder` writes `refund_failed: <msg>` on the delivery (best-effort) but does not throw. The eSIM is already cancelled with the vendor at that point; refund is a Shopify-side concern.
- **Note/tag writes are non-fatal everywhere.** Every Shopify write inside this job is wrapped in try/catch with a warn-log. Losing a tag is much better than throwing and triggering a retry that re-cancels with the vendor.
- **`writeOutcome` helper centralises metafield + note + tags.** Use it for any new outcome path so all three side effects stay in sync.

## Related docs

- `docs/worker-jobs.md` — `cancel-esim` job spec
- `docs/api-admin.md` — `POST /deliveries/:id/cancel`
- `docs/api-public.md` — `orders/cancelled` webhook
- `docs/vendors.md` — FiRoam cancel API, TGT cancel limitation
- `docs/shopify.md` — order tags vocabulary

## Future work / known gaps

- TGT cancel automation depends on TGT shipping a cancel endpoint; until then, the `esim-tgt-manual-cancel-needed` tag is the workflow.
- FiRoam refund + cancel race: if the customer activates between our activation check and our cancel call, FiRoam's response shape is the source of truth (we trust their cancel response). Hasn't been observed in practice.
