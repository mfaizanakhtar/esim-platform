#!/usr/bin/env bash
# status.sh — Show Railway project + deployment status for all services.
# Usage: ./status.sh [service-name]

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/ensure-auth.sh"

SERVICE="${1:-}"

echo ""
echo "════════════════════════════════════════════"
echo "  🚂 Railway Project Status"
echo "════════════════════════════════════════════"
railway status 2>&1
echo ""

echo "── Deployments ──────────────────────────────"
if [[ -n "$SERVICE" ]]; then
  railway deployment list --service "$SERVICE" 2>&1 | head -30
else
  railway deployment list 2>&1 | head -30
fi
