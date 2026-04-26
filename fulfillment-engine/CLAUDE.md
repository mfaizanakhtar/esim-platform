# fulfillment-engine — Claude Code Instructions

> Auto-loaded by Claude Code when working in this directory.
> For full context, read [`AGENTS.md`](AGENTS.md).

## Quick Commands

```bash
npm run dev          # Start API + worker (ts-node-dev)
npm test -- --run    # Run all tests once
npm run verify       # Full check: type-check + build + lint + tests (run this before committing)
npm run prisma:generate  # Regenerate Prisma client after schema changes
npm run prisma:migrate   # Apply pending migrations
```

## Before You Start

Scan [`../docs/implementations/INDEX.md`](../docs/implementations/INDEX.md) to see what's already shipped — saves you from re-deriving the picture from `git log`.

## Critical Rules

- **Never provision eSIM in webhook handler** — enqueue `provision-esim` job instead
- **Always check `orderId + lineItemId`** before creating an `EsimDelivery` (idempotency)
- **Encrypt all eSIM credentials** (LPA, activation code, ICCID) before storing in DB
- **All vendor calls in worker jobs** — never in HTTP route handlers
- **Use Zod** for all external API response validation (FiRoam, TGT, Shopify)
- **Use `z.coerce.number()` and `.nullable().optional()`** for all Shopify webhook fields
- **PRs that change behaviour must update [`../docs/implementations/`](../docs/implementations/)** — the create-pr skill blocks otherwise (`[skip-impl-log]` to bypass for refactors/fixes)

## Key Files

| File | Purpose |
|------|---------|
| `src/api/webhook.ts` | Shopify orders/paid webhook handler |
| `src/worker/jobs/provisionEsim.ts` | Main eSIM provisioning job |
| `src/vendor/types.ts` | VendorProvider interface contract |
| `src/vendor/registry.ts` | Provider discovery by SKU |
| `prisma/schema.prisma` | Database models |
| `src/utils/errors.ts` | Error hierarchy (retryable vs non-retryable) |

## Skills

| Skill | How to Use |
|-------|------------|
| Create PR | `npm run pr:create "feat: description"` — see [`../.claude/skills/create-pr/SKILL.md`](../.claude/skills/create-pr/SKILL.md) |
