#!/usr/bin/env bash
set -euo pipefail

# ─── Shopify Extension Deploy ────────────────────────────────────────
# Pulls latest main, shows changes, deploys extension to Shopify.
# Run from repo root.

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FE_DIR="$REPO_ROOT/fulfillment-engine"

cd "$REPO_ROOT"

# 1. Record current HEAD before pull
BEFORE=$(git rev-parse HEAD)

# 2. Pull latest main
echo "📥 Pulling latest from origin/main..."
git checkout main 2>/dev/null || true
git pull origin main

AFTER=$(git rev-parse HEAD)

# 3. Show extension changes
if [ "$BEFORE" = "$AFTER" ]; then
  echo ""
  echo "ℹ️  No new changes — already up to date."
  echo ""
else
  echo ""
  echo "📋 Extension changes since last deploy:"
  git log --oneline "$BEFORE..$AFTER" -- fulfillment-engine/extensions/ fulfillment-engine/shopify.app.toml
  echo ""
  git diff --stat "$BEFORE..$AFTER" -- fulfillment-engine/extensions/ fulfillment-engine/shopify.app.toml
  echo ""
fi

# 4. Deploy
echo "🚀 Deploying Shopify extension..."
cd "$FE_DIR"
shopify app deploy --force

echo ""
echo "✅ Deploy complete!"
