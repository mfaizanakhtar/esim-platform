# Implementation Index

Every shipped feature or significant change is recorded here. **Agents: read this file first** to know what already exists in the codebase before starting work — it answers "what has been built?" in one scan.

This index complements the topic-based reference in `docs/` (which describes the system as it is *now*). The index tells you *what was built, when, and why* — the per-feature detail files contain the touchpoints, gotchas, and non-obvious decisions a future agent would otherwise have to re-derive from `git log` and grep.

To add a new entry, copy [`_TEMPLATE.md`](_TEMPLATE.md) to `NNNN-<slug>.md` (use the next free 4-digit ID), fill it in, and add a row to the table below.

Status vocabulary: `in-progress`, `shipped`, `deprecated`, `planned`.

| ID | Feature | Status | Summary | Detail |
|----|---------|--------|---------|--------|
| 0001 | Implementation Log + Enforcement | shipped | Per-feature record system at `docs/implementations/` with three-layer enforcement (CLAUDE.md rule, `create-pr` skill gate, CI guardrail) | [0001-implementation-log.md](0001-implementation-log.md) |
| 0002 | Regional SKU catalog (end-to-end) | shipped | `Region` entity, CRUD, discovery suggestions, REGION template generation, strict-coverage structured + AI mapping, and `/regions` dashboard page with 1-click Accept — full no-curl workflow | [0002-region-schema-crud.md](0002-region-schema-crud.md) |
| 0003 | Daypass email validity from `daysCount` | shipped | Customer email's `Validity` line for daypass packages is derived from `daysCount` (the field sent to FiRoam), eliminating drift between the duration ordered at the vendor and the duration shown to the customer | [0003-daypass-email-validity-from-dayscount.md](0003-daypass-email-validity-from-dayscount.md) |
| 0004 | Update on Shopify (non-destructive sync) | shipped | New dashboard button + endpoint that refreshes image / title / description / prices on already-pushed Shopify products without re-creating SKUs. Also switches flag images to SVG to fix blurry upscale + first-paint lag | [0004-update-on-shopify.md](0004-update-on-shopify.md) |
| 0005 | Resend-email hydrates eSIM details | shipped | `POST /admin/deliveries/:id/resend-email` now looks up the SKU mapping and renders the same `productName / region / dataAmount / validity` box as the original delivery email; helper extracted so resend and provision share one derivation | [0005-resend-email-mapping-metadata.md](0005-resend-email-mapping-metadata.md) |
| 0006 | Webhook → Provision pipeline | shipped (backfill) | `orders/paid` HMAC verify, idempotent per-line-item delivery creation, fire-and-forget `provisioning` metafield, enqueue `provision-esim` (3 retries, 60s delay) — the foundational ingest flow | [0006-webhook-to-provision-pipeline.md](0006-webhook-to-provision-pipeline.md) |
| 0007 | Finalize delivery (encrypt, email, fulfillment, metafield) | shipped (backfill) | Single idempotent first-wins finalize path used by FiRoam sync, TGT poll, and TGT callback. Encrypts payload, sends customer email (delivery or top-up), creates Shopify fulfillment, writes `delivered` metafield | [0007-finalize-delivery-and-email.md](0007-finalize-delivery-and-email.md) |
| 0008 | Cancel eSIM flow | shipped (backfill) | `orders/cancelled` webhook + admin cancel route → `cancel-esim` worker job. Three-branch logic by status, vendor activation check, FiRoam vendor cancel (TGT manual), Shopify note/tag/metafield trail | [0008-cancel-esim-flow.md](0008-cancel-esim-flow.md) |
| 0009 | Multi-eSIM orders across all touchpoints | shipped (backfill) | Status + usage endpoints return per-line-item `deliveries[]`; thank-you extension renders one card per line item; backward-compatible response shape preserved for older deployed clients | [0009-multi-esim-orders.md](0009-multi-esim-orders.md) |
| 0010 | Encryption + idempotency primitives | shipped (backfill) | AES-256-GCM `encrypt`/`decrypt`, HMAC-SHA256 `hashIccid`, three-class error hierarchy (`JobDataError`/`MappingError`/`VendorError`), canonical `orderId::lineItemId` idempotency key | [0010-encryption-and-idempotency-primitives.md](0010-encryption-and-idempotency-primitives.md) |

> **Backfill in progress.** Entries 0006–0010 above are phase 1 of a follow-up plan to record pre-log shipped work. Phases 2–7 will cover vendor integrations, SKU mapping, pricing, dashboard, Shopify storefront, and infra. Backfill entries are reconstructed records (not real-time logs) and tag `Shipped` and `PRs` as `pre-log` in their frontmatter so readers can tell them apart from real-time entries.
