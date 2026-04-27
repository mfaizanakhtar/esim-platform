# Resend-email handler hydrates eSIM details from SKU mapping

**ID:** 0005 · **Status:** shipped · **Owner:** Faizan Akhter
**Shipped:** 2026-04-27 · **PRs:** TBD

## What it does

`POST /admin/deliveries/:id/resend-email` now looks up the highest-priority active `ProviderSkuMapping` for the delivery's `sku` and passes `productName / region / dataAmount / validity` to the email template, so the resent email renders the same "eSIM Details" box the original delivery email did. For daypass mappings the validity is derived from `daysCount` (the same rule already used at provision time, now extracted into a shared helper).

## Why

A customer-facing bug for order #1014 surfaced that the resend path wasn't symmetrical with the provision path: the original provision email's `Validity` line was rendered from the SKU mapping, but the resend handler only passed `{ to, orderNumber, esimPayload }` — so the email template's entire details box (which is conditional on at least one of `region / dataAmount / validity` being present) silently dropped out on resends. After landing the systemic provision-time fix in #234 (validity derived from `daysCount` for daypass), a resend would still produce a stripped email with no details box at all, defeating the point of the fix for any customer who needs a re-delivery. This change makes the two paths produce identical-looking emails, and reuses the same derivation rule via a small helper so they cannot drift in future.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/src/utils/mappingDisplay.ts` | New. Exports `buildEmailMetadataFromMapping(mapping)` — single source of truth for daypass-vs-fixed validity derivation. |
| `fulfillment-engine/src/api/admin.ts` | `/deliveries/:id/resend-email` looks up the mapping by `delivery.sku` (priority asc, isActive=true) and passes derived metadata into `sendDeliveryEmail`. |
| `fulfillment-engine/src/worker/jobs/provisionEsim.ts` | Refactor: replaces the inline derivation introduced in #234 with the shared helper. |
| `fulfillment-engine/src/utils/__tests__/mappingDisplay.test.ts` | New. Unit-tests the helper across daypass/fixed and edge cases. |
| `fulfillment-engine/src/api/__tests__/admin.test.ts` | New tests: resend hydrates details from a daypass mapping; resend with no SKU skips the lookup. |
| `docs/api-admin.md` | Documents the resend endpoint's mapping-hydration behaviour. |

## Touchpoints

- Worker job: `provision-esim` (now consumes the shared helper)
- Admin HTTP route: `POST /admin/deliveries/:id/resend-email`
- Email service: `sendDeliveryEmail` (unchanged — already accepted the optional fields)

## Data model

No schema changes.

## Gotchas / non-obvious decisions

- The mapping lookup is best-effort: if `delivery.sku` is null, or no active mapping exists for it, the email is sent without the Details box (the previous behaviour) rather than failing the resend. This preserves the resend's job of getting the QR code in front of the customer above all else.
- Mapping lookup uses `findFirst` with `orderBy: { priority: 'asc' }` — same priority semantics as the provision-time path (`provisionEsim.ts:80-83`), so failover-aware seeds don't surprise the resend.
- The helper accepts a `Pick<>` of the mapping shape, not the full row, so future call sites (Shopify metafield writes, dashboard previews, etc.) can reuse it without dragging in the whole Prisma type.

## Related docs

- `docs/api-admin.md` — resend endpoint
- `docs/sku-mapping.md` — daypass display rule (set in #234)
- `docs/worker-jobs.md` — provision-time email metadata assembly

## Future work / known gaps

- The dashboard mapping editor still shows the legacy `validity` text column for daypass rows; for daypass it's informational only now. A small read-only badge showing the derived value would prevent operator confusion.
