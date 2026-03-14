#!/usr/bin/env bash
# logs.sh — Stream or fetch Railway logs for a service.
# Usage: ./logs.sh <service> [--build] [--lines N]
#   service : dashboard | fulfillment-engine (or any Railway service name)
#   --build : show build logs instead of deploy logs
#   --lines : number of lines to fetch (default 100)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/ensure-auth.sh"

SERVICE="${1:-}"
if [[ -z "$SERVICE" ]]; then
  echo "Usage: $0 <service> [--build] [--lines N]"
  echo "  Services: dashboard, fulfillment-engine"
  exit 1
fi
shift

BUILD_FLAG=""
LINES=100

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) BUILD_FLAG="--build"; shift ;;
    --lines)
      if [[ $# -lt 2 || ! "$2" =~ ^[0-9]+$ || "$2" -lt 1 ]]; then
        echo "Invalid --lines value. Expected a positive integer." >&2; exit 1
      fi
      LINES="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo ""
echo "════════════════════════════════════════════"
echo "  🚂 Railway Logs: $SERVICE ${BUILD_FLAG:+(build)}"
echo "════════════════════════════════════════════"

railway logs --service "$SERVICE" $BUILD_FLAG 2>&1 | tail -"$LINES"
