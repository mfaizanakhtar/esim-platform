# Skill: Run Dev Environment

## Scripts in this skill

| Script | npm script | Purpose |
|--------|------------|---------|
| `dev.sh` | `npm run dev:local` ⭐ **default** | Start backend + worker + dashboard with preflight checks |
| `dev.sh --stop` | `npm run dev:stop` | Kill all running dev servers |

---

**Trigger**: When the user asks to run, start, or restart the local dev environment.

---

## What It Does

1. **Preflight checks** — verifies PostgreSQL is running, `.env` exists, `ADMIN_API_KEY` is set
2. **Auto-installs deps** — runs `npm install` in `fulfillment-engine/` and `dashboard/` if `node_modules` is missing
3. **Generates Prisma client** if missing
4. **Creates `dashboard/.env.local`** pointing `VITE_API_URL` at `http://localhost:3000/admin`
5. **Kills any existing processes** on `:3000` and `:5173`
6. **Starts three processes** in the background with logs to `/tmp/esim-dev-logs/`:
   - `fulfillment-engine` HTTP server (Fastify, port 3000)
   - `fulfillment-engine` pg-boss worker
   - `dashboard` Vite dev server (port 5173)
7. **Waits for ready** — polls both ports before printing the summary

---

## Usage

```bash
npm run dev:local        # Start everything
npm run dev:stop         # Stop everything
```

Or call the script directly:
```bash
./.claude/skills/dev/dev.sh
./.claude/skills/dev/dev.sh --stop
```

---

## Prerequisites

| Requirement | How to fix if missing |
|-------------|----------------------|
| PostgreSQL on `:5432` | `brew services start postgresql@15` |
| `fulfillment-engine/.env` | Copy `fulfillment-engine/.env.example`, fill in values |
| `ADMIN_API_KEY` in `.env` | Set to any string (e.g. `my-local-secret`) |
| `tsconfig-paths` in engine | `cd fulfillment-engine && npm install` (auto-done by script) |

---

## Service Details

| Service | Port | Start command | Log file |
|---------|------|---------------|----------|
| Fastify HTTP server | 3000 | `ts-node-dev -r tsconfig-paths/register src/index.ts` | `/tmp/esim-dev-logs/engine.log` |
| pg-boss worker | — | `ts-node-dev -r tsconfig-paths/register src/worker/index.ts` | `/tmp/esim-dev-logs/worker.log` |
| Vite dashboard | 5173 | `npm run dev` | `/tmp/esim-dev-logs/dashboard.log` |

**Key detail**: `DOTENV_CONFIG_PATH=$REPO_ROOT/.env` is passed to the engine processes because `.env` lives at the repo root, not inside `fulfillment-engine/`. Without this, `dotenv/config` would look for `fulfillment-engine/.env` and find nothing.

**Key detail**: `-r tsconfig-paths/register` is required for `ts-node-dev` to resolve the `~/*` path alias defined in `fulfillment-engine/tsconfig.json`. Without it, imports like `~/server` fail with "Cannot find module".

---

## Logging Into the Dashboard

1. Open http://localhost:5173
2. Enter the value of `ADMIN_API_KEY` from `.env` as the API key
3. The script prints this value in its summary output

---

## Checking Logs

```bash
tail -f /tmp/esim-dev-logs/engine.log     # backend HTTP server
tail -f /tmp/esim-dev-logs/worker.log     # pg-boss worker
tail -f /tmp/esim-dev-logs/dashboard.log  # Vite
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Backend exits immediately | `DOTENV_CONFIG_PATH` wrong, or DB not running | Check `engine.log`, verify `pg_isready` |
| `Cannot find module '~/server'` | `tsconfig-paths/register` missing | `cd fulfillment-engine && npm install` |
| `@tailwindcss/oxide` native binding error | Only on Railway (Linux x64) | Not a local issue; see `dashboard/nixpacks.toml` |
| Dashboard shows blank page | `VITE_API_URL` wrong in `.env.local` | Check `dashboard/.env.local` |
| 401 on dashboard login | `ADMIN_API_KEY` mismatch | Backend and dashboard must use same key |
| Port already in use | Previous session still running | `npm run dev:stop` then retry |
