# Daypass email validity derived from `daysCount`

**ID:** 0003 · **Status:** shipped · **Owner:** Faizan Akhter
**Shipped:** 2026-04-27 · **PRs:** TBD

## What it does

For daypass orders, the `Validity` line in the customer delivery email is now computed from `ProviderSkuMapping.daysCount` (the same field sent to FiRoam as `daypassDays`) instead of being read from the free-text `validity` column. The two values cannot drift apart — whatever duration was ordered at the vendor is exactly what the email shows. Fixed packages continue to render `validity` verbatim.

## Why

A customer order for `DE-2GB-2D-DAYPASS` (Germany 2GB / 2 days) reached the customer with a delivery email that read `Validity: 1 day`. Investigation showed `ProviderSkuMapping` stores two parallel fields with no link between them: `daysCount` (Int, sent to vendor) and `validity` (free-text String, rendered in email). Either field could be edited independently in the dashboard or by a seed/script, so a row could end up with `daysCount=2` but `validity="1 day"` — the customer would receive a real 2-day eSIM but a misleading email. Eliminating the free-text path for daypass closes that drift class entirely without a schema migration.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/src/worker/jobs/provisionEsim.ts` | Derives `mappingInfo.validity` from `daysCount` for `packageType='daypass'`, falls back to `mapping.validity` for fixed packages. |
| `fulfillment-engine/src/worker/jobs/__tests__/provisionEsim.test.ts` | Three new unit tests: daypass with stale `validity` text, daypass singular `1 day`, fixed package verbatim. |
| `docs/database.md` | `ProviderSkuMapping.validity` and `.daysCount` rows annotated with the new contract. |
| `docs/sku-mapping.md` | "Validity display" note added to the Daypass Packages section. |
| `docs/worker-jobs.md` | New "Email validity field" subsection under `finalize-delivery`. |

## Touchpoints

- Worker job: `provision-esim` (assembles email metadata)
- Worker job: `finalize-delivery` (consumes the metadata; unchanged)
- Email template: `src/services/emailTemplates.ts` (unchanged — still renders the string it's given)
- Vendor adapter: `src/vendor/providers/firoam.ts` (unchanged — still sends `daypassDays = daysCount`)

## Data model

No schema changes. The `validity` String column on `ProviderSkuMapping` is preserved (still authoritative for fixed packages, informational for daypass).

## Gotchas / non-obvious decisions

- The free-text `validity` column is **not** removed for daypass rows. Some downstream views (admin dashboard, mapping-edit forms) may still display it; that's tolerated as informational. Removing it would be a larger UI/dashboard change unrelated to the customer-email correctness fix.
- We deliberately did not introduce a database constraint or trigger to keep `validity` in sync with `daysCount`. The email derivation makes such a constraint unnecessary for the customer-visible path, and a constraint would break legitimate ad-hoc edits in the dashboard.
- Pluralization is hard-coded English (`day` / `days`). The email template is English-only today; revisit when localization lands.
- An optional one-shot SQL audit (in the plan) lets ops find legacy daypass rows where `validity` text disagrees with `daysCount` for cosmetic clean-up. Not required for correctness of the email path.

## Related docs

- `docs/database.md` — `ProviderSkuMapping` reference
- `docs/sku-mapping.md` — daypass matching rules
- `docs/worker-jobs.md` — `finalize-delivery` job

## Future work / known gaps

- Consider a small dashboard read-only badge on daypass mapping rows showing the derived validity, so operators don't get confused by a stale `validity` text field that no longer drives anything for daypass.
- Localization of the `"day"` / `"days"` string when multi-language email rolls out.
