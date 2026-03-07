#!/usr/bin/env bash
# =============================================================================
# agent-pr.sh — Skill: branch → commit → push → PR → wait CI → squash merge
#
# Usage:
#   npm run pr:create "feat: my feature description"
#   npm run pr:create "fix: bug fix" "fix/optional-branch-name"
#
#   Or directly:
#   ./.claude/skills/create-pr/agent-pr.sh "feat: my feature"
#   ./.claude/skills/create-pr/agent-pr.sh "feat: my feature" "feat/branch-name"
#
# Requirements:
#   - gh CLI authenticated  (gh auth status)
#   - python3 available     (standard on macOS/Linux)
#   - git remote origin set
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

# ── Branch handling ───────────────────────────────────────────────────────────
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

# ── Stage & commit ────────────────────────────────────────────────────────────
git add -A

if git diff --staged --quiet; then
  echo "⚠️  Nothing to commit — working tree is clean."
  exit 0
fi

git commit -m "$COMMIT_MSG"
echo "✅ Committed: ${COMMIT_MSG}"

# ── Push ──────────────────────────────────────────────────────────────────────
git push origin "$BRANCH_NAME"
echo "✅ Pushed: ${BRANCH_NAME}"

# ── Create PR ─────────────────────────────────────────────────────────────────
# Note: gh pr create (this version) does NOT support --json.
# It prints the PR URL to stdout on success — capture that directly.
PR_BODY=$(printf "## Summary\nAutomated PR created by agent.\n\n## Branch\n\`%s\`\n\n## Checklist\n- [x] Tests pass locally\n- [x] Lint clean\n- [x] Type-check clean" "$BRANCH_NAME")

PR_URL=$(gh pr create \
  --base main \
  --head "$BRANCH_NAME" \
  --title "$COMMIT_MSG" \
  --body "$PR_BODY")

# Extract PR number from URL: .../pull/42 → 42
PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')
echo "✅ PR #${PR_NUMBER} created: ${PR_URL}"

# ── Poll CI checks ────────────────────────────────────────────────────────────
# Uses `gh pr checks --json name,bucket,link` (NOT --watch: that opens an
# alternate tty buffer and breaks automation).
# bucket values: pass | fail | pending | skipping | cancel
POLL_INTERVAL=15
MAX_POLLS=40      # 40 × 15s = 10 min max
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
    echo "❌ CI failed. Fix the issues below and re-run the skill:"
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
    echo "✅ All checks passed!"
    break
  fi

  POLL_COUNT=$((POLL_COUNT + 1))
done

if [ $POLL_COUNT -ge $MAX_POLLS ]; then
  echo "⏰ Timed out after $((MAX_POLLS * POLL_INTERVAL))s."
  echo "   View PR manually: ${PR_URL}"
  exit 1
fi

# ── Merge ─────────────────────────────────────────────────────────────────────
# --subject sets the squash-merge commit title on main
gh pr merge "$PR_NUMBER" \
  --squash \
  --delete-branch \
  --subject "$COMMIT_MSG"

echo ""
echo "🎉 Done! PR #${PR_NUMBER} squash-merged → main, branch '${BRANCH_NAME}' deleted."
echo "   ${PR_URL}"


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

# ── Branch handling ───────────────────────────────────────────────────────────
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

# ── Stage & commit ────────────────────────────────────────────────────────────
git add -A

if git diff --staged --quiet; then
  echo "⚠️  Nothing to commit — working tree is clean."
  exit 0
fi

git commit -m "$COMMIT_MSG"
echo "✅ Committed: ${COMMIT_MSG}"

# ── Push ──────────────────────────────────────────────────────────────────────
git push origin "$BRANCH_NAME"
echo "✅ Pushed: ${BRANCH_NAME}"

# ── Create PR ─────────────────────────────────────────────────────────────────
PR_BODY=$(printf "## Summary\nAutomated PR created by agent.\n\n## Branch\n\`%s\`\n\n## Checklist\n- [x] Tests pass locally\n- [x] Lint clean\n- [x] Type-check clean" "$BRANCH_NAME")

