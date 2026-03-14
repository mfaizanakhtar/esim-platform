#!/usr/bin/env bash
# redeploy.sh — Trigger a redeploy for a Railway service.
# Usage: ./redeploy.sh <service>
#   service : dashboard | fulfillment-engine

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/ensure-auth.sh"

SERVICE="${1:-}"
if [[ -z "$SERVICE" ]]; then
  echo "Usage: $0 <service>"
  echo "  Services: dashboard, fulfillment-engine"
  exit 1
fi

echo "🚀 Redeploying '$SERVICE' on Railway..."
railway redeploy --service "$SERVICE" --yes 2>&1

echo ""
echo "⏳ Waiting 5s then fetching latest logs..."
sleep 5
bash "$(dirname "${BASH_SOURCE[0]}")/logs.sh" "$SERVICE" --build --lines 60
