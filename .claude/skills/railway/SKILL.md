# Skill: Railway Deployment

## Scripts in this skill

| Script | Purpose |
|--------|---------|
| `ensure-auth.sh` | Check Railway auth; opens a Terminal window for `railway login` if needed |
| `status.sh [service]` | Show project + deployment status |
| `logs.sh <service> [--build] [--lines N]` | Fetch deploy or build logs |
| `redeploy.sh <service>` | Trigger a redeploy and tail build logs |
| `vars.sh <service> [KEY=VALUE ...]` | List or set environment variables |

**Service names**: `dashboard`, `fulfillment-engine`

---

**Trigger**: Use this skill whenever the user asks about Railway deployments, build failures, logs, environment variables, or redeploying.

---

## Auth Flow

Every script calls `ensure-auth.sh` first. If not logged in, it:
1. Opens a new macOS Terminal window running `railway login` (browser opens automatically)
2. Polls every 5s (up to 120s) for auth to complete
3. Continues once the user completes the browser flow

The agent does not need to ask the user to login manually — the script handles it.

---

## Common Tasks

### Check why a deployment failed
```bash
./.claude/skills/railway/logs.sh dashboard --build --lines 100
```

### Check live runtime logs
```bash
./.claude/skills/railway/logs.sh dashboard --lines 50
./.claude/skills/railway/logs.sh fulfillment-engine --lines 50
```

### See project + deployment status
```bash
./.claude/skills/railway/status.sh
./.claude/skills/railway/status.sh dashboard
```

### Redeploy after a fix
```bash
./.claude/skills/railway/redeploy.sh dashboard
./.claude/skills/railway/redeploy.sh fulfillment-engine
```

### Check environment variables
```bash
./.claude/skills/railway/vars.sh dashboard
./.claude/skills/railway/vars.sh fulfillment-engine
```

### Set an environment variable
```bash
./.claude/skills/railway/vars.sh dashboard VITE_API_URL=https://your-app.up.railway.app/admin
./.claude/skills/railway/vars.sh fulfillment-engine ADMIN_API_KEY=new-secret
```

---

## Services in This Project

| Railway Service | What It Is | Key Env Vars |
|----------------|-----------|--------------|
| `fulfillment-engine` | Fastify API + pg-boss worker | `DATABASE_URL`, `ADMIN_API_KEY`, `SHOPIFY_*`, `FIROAM_*`, `TGT_*` |
| `dashboard` | React SPA served by `serve` | `VITE_API_URL` (must point to fulfillment-engine Railway URL + `/admin`) |

**Important**: `VITE_API_URL` is a build-time variable for Vite. Changing it in Railway vars requires a **full redeploy** (not just a restart) to take effect.

---

## Agent Debugging Flow

When the user reports a Railway deployment failure:

1. **Get build logs first** — build failures show here:
   ```bash
   ./.claude/skills/railway/logs.sh <service> --build --lines 100
   ```

2. **Look for the error** — common patterns:
   - `Cannot find module` → missing dep or wrong build command
   - `native binding` → platform-specific package issue (`@tailwindcss/oxide`)
   - `ENOENT dist` → build didn't produce output
   - `invalid value` → env var missing or wrong format

3. **Check env vars** if the error mentions a missing config:
   ```bash
   ./.claude/skills/railway/vars.sh <service>
   ```

4. **Fix the code/config**, push to main (Railway auto-deploys on push to main)
   — or trigger manually:
   ```bash
   ./.claude/skills/railway/redeploy.sh <service>
   ```

5. **Tail runtime logs** after successful build to confirm startup:
   ```bash
   ./.claude/skills/railway/logs.sh <service> --lines 30
   ```

---

## Railway Project Link

The repo is linked to Railway via the `railway link` command. If the CLI asks which project/service to link:
- Project: `esim-platform` (or similar)
- Run from the relevant subdirectory (`fulfillment-engine/` or `dashboard/`) to link the right service

To check what's currently linked:
```bash
railway status
```
