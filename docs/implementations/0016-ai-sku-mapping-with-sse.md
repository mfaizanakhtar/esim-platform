# AI SKU mapping with SSE (vector embedding similarity + GPT scoring)

**ID:** 0016 · **Status:** shipped · **Owner:** backfill
**Shipped:** pre-log · **PRs:** pre-log

## What it does

For each unmapped Shopify SKU, the AI mapper (a) embeds the SKU's metadata (title, region, plan), (b) finds the top 20 closest catalog candidates via pgvector cosine distance, (c) feeds those candidates to GPT-4o-mini, which scores them and picks the best. The dashboard `AiMap` page can run this synchronously (`POST /sku-mappings/ai-map`) for small batches or as a long-running `AiMapJob` with SSE streaming (`POST /jobs` + `GET /jobs/:id/stream`) for large catalogs. Drafts are presented for human accept/reject — nothing is auto-applied.

## Why

Manually mapping hundreds of Shopify SKUs to vendor catalog rows is tedious and error-prone. Vendor product names and Shopify titles describe the same thing in different vocabularies (`"Europe 30 Countries"` vs `"EU30 Region Pack"`); a pure-string match fails. Embeddings + GPT close the semantic gap, while the human-in-the-loop accept step prevents bad mappings from ever becoming live `ProviderSkuMapping` rows.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/src/api/admin.ts` (ai-map routes, ~3219-3669) | Sync `POST /sku-mappings/ai-map`, job-based `POST /jobs`, `GET /jobs/:id/stream` |
| `fulfillment-engine/src/services/embeddingService.ts` | OpenAI embedding compute, vector search |
| `fulfillment-engine/prisma/schema.prisma` (`AiMapJob`) | Job state — progress, drafts, warnings, unmatchedSkus |
| `dashboard/src/pages/AiMap.tsx` | UI: launch job, live progress, accept/reject drafts |
| `dashboard/src/hooks/useAiMapJob.ts`, `useAiMapStream.ts` | Job creation + SSE consumption |

## Touchpoints

- DB: `AiMapJob`, `ProviderSkuCatalog` (read for candidates), `ProviderSkuMapping` (created on accept)
- OpenAI: embeddings (`text-embedding-3-small`) + GPT-4o-mini for scoring
- Shopify Admin API: fetched once per job to enumerate unmapped SKUs

## Data model

- `AiMapJob` carries `status` (`running` / `completed` / `error`), `progressTotal`, `progressDone`, `drafts` (JSONB), `unmatchedSkus` (JSONB), `warnings` (JSONB).
- Drafts persisted to the job; not converted to `ProviderSkuMapping` until the operator clicks Accept.

## Gotchas / non-obvious decisions

- **No hard similarity threshold in the embedding query.** Top 20 by cosine distance always go to GPT, even if all are mediocre. GPT's confidence call is the only quality gate. Want a hard floor? Add it in the generator or the SQL — it's not there today.
- **SSE `: heartbeat` every 15s prevents proxy/CDN timeouts but doesn't imply progress.** A stalled job emits heartbeats forever. The dashboard distinguishes "still working" from "complete" by the explicit `done` event, not heartbeat presence.
- **Polling loop never times out.** The job-stream endpoint reads `AiMapJob` every 2s and pushes events until `reply.raw.destroyed` (client disconnect). If the client crashes without disconnect, the loop runs until the app restarts. There's no idle-timeout.
- **The synchronous `POST /sku-mappings/ai-map` collects ALL drafts before responding.** Large runs (thousands of SKUs) can OOM or hit response-size limits. Always use the job + SSE path for large catalogs.
- **Shopify API failure is fatal and unretryable mid-job.** A `'shopify_unavailable'` throw aborts the run — the job goes `status: 'error'`. No automatic retry; operator re-runs after Shopify recovers.
- **`unmatchedSkus` is only populated when there were no warnings.** If any warning fires (quota, API error), we don't list the un-evaluated SKUs as "unmatched" because we can't tell which ones were actually evaluated. Operators see "warning, drafts may be incomplete" and re-run.
- **REGION SKUs apply strict-coverage *before* GPT.** For `kind === 'REGION'`, the candidate query filters with JSONB containment (`countryCodes @> region.countryCodes`) so GPT only ranks fully-covering catalog rows. If `Region` row is missing or has empty `countryCodes`, the draft list is empty — *not* "any global plan". This is intentional: don't sell a region SKU backed by partial coverage.
- **`relaxOptions` (validity / data / region) only relax the *post-filter* hard rules, not the embedding similarity threshold.** A confident GPT pick can be rejected by the post-filter if the catalog row violates type-parity or coverage. Toggling relax options doesn't change which embeddings come back.
- **Drafts are not idempotent across re-runs.** Re-running on the same SKU produces a fresh draft list; if you've already accepted a mapping, the new draft is duplicate-prevented at *accept* time, not at draft-create time.
- **Cost-aware ranking lives in the matcher, not in GPT.** Among GPT-approved candidates, the matcher ranks by `netPrice` (cheapest first). Don't ask GPT to reason about price — feed it candidates already filtered by coverage/spec, then sort by price.

## Related docs

- `docs/sku-mapping.md` — AI matching surface
- `docs/api-admin.md` — `/sku-mappings/ai-map`, `/jobs`, `/jobs/:id/stream`
- `docs/database.md` — `AiMapJob` schema
- `docs/env-vars.md` — `OPENAI_API_KEY`

## Future work / known gaps

- An idle-timeout on the polling loop would prevent runaway DB queries from abandoned jobs.
- Per-SKU progress (which one is being matched right now) isn't surfaced — only `progressDone / progressTotal`. Useful for debugging hangs.
