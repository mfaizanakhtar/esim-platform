#!/usr/bin/env bash
# dev.sh — Start fulfillment-engine + dashboard locally
# Usage: ./dev.sh [--stop]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../" && pwd)"
ENGINE_DIR="$REPO_ROOT/fulfillment-engine"
DASHBOARD_DIR="$REPO_ROOT/dashboard"
LOG_DIR="/tmp/esim-dev-logs"
ENGINE_LOG="$LOG_DIR/engine.log"
WORKER_LOG="$LOG_DIR/worker.log"
DASHBOARD_LOG="$LOG_DIR/dashboard.log"
PID_FILE="$LOG_DIR/pids"

# ── Stop mode ─────────────────────────────────────────────────────────────────

if [[ "${1:-}" == "--stop" ]]; then
  if [[ -f "$PID_FILE" ]]; then
    echo "🛑 Stopping dev servers..."
    while IFS= read -r pid; do
      kill "$pid" 2>/dev/null && echo "   killed PID $pid" || true
    done < "$PID_FILE"
    rm -f "$PID_FILE"
    echo "✅ Stopped."
  else
    echo "ℹ️  No PID file found — servers may not be running."
    # Kill by port as fallback
    lsof -ti:3000 | xargs kill -9 2>/dev/null || true
    lsof -ti:5173 | xargs kill -9 2>/dev/null || true
    echo "✅ Killed any processes on :3000 and :5173."
  fi
  exit 0
fi

# ── Preflight checks ──────────────────────────────────────────────────────────

echo "🔍 Running preflight checks..."

# 1. PostgreSQL
if ! pg_isready -h localhost -p 5432 -q 2>/dev/null; then
  echo "❌ PostgreSQL is not running on localhost:5432."
  echo "   Start it with: brew services start postgresql@15  (or your version)"
  exit 1
fi
echo "   ✅ PostgreSQL running"

# 2. Root .env
if [[ ! -f "$REPO_ROOT/.env" ]]; then
  echo "❌ Missing $REPO_ROOT/.env"
  echo "   Copy .env.example and fill in values."
  exit 1
fi
echo "   ✅ .env found"

# 3. ADMIN_API_KEY set
ADMIN_API_KEY=$(grep -E '^ADMIN_API_KEY=' "$REPO_ROOT/.env" | cut -d= -f2- | tr -d '[:space:]' | sed 's/#.*//')
if [[ -z "$ADMIN_API_KEY" ]]; then
  echo "❌ ADMIN_API_KEY is blank in .env — set it to any string to use the dashboard."
  exit 1
fi
echo "   ✅ ADMIN_API_KEY is set"

# 4. fulfillment-engine deps
if [[ ! -d "$ENGINE_DIR/node_modules" ]]; then
  echo "📦 Installing fulfillment-engine dependencies..."
  (cd "$ENGINE_DIR" && npm install)
fi

# 5. Prisma client
if [[ ! -d "$ENGINE_DIR/node_modules/.prisma/client" ]]; then
  echo "🔧 Generating Prisma client..."
  (cd "$ENGINE_DIR" && npx prisma generate)
fi

# 6. dashboard deps
if [[ ! -d "$DASHBOARD_DIR/node_modules" ]]; then
  echo "📦 Installing dashboard dependencies..."
  (cd "$DASHBOARD_DIR" && npm install)
fi

# 7. dashboard .env.local
if [[ ! -f "$DASHBOARD_DIR/.env.local" ]]; then
  echo "VITE_API_URL=http://localhost:3000/admin" > "$DASHBOARD_DIR/.env.local"
  echo "   ✅ Created dashboard/.env.local (VITE_API_URL=http://localhost:3000/admin)"
fi

# ── Kill anything already on our ports ────────────────────────────────────────

lsof -ti:3000 | xargs kill -9 2>/dev/null || true
lsof -ti:5173 | xargs kill -9 2>/dev/null || true

# ── Start services ─────────────────────────────────────────────────────────────

mkdir -p "$LOG_DIR"
> "$PID_FILE"

echo ""
echo "🚀 Starting services..."

# fulfillment-engine HTTP server
(cd "$ENGINE_DIR" && DOTENV_CONFIG_PATH="$REPO_ROOT/.env" \
  node_modules/.bin/ts-node-dev --respawn --transpile-only \
  -r tsconfig-paths/register src/index.ts \
  > "$ENGINE_LOG" 2>&1) &
echo $! >> "$PID_FILE"

# fulfillment-engine worker
(cd "$ENGINE_DIR" && DOTENV_CONFIG_PATH="$REPO_ROOT/.env" \
  node_modules/.bin/ts-node-dev --respawn --transpile-only \
  -r tsconfig-paths/register src/worker/index.ts \
  > "$WORKER_LOG" 2>&1) &
echo $! >> "$PID_FILE"

# dashboard Vite dev server
(cd "$DASHBOARD_DIR" && npm run dev > "$DASHBOARD_LOG" 2>&1) &
echo $! >> "$PID_FILE"

# ── Wait for services to be ready ─────────────────────────────────────────────

echo "   Waiting for backend on :3000..."
for i in $(seq 1 30); do
  if curl -s http://localhost:3000/health -o /dev/null 2>/dev/null; then
    echo "   ✅ Backend ready"
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "   ❌ Backend did not start in 30s. Check logs: $ENGINE_LOG"
    exit 1
  fi
  sleep 1
done

echo "   Waiting for dashboard on :5173..."
for i in $(seq 1 20); do
  if curl -s http://localhost:5173 -o /dev/null 2>/dev/null; then
    echo "   ✅ Dashboard ready"
    break
  fi
  if [[ $i -eq 20 ]]; then
    echo "   ❌ Dashboard did not start in 20s. Check logs: $DASHBOARD_LOG"
    exit 1
  fi
  sleep 1
done

# ── Print summary ──────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════"
echo "  ✅ Dev environment running"
echo "════════════════════════════════════════════════"
echo "  Backend  → http://localhost:3000"
echo "  Dashboard → http://localhost:5173"
echo ""
echo "  Login with API key: $ADMIN_API_KEY"
echo ""
echo "  Logs:"
echo "    Backend server : $ENGINE_LOG"
echo "    Backend worker : $WORKER_LOG"
echo "    Dashboard      : $DASHBOARD_LOG"
echo ""
echo "  Stop: npm run dev:stop"
echo "════════════════════════════════════════════════"