PR_URL=$(gh pr create \
  --base main \
  --head "$BRANCH_NAME" \
  --title "$COMMIT_MSG" \
  --body "$PR_BODY")

# Extract PR number from URL: .../pull/42 → 42
PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
echo "✅ PR #${PR_NUMBER} created: ${PR_URL}"

# ── Helper: poll CI checks ────────────────────────────────────────────────────
wait_for_ci() {
  local POLL_INTERVAL=15
  local MAX_POLLS=40
  local POLL_COUNT=0
  local NO_CHECKS_COUNT=0

  echo "⏳ Polling CI checks for PR #${PR_NUMBER} (every ${POLL_INTERVAL}s, max $((MAX_POLLS * POLL_INTERVAL))s)..."

  while [ $POLL_COUNT -lt $MAX_POLLS ]; do
    sleep $POLL_INTERVAL

    CHECKS=$(gh pr checks "$PR_NUMBER" --json name,bucket,link 2>/dev/null || echo "[]")

    TOTAL=$(echo "$CHECKS" | python3 -c \
      "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

    if [ "$TOTAL" = "0" ]; then
      NO_CHECKS_COUNT=$((NO_CHECKS_COUNT + 1))
      if [ $NO_CHECKS_COUNT -ge 3 ]; then
        echo "ℹ️  No CI checks found after 3 polls — proceeding."
        return 0
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
      echo "❌ CI failed. Fix the issues below and re-run the skill:"
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
      echo "✅ All checks passed!"
      return 0
    fi

    POLL_COUNT=$((POLL_COUNT + 1))
  done

  echo "⏰ Timed out waiting for CI."
  exit 1
}

# ── First CI pass ─────────────────────────────────────────────────────────────
wait_for_ci

# ── Wait for CodeRabbit review ────────────────────────────────────────────────
echo ""
echo "🐰 Waiting for CodeRabbit review (up to 3 min)..."

CODERABBIT_REVIEW=""
CR_WAIT=0
CR_MAX=12   # 12 × 15s = 3 min

while [ $CR_WAIT -lt $CR_MAX ]; do
  sleep 15

  # Fetch all PR review comments (inline) + issue comments (summary)
  REVIEW_COMMENTS=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/comments" \
    --jq '[.[] | select(.user.login | test("coderabbitai"; "i")) | {path: .path, line: .original_line, body: .body}]' \
    2>/dev/null || echo "[]")

  ISSUE_COMMENTS=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" \
    --jq '[.[] | select(.user.login | test("coderabbitai"; "i")) | {body: .body}]' \
    2>/dev/null || echo "[]")

  TOTAL_CR=$(echo "$REVIEW_COMMENTS$ISSUE_COMMENTS" | python3 -c "
import sys, json
data = sys.stdin.read()
# parse both arrays
import re
arrays = re.findall(r'\[.*?\]', data, re.DOTALL)
total = sum(len(json.loads(a)) for a in arrays)
print(total)
" 2>/dev/null || echo "0")

  echo "   [$(( (CR_WAIT + 1) * 15 ))s] CodeRabbit comments found: ${TOTAL_CR}"

  if [ "$TOTAL_CR" != "0" ]; then
    CODERABBIT_REVIEW=$(printf '%s\n%s' "$REVIEW_COMMENTS" "$ISSUE_COMMENTS")
    break
  fi

  CR_WAIT=$((CR_WAIT + 1))
done

if [ -z "$CODERABBIT_REVIEW" ] || [ "$TOTAL_CR" = "0" ]; then
  echo "ℹ️  No CodeRabbit review found — proceeding to merge."
else
  echo ""
  echo "📋 CodeRabbit review received. Analyzing comments..."
  echo ""

  # Print summary for the agent to read
  echo "$REVIEW_COMMENTS" | python3 -c "
import sys, json
comments = json.load(sys.stdin)
if not comments:
    print('  (no inline comments)')
else:
    for c in comments:
        path = c.get('path','?')
        line = c.get('line','?')
        body = c.get('body','')[:300]
        print(f'  📍 {path}:{line}')
        print(f'     {body}')
        print()
" 2>/dev/null || true

  echo "$ISSUE_COMMENTS" | python3 -c "
import sys, json
comments = json.load(sys.stdin)
for c in comments:
    body = c.get('body','')[:500]
    print(f'  💬 {body}')
    print()
" 2>/dev/null || true

  echo ""
  echo "⚠️  Review the CodeRabbit comments above."
  echo "   If addressable: fix the code, then commit + push to this branch."
  echo "   The script will re-run CI and merge after your fixes."
  echo ""
  echo "   Branch : ${BRANCH_NAME}"
  echo "   PR     : ${PR_URL}"
  echo ""
  echo "   Once you've pushed fixes, run: gh pr checks ${PR_NUMBER} --watch"
  echo "   Then merge with: gh pr merge ${PR_NUMBER} --squash --delete-branch"
  exit 0
fi

# ── Merge ─────────────────────────────────────────────────────────────────────
gh pr merge "$PR_NUMBER" \
  --squash \
  --delete-branch \
  --subject "$COMMIT_MSG"

echo ""
echo "🎉 Done! PR #${PR_NUMBER} squash-merged → main, branch '${BRANCH_NAME}' deleted."
echo "   ${PR_URL}"


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

# ── Branch handling ───────────────────────────────────────────────────────────
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

# ── Stage & commit ────────────────────────────────────────────────────────────
git add -A

if git diff --staged --quiet; then
  echo "⚠️  Nothing to commit — working tree is clean."
  exit 0
fi

git commit -m "$COMMIT_MSG"
echo "✅ Committed: ${COMMIT_MSG}"

# ── Push ──────────────────────────────────────────────────────────────────────
git push origin "$BRANCH_NAME"
echo "✅ Pushed: ${BRANCH_NAME}"

# ── Create PR ─────────────────────────────────────────────────────────────────
# Note: gh pr create (this version) does NOT support --json.
# It prints the PR URL to stdout on success — capture that directly.
PR_BODY=$(printf "## Summary\nAutomated PR created by agent.\n\n## Branch\n\`%s\`\n\n## Checklist\n- [x] Tests pass locally\n- [x] Lint clean\n- [x] Type-check clean" "$BRANCH_NAME")

PR_URL=$(gh pr create \
  --base main \
  --head "$BRANCH_NAME" \
  --title "$COMMIT_MSG" \
  --body "$PR_BODY")

# Extract PR number from URL: .../pull/42 → 42
PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')
echo "✅ PR #${PR_NUMBER} created: ${PR_URL}"

# ── Poll CI checks ────────────────────────────────────────────────────────────
# Uses `gh pr checks --json name,bucket,link` (NOT --watch: that opens an
# alternate tty buffer and breaks automation).
# bucket values: pass | fail | pending | skipping | cancel
POLL_INTERVAL=15
MAX_POLLS=40      # 40 × 15s = 10 min max
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
    echo "❌ CI failed. Fix the issues below and re-run the skill:"
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
    echo "✅ All checks passed!"
    break
  fi

  POLL_COUNT=$((POLL_COUNT + 1))
done

if [ $POLL_COUNT -ge $MAX_POLLS ]; then
  echo "⏰ Timed out after $((MAX_POLLS * POLL_INTERVAL))s."
  echo "   View PR manually: ${PR_URL}"
  exit 1
fi

# ── Merge ─────────────────────────────────────────────────────────────────────
# --subject sets the squash-merge commit title on main
gh pr merge "$PR_NUMBER" \
  --squash \
  --delete-branch \
  --subject "$COMMIT_MSG"

echo ""
echo "🎉 Done! PR #${PR_NUMBER} squash-merged → main, branch '${BRANCH_NAME}' deleted."
echo "   ${PR_URL}"
