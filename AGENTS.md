# esim-platform — Monorepo

> **For agents:** Read this file first to orient yourself, then read the AGENTS.md in the relevant module.

---

## Modules

| Module | Path | What it does |
|--------|------|-------------|
| **fulfillment-engine** | [`fulfillment-engine/`](fulfillment-engine/) | Node.js backend: Fastify HTTP API, background worker, Shopify webhooks, FiRoam + TGT vendor integrations, Prisma/PostgreSQL |
| **dashboard** | [`dashboard/`](dashboard/) | React admin UI: delivery management, SKU mapping CRUD, provider catalog sync |

For any task, read the relevant module's AGENTS.md first:
- **Backend work** → [`fulfillment-engine/AGENTS.md`](fulfillment-engine/AGENTS.md)
- **Frontend work** → [`dashboard/AGENTS.md`](dashboard/AGENTS.md) *(created in Phase 12)*

---

## Shared Environment Variable Contract

| Variable | Set in | Read by | Purpose |
|----------|--------|---------|---------|
| `ADMIN_API_KEY` | Railway (fulfillment-engine env) | fulfillment-engine | Protects all `/admin/*` routes |
| `VITE_API_URL` | Vercel/Railway (dashboard env) | dashboard | Base URL for admin API, e.g. `https://your-app.up.railway.app/admin` |

The dashboard sends `x-admin-key: <VITE_ADMIN_KEY>` on every request. The value the user types into the dashboard login screen must match `ADMIN_API_KEY` on the server.

---

## Deployment

| Module | Platform | Config |
|--------|----------|--------|
| fulfillment-engine | Railway | Root dir: `fulfillment-engine/` — see [`fulfillment-engine/docs/RAILWAY_DEPLOY.md`](fulfillment-engine/docs/RAILWAY_DEPLOY.md) |
| dashboard | Railway static site or Vercel | Point to `dashboard/` dist output, set `VITE_API_URL` |

---

## Development

Each module manages its own dependencies. Work inside the module directory:

```bash
# fulfillment-engine
cd fulfillment-engine
npm install
npm run dev          # start server
npm test -- --run    # run tests
npm run verify       # full type-check + build + test + lint

# dashboard (once scaffolded)
cd dashboard
npm install
npm run dev          # Vite dev server
npm test -- --run    # run tests
```

---

## Tech Stack Summary

**fulfillment-engine**: TypeScript · Fastify · Prisma · PostgreSQL · pg-boss (job queue) · Vitest · Zod

**dashboard**: TypeScript · React 19 · Vite · React Router v7 · TanStack Query v5 · Zustand v5 · shadcn/ui · Tailwind v4 · React Hook Form · Zod · Vitest (happy-dom + browser mode)

---

## PR / CI

All PRs run `.github/workflows/ci.yml`:
- `test-fulfillment-engine` — type-check + lint + tests + coverage
- `build-fulfillment-engine` — TypeScript build + production smoke test
- `integration-fulfillment-engine` — FiRoam integration tests (skips if secrets not set)
- `test-dashboard` — Vitest unit + browser mode tests *(enabled in Phase 6)*

---

## Migration Status

This monorepo was migrated from `esim_backend` (single-package repo). See the full plan at [`fulfillment-engine/docs/MONOREPO_MIGRATION_PLAN.md`](fulfillment-engine/docs/MONOREPO_MIGRATION_PLAN.md).
