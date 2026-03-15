#!/usr/bin/env bash
# =============================================================================
# agent-pr-coderabbit.sh — Shared helper: fetch + display unresolved CodeRabbit
#                           threads via GraphQL when the CodeRabbit CI check fails.
#
# Source this file and call:
#   wait_for_coderabbit PR_NUMBER REPO_OWNER REPO_NAME PR_URL BRANCH_NAME COMMIT_MSG
#
# Returns:
#   0 — no unresolved CodeRabbit threads
#   2 — unresolved threads found; prints them + fix-loop instructions
#
# Design: CodeRabbit runs as a CI check ("CodeRabbit" in gh pr checks).
# The callers wait for all CI checks to pass; when CodeRabbit's check fails
# they call this function to surface the specific unresolved threads.
#
# NOTE: Uses `gh api graphql --input -` (raw JSON body) — gh v2.86+ strips
#       `$` signs from query strings passed via -f query='...', breaking
#       GraphQL variable definitions.
# =============================================================================

wait_for_coderabbit() {
  local pr_number="$1"
  local repo_owner="$2"
  local repo_name="$3"
  local pr_url="$4"
  local branch_name="$5"
  local commit_msg="$6"

  echo ""
  echo "🐰 Fetching unresolved CodeRabbit review threads..."

  # The query string is kept as a bash variable (single-quoted assignment so
  # $ signs are never touched by bash), then passed as sys.argv[1] to python3
  # so json.dumps receives the literal $ characters.
  local gql_query
  gql_query='query($owner: String!, $name: String!, $pr: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $pr) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { nodes { author { login } body } } } } } } }'

  local graphql_result
  local attempt=0
  local gql_ok=0

  while [ $attempt -lt 3 ]; do
    attempt=$((attempt + 1))

    graphql_result=$(python3 -c "
import json, sys
query = sys.argv[1]
owner = sys.argv[2]
name  = sys.argv[3]
pr    = int(sys.argv[4])
print(json.dumps({'query': query, 'variables': {'owner': owner, 'name': name, 'pr': pr}}))
" "$gql_query" "$repo_owner" "$repo_name" "$pr_number" \
      | gh api graphql --input - 2>/dev/null) || true

    if [ -z "$graphql_result" ]; then
      echo "   GraphQL attempt ${attempt} returned empty — retrying in 5s..."
      sleep 5
      continue
    fi

    local has_errors
    has_errors=$(echo "$graphql_result" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if 'errors' in data:
        for e in data['errors']:
            print('  GraphQL error: ' + e.get('message', 'unknown'), file=sys.stderr)
        print('error')
    else:
        print('ok')
except Exception:
    print('error')
" 2>/dev/null || echo "error")

    if [ "$has_errors" = "ok" ]; then
      gql_ok=1
      break
    fi

    echo "   GraphQL attempt ${attempt} had errors — retrying in 5s..."
    sleep 5
  done

  if [ "$gql_ok" = "0" ]; then
    echo "❌ GraphQL unavailable after 3 attempts — cannot verify CodeRabbit unresolved threads."
    echo "   Please retry after GitHub API recovers."
    return 2
  fi

  # ── Count unresolved CodeRabbit threads ─────────────────────────────────────
  local unresolved_count
  unresolved_count=$(echo "$graphql_result" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    threads = data['data']['repository']['pullRequest']['reviewThreads']['nodes']
    count = 0
    for t in threads:
        if t.get('isResolved', True):
            continue
        comments = t.get('comments', {}).get('nodes', [])
        if not comments:
            continue
        login = (comments[0].get('author') or {}).get('login', '')
        if login.startswith('coderabbitai'):
            count += 1
    print(count)
except Exception:
    print('0')
" 2>/dev/null || echo "0")

  if [ "$unresolved_count" = "0" ]; then
    echo "✅ No unresolved CodeRabbit threads."
    return 0
  fi

  # ── Print unresolved thread bodies ──────────────────────────────────────────
  echo ""
  echo "========================================================================"
  echo "🐰 CODERABBIT UNRESOLVED REVIEW THREADS (${unresolved_count})"
  echo "========================================================================"
  echo "$graphql_result" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    threads = data['data']['repository']['pullRequest']['reviewThreads']['nodes']
    i = 0
    for t in threads:
        if t.get('isResolved', True):
            continue
        comments = t.get('comments', {}).get('nodes', [])
        if not comments:
            continue
        login = (comments[0].get('author') or {}).get('login', '')
        if not login.startswith('coderabbitai'):
            continue
        i += 1
        body = comments[0].get('body', '').strip()
        print(f'[{i}] {body[:2000]}')
        print()
except Exception as e:
    print(f'(could not parse threads: {e})')
" 2>/dev/null || echo "(could not parse threads)"
  echo "========================================================================"
  echo ""

  echo "⚠️  CodeRabbit found ${unresolved_count} unresolved thread(s)."
  echo ""
  echo "════════════════════════════════════════════════════════════════════════"
  echo "  AGENT ACTION REQUIRED"
  echo "════════════════════════════════════════════════════════════════════════"
  echo "  1. Read the thread comments printed above."
  echo "  2. Edit the relevant source files to address the issues."
  echo "  3. Run the following commands to commit, push, and re-check:"
  echo ""
  echo "     git add -A"
  echo "     git commit -m \"review: address CodeRabbit feedback\""
  echo "     git push origin ${branch_name}"
  echo "     ./.claude/skills/create-pr/agent-pr-merge.sh ${pr_number} \"${commit_msg}\""
  echo ""
  echo "  PR URL: ${pr_url}"
  echo "════════════════════════════════════════════════════════════════════════"
  return 2
}
