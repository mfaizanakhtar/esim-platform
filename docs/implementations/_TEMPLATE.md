# <Feature title>

**ID:** NNNN · **Status:** shipped · **Owner:** <github-handle>
**Shipped:** <YYYY-MM-DD or "in progress"> · **PRs:** #123, #145

## What it does

2–4 sentences. What a user/operator can now do that they couldn't before. Skip marketing language — describe the observable behaviour change.

## Why

The motivating problem. Explain the constraint that forced the design (legal requirement, customer complaint, vendor limitation, performance issue, etc.). Future agents read this to judge whether a workaround is still load-bearing.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/src/...` | … |
| `dashboard/src/...` | … |

One row per file with non-trivial change. Skip trivial touches (formatting, import reorders).

## Touchpoints

Bullet list of subsystems involved. Helpful when an agent is editing one of these and needs to know other features depend on it.

- Webhook handler (`src/api/webhook.ts`)
- Worker job: `provision-esim`
- Shopify extension: `esim-order-status`
- Dashboard page: `…`

## Data model

Schema additions/changes. Reference the migration file by name.

- New model `Foo` with fields `bar`, `baz`
- Migration: `prisma/migrations/<ts>_add_foo/migration.sql`

## Gotchas / non-obvious decisions

The most valuable section. Capture anything a future agent would otherwise re-derive painfully.

- "We deliberately do NOT do X because…"
- "Vendor Y returns Z in this specific shape, so we…"
- "There's a race condition we accept because the upstream rate is < N/s"

## Related docs

Topic-based docs that were updated for this feature.

- `docs/database.md` — schema reference
- `docs/sku-mapping.md` — matching rules
- `docs/shopify.md` — extension behaviour

## Future work / known gaps

Optional. What's intentionally not done, and why.
