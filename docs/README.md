# eSIM Platform — Documentation

> Auto-maintained. **Always update the relevant doc when making code changes.** See [`.claude/skills/docs/SKILL.md`](../.claude/skills/docs/SKILL.md) for the documentation skill.

## Index

| Document | What It Covers |
|----------|----------------|
| [architecture.md](architecture.md) | System overview, services, data flow |
| [api-admin.md](api-admin.md) | All `/admin/*` endpoints (CRUD, AI mapping, catalog) |
| [api-public.md](api-public.md) | Public endpoints (usage tracking, delivery polling) |
| [database.md](database.md) | Prisma schema — all models and fields |
| [env-vars.md](env-vars.md) | Every environment variable with purpose and example |
| [vendors.md](vendors.md) | FiRoam and TGT Technology integration details |
| [shopify.md](shopify.md) | Webhooks, UI extension, theme, store migration |
| [sku-mapping.md](sku-mapping.md) | SKU mapping system — manual, AI, structured |
| [worker-jobs.md](worker-jobs.md) | Background job types, retry policies, flow |
| [deployment.md](deployment.md) | Railway services, deploys, env var changes |
| [security.md](security.md) | Encryption, HMAC verification, admin auth |

## Quick Reference

**Stack:** TypeScript · Fastify · Prisma · PostgreSQL (pgvector) · pg-boss · React 19 · Vite · Railway

**Services:**
- `esim-api` → `https://api.sailesim.com` — Fastify HTTP server + webhooks
- `esim-worker` → background worker (same codebase, different entry point)
- `Dashboard` → `https://dashboard.sailesim.com` — React admin UI

**Non-negotiable rules:**
1. Never provision eSIM in the webhook handler — always enqueue a job
2. Webhook handler must be idempotent — check `orderId + lineItemId`
3. All vendor API calls happen in worker jobs, not HTTP handlers
4. Encrypt all eSIM credentials (LPA, activation code, ICCID) before storing
