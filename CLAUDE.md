# esim-platform — Claude Code Instructions

> Auto-loaded by Claude Code at session start.

## What This Is

eSIM fulfillment platform with Shopify integration. When orders are paid, eSIM credentials are provisioned from FiRoam or TGT Technology vendors and emailed to customers.

**Monorepo (pnpm workspaces):**

| Module | Path | Status |
|--------|------|--------|
| `fulfillment-engine` | [`fulfillment-engine/`](fulfillment-engine/) | ✅ Complete — TypeScript, Fastify, Prisma, pg-boss |
| `dashboard` | [`dashboard/`](dashboard/) | ✅ Complete — React 19 admin UI |

## Start Here

**For system documentation** → read [`docs/`](docs/) — full reference for architecture, APIs, DB schema, vendors, deployment.
**For any backend task** → read [`fulfillment-engine/AGENTS.md`](fulfillment-engine/AGENTS.md) first.
**For monorepo/infra tasks** → read [`AGENTS.md`](AGENTS.md) for deployment and env var contract.
**For active decisions and gotchas** → read [`DECISIONS.md`](DECISIONS.md).

## Non-Negotiable Rules

1. **Never provision eSIM inside the webhook handler** — always enqueue a job
2. **Webhook handler must be idempotent** — check `orderId + lineItemId` before creating a delivery
3. **All vendor API calls happen in worker jobs**, not HTTP handlers
4. **Sensitive data (LPA, activation codes, ICCID) must be encrypted at rest**
5. **Always update `docs/` when making meaningful changes** — see skill below

## Documentation Rule

**Any PR that adds or changes behavior must update the relevant doc in `docs/`.** This includes:
- New or changed API endpoints → `docs/api-admin.md` or `docs/api-public.md`
- Schema changes → `docs/database.md`
- New env vars → `docs/env-vars.md`
- Vendor logic changes → `docs/vendors.md`
- Shopify changes → `docs/shopify.md`
- Worker job changes → `docs/worker-jobs.md`
- Architecture changes → `docs/architecture.md`

Read [`.claude/skills/docs/SKILL.md`](.claude/skills/docs/SKILL.md) for the full documentation guide.

## Skills Available

| Skill | Trigger | How to Use |
|-------|---------|------------|
| Create PR | End of any coding task | Read [`.claude/skills/create-pr/SKILL.md`](.claude/skills/create-pr/SKILL.md) |
| Documentation | After any meaningful code change | Read [`.claude/skills/docs/SKILL.md`](.claude/skills/docs/SKILL.md) |
| Railway | Deployments, logs, env vars | Read [`.claude/skills/railway/SKILL.md`](.claude/skills/railway/SKILL.md) |

## Verify Before Committing

```bash
cd fulfillment-engine && npm run verify
```
