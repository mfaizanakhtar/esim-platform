# Deployment

**Platform:** Railway
**Project:** `esim_backend`
**Environment:** `production`

---

## Services

| Service | What | Entry Point | URL |
|---------|------|------------|-----|
| `esim-api` | Fastify HTTP + webhooks | `fulfillment-engine/src/server.ts` | `https://api.sailesim.com` |
| `esim-worker` | pg-boss worker | `fulfillment-engine/src/worker/index.ts` | (internal) |
| `Dashboard` | React SPA | `dashboard/dist/` | `https://dashboard.sailesim.com` |
| pg-vector Postgres | Primary DB | — | `postgres-pgvector.railway.internal` |

**Important:** `esim-api` and `esim-worker` share the same codebase. Both must have identical Shopify and vendor env vars.

---

## Railway CLI Skill

Use scripts in `.claude/skills/railway/`:

```bash
# Check status
./.claude/skills/railway/status.sh esim-api

# View logs
./.claude/skills/railway/logs.sh esim-api --lines 50
./.claude/skills/railway/logs.sh esim-api --build --lines 100

# Redeploy
./.claude/skills/railway/redeploy.sh esim-api
./.claude/skills/railway/redeploy.sh esim-worker

# List env vars
./.claude/skills/railway/vars.sh esim-api

# Set env vars
./.claude/skills/railway/vars.sh esim-api KEY=value KEY2=value2

# Update all Shopify vars at once (store migration)
./.claude/skills/railway/shopify-vars.sh \
  --shop sailesim.myshopify.com \
  --client-id <id> \
  --client-secret <secret> \
  --access-token <shpat_...> \
  --custom-domain sailesim.com
```

---

## Deploy Flow

### Standard (auto)
Push to `main` → CI runs → Railway auto-deploys on success.

### Manual redeploy
```bash
./.claude/skills/railway/redeploy.sh esim-api
```

### After changing env vars
- `esim-api` / `esim-worker`: restart is enough (env vars loaded at startup)
- `Dashboard`: **full redeploy required** — `VITE_API_URL` is baked into the Vite bundle at build time

```bash
# Update VITE_API_URL and trigger rebuild
./.claude/skills/railway/vars.sh Dashboard VITE_API_URL=https://api.sailesim.com/admin
./.claude/skills/railway/redeploy.sh Dashboard
```

---

## Database

**Primary:** pg-vector Postgres at `postgres-pgvector.railway.internal`
**`DATABASE_URL`:** Hardcoded connection string in `esim-api` and `esim-worker` vars

**Run migrations after schema changes:**
```bash
cd fulfillment-engine && npm run prisma:migrate
```
Migrations run against the database pointed to by `DATABASE_URL` in your local `.env`.

**Standard Postgres service:** Unused — safe to delete (nothing connects to it). Has attached volume `postgres-volume-BG7A`.

---

## Verify Before Deploying

```bash
cd fulfillment-engine && npm run verify
# Runs: type-check + build + lint + tests

cd dashboard && npm run build
```

---

## Debugging Failures

### Build failed
```bash
./.claude/skills/railway/logs.sh esim-api --build --lines 100
```

### Runtime error
```bash
./.claude/skills/railway/logs.sh esim-api --lines 50
./.claude/skills/railway/logs.sh esim-worker --lines 50
```

### Common patterns

| Error | Cause | Fix |
|-------|-------|-----|
| `Cannot find module` | Missing dep or wrong build command | Check `package.json` |
| `ENOENT dist` | Build didn't produce output | Run `npm run build` locally |
| `invalid value` | Missing or wrong env var | Check vars with `vars.sh` |
| `401` on admin API | Wrong `ADMIN_API_KEY` | Check var on Railway |
| Deliveries not showing | `VITE_API_URL` pointing to old backend | Update + redeploy Dashboard |

---

## Shopify App Deploy

After changing `shopify.app.toml` or any extension code:

```bash
cd fulfillment-engine
shopify app deploy --force
```

Uses `.env` for store + credentials. After deploy, set extension settings in Shopify Admin if needed.
