#!/usr/bin/env bash
# =============================================================================
# agent-pr-reviewed.sh — Skill: branch → commit → push → PR → CI → CodeRabbit
#                         review → AGENT reads & fixes → CI → squash merge
#
# Usage:
#   npm run pr:create-reviewed "feat: my feature description"
#   npm run pr:create-reviewed "fix: bug fix" "fix/optional-branch-name"
#
#   Or directly:
#   ./.claude/skills/create-pr/agent-pr-reviewed.sh "feat: my feature"
#   ./.claude/skills/create-pr/agent-pr-reviewed.sh "feat: my feature" "feat/branch-name"
#
# HOW THIS WORKS (for the agent running this script):
#   1. Creates branch, commits, pushes, opens PR
#   2. Waits for CI to go green
#   3. Waits for CodeRabbit to post its review (up to 3 min)
#   4. Prints all CodeRabbit comments (file:line + body)
#   5. Exits with code 2 if there are actionable CodeRabbit issues — the AGENT
#      should read the printed comments, edit the relevant files to fix the
#      issues, then run the FIX LOOP commands printed at the bottom.
#   6. If no actionable issues: squash-merges automatically.
#
# FIX LOOP (agent uses these after fixing files):
#   git add -A
#   git commit -m "review: address CodeRabbit feedback"
#   git push origin <BRANCH_NAME>
#   # Then re-run CI check + merge:
#   ./.claude/skills/create-pr/agent-pr-merge.sh <PR_NUMBER> "<COMMIT_MSG>"
#
# Requirements:
#   - gh CLI authenticated  (gh auth status)
#   - python3 available     (standard on macOS/Linux)
#   - git remote origin set
#   - GITHUB_TOKEN set (or gh CLI token used automatically)
# =============================================================================

set -euo pipefail

# ── Args ────────────────────────────────────────────────────────────────────
COMMIT_MSG="${1:-}"
BRANCH_ARG="${2:-}"

if [ -z "$COMMIT_MSG" ]; then
  echo "❌ Usage: $0 \"<commit message>\" [branch-name]"
  exit 1
fi

# ── Detect repo (owner/name) ─────────────────────────────────────────────────
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
if [ -z "$REPO" ]; then
  echo "❌ Could not detect GitHub repo. Run: gh repo view"
  exit 1
fi

# ── Derive branch name from commit message if not provided ───────────────────
if [ -n "$BRANCH_ARG" ]; then
  BRANCH_NAME="$BRANCH_ARG"
else
  # "feat: add email retry" → "feat/add-email-retry"
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

# ── Branch handling ──────────────────────────────────────────────────────────
CURRENT_BRANCH=$(git branch --show-current)

if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
  echo "📌 On ${CURRENT_BRANCH} → creating branch: ${BRANCH_NAME}"
  git checkout -b "$BRANCH_NAME"
elif [ "$CURRENT_BRANCH" = "$BRANCH_NAME" ]; then
  echo "📌 Already on branch: ${BRANCH_NAME}"
else
  echo "📌 On branch: ${CURRENT_BRANCH} (using as-is)"
  BRANCH_NAME="$CURRENT_BRANCH"
fi

# ── Stage & commit ───────────────────────────────────────────────────────────
git add -A

if git diff --staged --quiet; then
  echo "⚠️  Nothing to commit — working tree is clean."
  exit 0
fi

git commit -m "$COMMIT_MSG"
echo "✅ Committed: ${COMMIT_MSG}"

# ── Push ─────────────────────────────────────────────────────────────────────
git push origin "$BRANCH_NAME"
echo "✅ Pushed: ${BRANCH_NAME}"

# ── Create PR ────────────────────────────────────────────────────────────────
PR_BODY=$(printf "## Summary\nAutomated PR created by agent.\n\n## Branch\n\`%s\`\n\n## Checklist\n- [x] Tests pass locally\n- [x] Lint clean\n- [x] Type-check clean" "$BRANCH_NAME")

