#!/usr/bin/env bash
# shopify-vars.sh — Set all Shopify-related env vars on the esim-api Railway service.
# Usage:
#   ./shopify-vars.sh \
#     --shop sailesim.myshopify.com \
#     --client-id <id> \
#     --client-secret <secret> \
#     --access-token <shpat_...> \
#     --custom-domain sailesim.com
#
# All flags are optional — only provided flags are updated.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/ensure-auth.sh"

SERVICE="esim-api"

SHOP=""
CLIENT_ID=""
CLIENT_SECRET=""
ACCESS_TOKEN=""
CUSTOM_DOMAIN=""

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --shop)           SHOP="$2";          shift 2 ;;
    --client-id)      CLIENT_ID="$2";     shift 2 ;;
    --client-secret)  CLIENT_SECRET="$2"; shift 2 ;;
    --access-token)   ACCESS_TOKEN="$2";  shift 2 ;;
    --custom-domain)  CUSTOM_DOMAIN="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SHOP$CLIENT_ID$CLIENT_SECRET$ACCESS_TOKEN$CUSTOM_DOMAIN" ]]; then
  echo "Usage: $0 [--shop <domain>] [--client-id <id>] [--client-secret <secret>] [--access-token <shpat_...>] [--custom-domain <domain>]"
  exit 1
fi

echo ""
echo "════════════════════════════════════════════"
echo "  🚂 Updating Shopify vars on: $SERVICE"
echo "════════════════════════════════════════════"

[[ -n "$SHOP" ]]          && railway variable set --service "$SERVICE" "SHOPIFY_SHOP_DOMAIN=$SHOP"             && echo "  ✅ SHOPIFY_SHOP_DOMAIN=$SHOP"
[[ -n "$CLIENT_ID" ]]     && railway variable set --service "$SERVICE" "SHOPIFY_CLIENT_ID=$CLIENT_ID"          && echo "  ✅ SHOPIFY_CLIENT_ID=***"
[[ -n "$CLIENT_SECRET" ]] && railway variable set --service "$SERVICE" "SHOPIFY_CLIENT_SECRET=$CLIENT_SECRET"  && echo "  ✅ SHOPIFY_CLIENT_SECRET=***"
[[ -n "$ACCESS_TOKEN" ]]  && railway variable set --service "$SERVICE" "SHOPIFY_ACCESS_TOKEN=$ACCESS_TOKEN"    && echo "  ✅ SHOPIFY_ACCESS_TOKEN=***"
[[ -n "$CUSTOM_DOMAIN" ]] && railway variable set --service "$SERVICE" "SHOPIFY_CUSTOM_DOMAIN=$CUSTOM_DOMAIN" && echo "  ✅ SHOPIFY_CUSTOM_DOMAIN=$CUSTOM_DOMAIN"

echo ""
echo "✅ Done. Redeploy esim-api and esim-worker to apply:"
echo "   ./.claude/skills/railway/redeploy.sh esim-api"
echo "   ./.claude/skills/railway/redeploy.sh esim-worker"
