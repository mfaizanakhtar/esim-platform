#!/usr/bin/env bash
# =============================================================================
# agent-pr-merge.sh — Re-poll CI for an existing PR, then squash-merge.
#
# Used by the agent AFTER it has fixed CodeRabbit issues and pushed:
#
#   git add -A
#   git commit -m "review: address CodeRabbit feedback"
#   git push origin <branch>
#   ./.claude/skills/create-pr/agent-pr-merge.sh <PR_NUMBER> "<COMMIT_MSG>"
#
# Usage:
#   agent-pr-merge.sh <PR_NUMBER> "<commit message for squash>"
# =============================================================================

set -euo pipefail

PR_NUMBER="${1:-}"
COMMIT_MSG="${2:-}"

if [ -z "$PR_NUMBER" ] || [ -z "$COMMIT_MSG" ]; then
  echo "❌ Usage: $0 <PR_NUMBER> \"<commit message>\""
  exit 1
fi

PR_URL=$(gh pr view "$PR_NUMBER" --json url -q .url 2>/dev/null || echo "(unknown)")

# ── Poll CI checks ────────────────────────────────────────────────────────────
POLL_INTERVAL=15
MAX_POLLS=40   # 40 × 15s = 10 min
POLL_COUNT=0
NO_CHECKS_COUNT=0

echo "⏳ Polling CI checks for PR #${PR_NUMBER} (every ${POLL_INTERVAL}s, max $((MAX_POLLS * POLL_INTERVAL))s)..."

while [ $POLL_COUNT -lt $MAX_POLLS ]; do
  sleep $POLL_INTERVAL

  CHECKS=$(gh pr checks "$PR_NUMBER" --json name,bucket,link 2>/dev/null || echo "[]")

  TOTAL=$(echo "$CHECKS" | python3 -c \
    "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

  if [ "$TOTAL" = "0" ]; then
    NO_CHECKS_COUNT=$((NO_CHECKS_COUNT + 1))
    if [ $NO_CHECKS_COUNT -ge 3 ]; then
      echo "ℹ️  No CI checks found after 3 polls — proceeding to merge."
      break
    fi
    echo "   [$(( (POLL_COUNT + 1) * POLL_INTERVAL ))s] No checks yet..."
    POLL_COUNT=$((POLL_COUNT + 1))
    continue
  fi

  PENDING=$(echo "$CHECKS" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); print(sum(1 for c in d if c['bucket']=='pending'))" \
    2>/dev/null || echo "1")

  FAILED=$(echo "$CHECKS" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); print(sum(1 for c in d if c['bucket'] in ('fail','cancel')))" \
    2>/dev/null || echo "0")

  echo "   [$(( (POLL_COUNT + 1) * POLL_INTERVAL ))s] ${TOTAL} checks — pending: ${PENDING}, failed: ${FAILED}"

  if [ "$FAILED" != "0" ]; then
    echo "❌ CI failed. Fix the issues and re-push, then call this script again:"
    echo "$CHECKS" | python3 -c "
import sys, json
for c in json.load(sys.stdin):
    if c['bucket'] in ('fail', 'cancel'):
        print(f\"  ✗ {c['name']}  →  {c['link']}\")
" 2>/dev/null || true
    echo "   PR: ${PR_URL}"
    exit 1
  fi

  if [ "$PENDING" = "0" ]; then
    echo "✅ All CI checks passed!"
    break
  fi

  POLL_COUNT=$((POLL_COUNT + 1))
done

if [ $POLL_COUNT -ge $MAX_POLLS ]; then
  echo "⏰ Timed out after $((MAX_POLLS * POLL_INTERVAL))s."
  echo "   View PR manually: ${PR_URL}"
  exit 1
fi

# ── Squash merge ──────────────────────────────────────────────────────────────
gh pr merge "$PR_NUMBER" \
  --squash \
  --delete-branch \
  --subject "$COMMIT_MSG"

echo ""
echo "🎉 Done! PR #${PR_NUMBER} squash-merged → main."
echo "   ${PR_URL}"