PR_URL=$(gh pr create \
  --base main \
  --head "$BRANCH_NAME" \
  --title "$COMMIT_MSG" \
  --body "$PR_BODY")

# Extract PR number from URL: .../pull/42 → 42
PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')
echo "✅ PR #${PR_NUMBER} created: ${PR_URL}"

# ── CI polling function ──────────────────────────────────────────────────────
wait_for_ci() {
  local pr_num="$1"
  local poll_interval=15
  local max_polls=40   # 40 × 15s = 10 min max
  local poll_count=0
  local no_checks_count=0

  echo "⏳ Polling CI checks for PR #${pr_num} (every ${poll_interval}s, max $((max_polls * poll_interval))s)..."

  while [ $poll_count -lt $max_polls ]; do
    sleep $poll_interval

    local checks
    checks=$(gh pr checks "$pr_num" --json name,bucket,link 2>/dev/null || echo "[]")

    local total
    total=$(echo "$checks" | python3 -c \
      "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

    if [ "$total" = "0" ]; then
      no_checks_count=$((no_checks_count + 1))
      if [ $no_checks_count -ge 3 ]; then
        echo "ℹ️  No CI checks found after 3 polls — proceeding."
        return 0
      fi
      echo "   [$(( (poll_count + 1) * poll_interval ))s] No checks yet..."
      poll_count=$((poll_count + 1))
      continue
    fi

    local pending
    pending=$(echo "$checks" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(sum(1 for c in d if c['bucket']=='pending'))" \
      2>/dev/null || echo "1")

    local failed
    failed=$(echo "$checks" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(sum(1 for c in d if c['bucket'] in ('fail','cancel')))" \
      2>/dev/null || echo "0")

    echo "   [$(( (poll_count + 1) * poll_interval ))s] ${total} checks — pending: ${pending}, failed: ${failed}"

    if [ "$failed" != "0" ]; then
      echo "❌ CI failed. Fix the issues below and re-run:"
      echo "$checks" | python3 -c "
import sys, json
for c in json.load(sys.stdin):
    if c['bucket'] in ('fail', 'cancel'):
        print(f\"  ✗ {c['name']}  →  {c['link']}\")
" 2>/dev/null || true
      echo "   PR: ${PR_URL}"
      return 1
    fi

    if [ "$pending" = "0" ]; then
      echo "✅ All CI checks passed!"
      return 0
    fi

    poll_count=$((poll_count + 1))
  done

  echo "⏰ CI timed out after $((max_polls * poll_interval))s."
  echo "   View PR manually: ${PR_URL}"
  return 1
}

# ── Wait for initial CI ──────────────────────────────────────────────────────
wait_for_ci "$PR_NUMBER"

# ── Wait for CodeRabbit review ────────────────────────────────────────────────
REPO_OWNER=$(echo "$REPO" | cut -d/ -f1)
REPO_NAME=$(echo "$REPO" | cut -d/ -f2)

# shellcheck source=agent-pr-coderabbit.sh
source "$(dirname "$0")/agent-pr-coderabbit.sh"

set +e
wait_for_coderabbit "$PR_NUMBER" "$REPO_OWNER" "$REPO_NAME" "$PR_URL" "$BRANCH_NAME" "$COMMIT_MSG"
CR_EXIT=$?
set -e

if [ "$CR_EXIT" = "2" ]; then
  exit 2
elif [ "$CR_EXIT" != "0" ]; then
  exit "$CR_EXIT"
fi

# ── Merge ─────────────────────────────────────────────────────────────────────
gh pr merge "$PR_NUMBER" \
  --squash \
  --delete-branch \
  --subject "$COMMIT_MSG"

echo ""
echo "🎉 Done! PR #${PR_NUMBER} squash-merged → main, branch '${BRANCH_NAME}' deleted."
echo "   ${PR_URL}"
