# esim-platform — Claude Code Instructions

> Auto-loaded by Claude Code at session start.

## What This Is

eSIM fulfillment platform with Shopify integration. When orders are paid, eSIM credentials are provisioned from FiRoam or TGT Technology vendors and emailed to customers.

**Monorepo (pnpm workspaces):**

| Module | Path | Status |
|--------|------|--------|
| `fulfillment-engine` | [`fulfillment-engine/`](fulfillment-engine/) | ✅ Complete — TypeScript, Fastify, Prisma, pg-boss |
| `dashboard` | [`dashboard/`](dashboard/) | ⬜ Not yet scaffolded — React 19 admin UI (Phases 6-12) |

## Start Here

**For any backend task** → read [`fulfillment-engine/AGENTS.md`](fulfillment-engine/AGENTS.md) first.
**For monorepo/infra tasks** → read [`AGENTS.md`](AGENTS.md) for deployment and env var contract.
**For active decisions and gotchas** → read [`DECISIONS.md`](DECISIONS.md).

## Non-Negotiable Rules

1. **Never provision eSIM inside the webhook handler** — always enqueue a job
2. **Webhook handler must be idempotent** — check `orderId + lineItemId` before creating a delivery
3. **All vendor API calls happen in worker jobs**, not HTTP handlers
4. **Sensitive data (LPA, activation codes, ICCID) must be encrypted at rest**

## Skills Available

| Skill | Trigger | How to Use |
|-------|---------|------------|
| Create PR | End of any coding task | Read [`.claude/skills/create-pr/SKILL.md`](.claude/skills/create-pr/SKILL.md) |

## Verify Before Committing

```bash
cd fulfillment-engine && npm run verify
```
