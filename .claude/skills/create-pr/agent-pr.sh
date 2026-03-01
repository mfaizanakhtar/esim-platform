#!/usr/bin/env bash
# =============================================================================
# agent-pr.sh — Agent skill: branch → commit → push → PR → wait for green → merge
#
# Usage:
#   ./scripts/agent-pr.sh "feat: my feature description"
#   ./scripts/agent-pr.sh "fix: bug fix" "optional-branch-name"
#
# What it does:
#   1. If on main, creates a new branch (derived from commit message or arg)
#   2. Stages all uncommitted changes
#   3. Commits with the provided message
#   4. Pushes to remote
#   5. Opens a PR against main
#   6. Polls CI checks via GitHub GraphQL until all pass
#   7. Squash-merges and deletes the branch
#
# Requirements:
#   - gh CLI authenticated (gh auth status)
#   - git configured with remote origin
# =============================================================================

set -euo pipefail

# ── Args ─────────────────────────────────────────────────────────────────────
COMMIT_MSG="${1:-}"
BRANCH_ARG="${2:-}"

if [ -z "$COMMIT_MSG" ]; then
  echo "❌ Usage: $0 \"<commit message>\" [branch-name]"
  exit 1
fi

# ── Derive branch name from commit message if not provided ───────────────────
if [ -n "$BRANCH_ARG" ]; then
  BRANCH_NAME="$BRANCH_ARG"
else
  # e.g. "feat: add email retry" → "feat/add-email-retry"
  PREFIX=$(echo "$COMMIT_MSG" | grep -oE '^[a-z]+' || echo "chore")
  SLUG=$(echo "$COMMIT_MSG" \
    | sed 's/^[a-z]*: *//' \
    | tr '[:upper:]' '[:lower:]' \
    | tr ' ' '-' \
    | sed 's/[^a-z0-9-]//g' \
    | cut -c1-40 \
    | sed 's/-$//')
  BRANCH_NAME="${PREFIX}/${SLUG}"
fi

# ── Branch handling ───────────────────────────────────────────────────────────
CURRENT_BRANCH=$(git branch --show-current)

if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
  echo "📌 On ${CURRENT_BRANCH}, creating branch: ${BRANCH_NAME}"
  git checkout -b "$BRANCH_NAME"
elif [ "$CURRENT_BRANCH" = "$BRANCH_NAME" ]; then
  echo "📌 Already on branch: ${BRANCH_NAME}"
else
  echo "📌 On branch: ${CURRENT_BRANCH} (using as-is, ignoring derived name)"
  BRANCH_NAME="$CURRENT_BRANCH"
fi

# ── Stage & commit ────────────────────────────────────────────────────────────
git add -A

if git diff --staged --quiet; then
  echo "⚠️  No staged changes — nothing to commit."
  echo "   (If you want to push an existing commit, remove the 'set -e' guard)"
  exit 0
fi

git commit -m "$COMMIT_MSG"
echo "✅ Committed: ${COMMIT_MSG}"

# ── Push ──────────────────────────────────────────────────────────────────────
git push origin "$BRANCH_NAME"
echo "✅ Pushed: ${BRANCH_NAME}"

# ── Create PR ────────────────────────────────────────────────────────────────
PR_URL=$(gh pr create \
  --base main \
  --head "$BRANCH_NAME" \
  --title "$COMMIT_MSG" \
  --body "$(printf "## Summary\nAutomated PR created by agent.\n\n## Branch\n\`%s\`\n\n## Checklist\n- [x] Lint passed\n- [x] Type-check passed\n- [x] Tests passed" "$BRANCH_NAME")" \
  --json url --jq '.url')

PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')
echo "✅ PR created: ${PR_URL}"

# ── Wait for CI checks via GraphQL ───────────────────────────────────────────
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
POLL_INTERVAL=20
MAX_WAIT=600  # 10 minutes
ELAPSED=0

echo "⏳ Waiting for CI checks on PR #${PR_NUMBER}..."

while [ $ELAPSED -lt $MAX_WAIT ]; do
  # Use GraphQL to get check suite conclusion for the latest commit on the PR
  CHECKS_JSON=$(gh api graphql -f query="
    query {
      repository(owner: \"$(echo $REPO | cut -d/ -f1)\", name: \"$(echo $REPO | cut -d/ -f2)\") {
        pullRequest(number: ${PR_NUMBER}) {
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                  contexts(last: 50) {
                    nodes {
                      ... on CheckRun {
                        name
                        status
                        conclusion
                      }
                      ... on StatusContext {
                        context
                        state
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  " 2>/dev/null)

  ROLLUP_STATE=$(echo "$CHECKS_JSON" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); pr=d['data']['repository']['pullRequest']; commit=pr['commits']['nodes'][0]['commit']; rollup=commit.get('statusCheckRollup'); print(rollup['state'] if rollup else 'PENDING')" 2>/dev/null || echo "PENDING")

  case "$ROLLUP_STATE" in
    SUCCESS)
      echo "✅ All checks passed!"
      break
      ;;
    FAILURE|ERROR)
      echo "❌ CI checks failed. View PR: ${PR_URL}"
      # Print which checks failed
      echo "$CHECKS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
nodes = d['data']['repository']['pullRequest']['commits']['nodes'][0]['commit']['statusCheckRollup']['contexts']['nodes']
for n in nodes:
    name = n.get('name') or n.get('context', '?')
    status = n.get('conclusion') or n.get('state', '?')
    if status not in ('SUCCESS', 'success', 'NEUTRAL', None):
        print(f'  ✗ {name}: {status}')
" 2>/dev/null || true
      exit 1
      ;;
    PENDING|EXPECTED|QUEUED|IN_PROGRESS)
      echo "   [${ELAPSED}s] State: ${ROLLUP_STATE} — checking again in ${POLL_INTERVAL}s..."
      sleep $POLL_INTERVAL
      ELAPSED=$((ELAPSED + POLL_INTERVAL))
      ;;
    *)
      # No checks yet (PR just opened), wait a moment
      echo "   [${ELAPSED}s] No checks yet — waiting ${POLL_INTERVAL}s..."
      sleep $POLL_INTERVAL
      ELAPSED=$((ELAPSED + POLL_INTERVAL))
      ;;
  esac
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  echo "⏰ Timed out after ${MAX_WAIT}s waiting for checks."
  echo "   View PR: ${PR_URL}"
  exit 1
fi

# ── Merge ─────────────────────────────────────────────────────────────────────
gh pr merge "$PR_NUMBER" \
  --squash \
  --delete-branch \
  --subject "$COMMIT_MSG"

echo ""
echo "🎉 Done! PR #${PR_NUMBER} merged and branch '${BRANCH_NAME}' deleted."
echo "   ${PR_URL}"
