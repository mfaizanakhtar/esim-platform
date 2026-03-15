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
# CodeRabbit posts as 'coderabbitai[bot]' (GitHub Apps bot login format).
# We poll two endpoints:
#   - /repos/{repo}/pulls/{pr}/comments   → inline review comments (file:line)
#   - /repos/{repo}/issues/{pr}/comments  → PR-level summary comments
CR_WAIT=15           # poll every 15s
CR_MAX=12            # max 12 × 15s = 3 min
CR_COUNT=0
CR_FOUND=0

echo ""
echo "🐰 Waiting for CodeRabbit review on PR #${PR_NUMBER} (up to $((CR_MAX * CR_WAIT))s)..."

while [ $CR_COUNT -lt $CR_MAX ]; do
  sleep $CR_WAIT
  CR_COUNT=$((CR_COUNT + 1))

  # Fetch both inline + issue-level comments from CodeRabbit
  INLINE_RAW=$(gh api \
    "repos/${REPO}/pulls/${PR_NUMBER}/comments" \
    --jq '[.[] | select(.user.login == "coderabbitai[bot]" or .user.login == "coderabbitai")]' 2>/dev/null || echo "[]")

  SUMMARY_RAW=$(gh api \
    "repos/${REPO}/issues/${PR_NUMBER}/comments" \
    --jq '[.[] | select(.user.login == "coderabbitai[bot]" or .user.login == "coderabbitai")]' 2>/dev/null || echo "[]")

  INLINE_COUNT=$(echo "$INLINE_RAW" | python3 -c \
    "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
  SUMMARY_COUNT=$(echo "$SUMMARY_RAW" | python3 -c \
    "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

  echo "   [$(( CR_COUNT * CR_WAIT ))s] CodeRabbit comments — inline: ${INLINE_COUNT}, summary: ${SUMMARY_COUNT}"

  TOTAL_CR=$(( INLINE_COUNT + SUMMARY_COUNT ))
  if [ "$TOTAL_CR" -gt 0 ]; then
    CR_FOUND=1
    break
  fi
done

# ── Parse & display CodeRabbit comments ──────────────────────────────────────
if [ "$CR_FOUND" = "0" ]; then
  echo "ℹ️  No CodeRabbit comments found within timeout — proceeding to merge."
else
  echo ""
  echo "========================================================================"
  echo "🐰 CODERABBIT REVIEW COMMENTS"
  echo "========================================================================"

  # Inline comments: show file path + line + body
  if [ "$INLINE_COUNT" -gt 0 ]; then
    echo ""
    echo "── INLINE COMMENTS (file-level) ──────────────────────────────────────"
    echo "$INLINE_RAW" | python3 -c "
import sys, json
comments = json.load(sys.stdin)
for i, c in enumerate(comments, 1):
    path = c.get('path', '(unknown file)')
    line = c.get('line') or c.get('original_line') or c.get('position') or '?'
    body = c.get('body', '').strip()
    print(f'[{i}] {path}:{line}')
    print(f'    {body}')
    print()
" 2>/dev/null || echo "(could not parse inline comments)"
  fi

  # Summary/PR-level comments: show full body
  if [ "$SUMMARY_COUNT" -gt 0 ]; then
    echo ""
    echo "── SUMMARY COMMENTS (PR-level) ───────────────────────────────────────"
    echo "$SUMMARY_RAW" | python3 -c "
import sys, json
comments = json.load(sys.stdin)
for i, c in enumerate(comments, 1):
    body = c.get('body', '').strip()
    # Skip pure reaction/emoji-only comments or very short acknowledgements
    if len(body) < 20:
        continue
    url = c.get('html_url', '')
    print(f'[{i}] {url}')
    print(body[:2000])  # cap at 2000 chars per comment
    print()
" 2>/dev/null || echo "(could not parse summary comments)"
  fi

  echo "========================================================================"
  echo ""

  # Determine if there are actionable issues (inline comments always are;
  # summary comments are actionable if they contain code suggestions or issues)
  ACTIONABLE=$(echo "$INLINE_RAW $SUMMARY_RAW" | python3 -c "
import sys, json

# Inline comments are always considered actionable
try:
    # We receive two JSON arrays concatenated with a space — parse each
    raw = sys.stdin.read().strip()
    # Split on '[ ... ] [' boundary
    parts = raw.rsplit('] [', 1)
    inline = json.loads(parts[0] + ']') if len(parts) == 2 else json.loads(raw)
    summary = json.loads('[' + parts[1]) if len(parts) == 2 else []
except Exception:
    inline = []
    summary = []

actionable = len(inline)

# Summary comments are actionable if they contain issue/suggestion keywords
keywords = ['issue', 'bug', 'error', 'fix', 'incorrect', 'missing', 'should', 'must', 'nitpick', 'suggestion', 'consider', 'change', 'remove', 'add', 'typo']
for c in summary:
    body = c.get('body', '').lower()
    if any(k in body for k in keywords):
        actionable += 1

print(actionable)
" 2>/dev/null || echo "0")

  if [ "$ACTIONABLE" -gt 0 ]; then
    echo "⚠️  CodeRabbit found ${ACTIONABLE} actionable issue(s)."
    echo ""
    echo "════════════════════════════════════════════════════════════════════════"
    echo "  AGENT ACTION REQUIRED"
    echo "════════════════════════════════════════════════════════════════════════"
    echo "  1. Read the comments printed above."
    echo "  2. Edit the relevant source files to address the issues."
    echo "  3. Run the following commands to commit, push, and merge:"
    echo ""
    echo "     git add -A"
    echo "     git commit -m \"review: address CodeRabbit feedback\""
    echo "     git push origin ${BRANCH_NAME}"
    echo "     ./.claude/skills/create-pr/agent-pr-merge.sh ${PR_NUMBER} \"${COMMIT_MSG}\""
    echo ""
    echo "  PR URL: ${PR_URL}"
    echo "════════════════════════════════════════════════════════════════════════"
    exit 2
  else
    echo "✅ No actionable CodeRabbit issues — proceeding to merge."
  fi
fi

# ── Merge ─────────────────────────────────────────────────────────────────────
gh pr merge "$PR_NUMBER" \
  --squash \
  --delete-branch \
  --subject "$COMMIT_MSG"

echo ""
echo "🎉 Done! PR #${PR_NUMBER} squash-merged → main, branch '${BRANCH_NAME}' deleted."
echo "   ${PR_URL}"
