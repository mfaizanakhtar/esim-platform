#!/usr/bin/env bash
# vars.sh — List or set Railway environment variables for a service.
# Usage:
#   ./vars.sh <service>                        # list all vars
#   ./vars.sh <service> KEY=VALUE              # set a variable
#   ./vars.sh <service> KEY=VALUE KEY2=VALUE2  # set multiple

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/ensure-auth.sh"

SERVICE="${1:-}"
if [[ -z "$SERVICE" ]]; then
  echo "Usage: $0 <service> [KEY=VALUE ...]"
  echo "  Services: dashboard, fulfillment-engine"
  exit 1
fi
shift

if [[ $# -eq 0 ]]; then
  echo ""
  echo "════════════════════════════════════════════"
  echo "  🚂 Railway Variables: $SERVICE"
  echo "════════════════════════════════════════════"
  railway variables --service "$SERVICE" 2>&1
else
  for kv in "$@"; do
    KEY="${kv%%=*}"
    VALUE="${kv#*=}"
    echo "Setting $KEY on $SERVICE..."
    railway variables --service "$SERVICE" --set "$KEY=$VALUE" 2>&1
  done
  echo "✅ Variables updated. A redeploy may be needed."
fi
