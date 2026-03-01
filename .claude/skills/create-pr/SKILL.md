# Skill: Create PR

**Script**: `agent-pr.sh`  
**Trigger**: When you need to commit changes, open a PR, wait for CI to go green, and merge.

---

## When to Use This Skill

Use this skill at the end of any coding task when:
- You have uncommitted changes ready to ship
- You want a clean branch → PR → CI wait → squash merge flow
- You are currently on `main` or an existing feature branch

---

## Prerequisites

- `gh` CLI authenticated → `gh auth status`
- `git` configured with `remote origin`
- `python3` available (used to parse GraphQL JSON)
- All code changes are final and staged/unstaged in the working tree

---

## Usage

```bash
# From the repo root — run via npm script
npm run pr:create "feat: add email retry logic"

# With an explicit branch name
npm run pr:create "fix: handle null email" "fix/null-email-handling"

# Or call the script directly
./.claude/skills/create-pr/agent-pr.sh "feat: my feature"
./.claude/skills/create-pr/agent-pr.sh "fix: my fix" "fix/my-branch-name"
```

---

## Flow (Step-by-Step)

```
1. BRANCH
   ├── If on main/master → derive branch name from commit message
   │     "feat: add retry logic" → "feat/add-retry-logic"
   │     "fix: null email"       → "fix/null-email"
   │     Custom name via arg2    → use as-is
   └── If already on a feature branch → use it as-is

2. STAGE & COMMIT
   ├── git add -A  (stages everything)
   ├── git commit -m "<commit message>"
   └── If nothing staged → exit early with warning (no-op)

3. PUSH
   └── git push origin <branch>

4. OPEN PR
   ├── gh pr create --base main --head <branch>
   ├── Title = commit message
   └── Body = auto-generated summary with branch name and checklist

5. POLL CI (GitHub GraphQL — statusCheckRollup)
   ├── Query: repository → pullRequest → commits(last:1) → statusCheckRollup
   ├── Poll every 20 seconds, max 10 minutes
   ├── State: SUCCESS      → proceed to merge
   ├── State: FAILURE/ERROR → print failed checks, exit 1
   └── State: PENDING/IN_PROGRESS/QUEUED → keep waiting

6. MERGE
   └── gh pr merge --squash --delete-branch
       Branch is deleted after merge.
```

---

## Branch Naming Convention

| Commit message prefix | Resulting branch prefix |
|-----------------------|------------------------|
| `feat:`               | `feat/`                |
| `fix:`                | `fix/`                 |
| `chore:`              | `chore/`               |
| `docs:`               | `docs/`                |
| `refactor:`           | `refactor/`            |
| anything else         | `chore/`               |

Slug rules: lowercase, spaces → hyphens, non-alphanumeric stripped, max 40 chars.

---

## Error Handling

| Situation | Behaviour |
|-----------|-----------|
| No commit message provided | Prints usage and exits 1 |
| Nothing to commit (clean tree) | Prints warning, exits 0 (safe no-op) |
| CI checks fail | Prints each failed check name + conclusion, exits 1 |
| CI timeout (>10 min) | Prints PR URL for manual review, exits 1 |
| Already on a feature branch | Uses existing branch, ignores derived name |

---

## Example Output

```
📌 On main, creating branch: feat/add-email-retry
✅ Committed: feat: add email retry logic
✅ Pushed: feat/add-email-retry
✅ PR created: https://github.com/org/repo/pull/42
⏳ Waiting for CI checks on PR #42...
   [0s] State: PENDING — checking again in 20s...
   [20s] State: IN_PROGRESS — checking again in 20s...
   [40s] State: IN_PROGRESS — checking again in 20s...
✅ All checks passed!

🎉 Done! PR #42 merged and branch 'feat/add-email-retry' deleted.
   https://github.com/org/repo/pull/42
```

---

## Agent Notes

- **Always verify code first** before running this skill:
  ```bash
  npm run build && npm test -- --run && npx eslint . --ext .ts --quiet
  ```
- **Do not run this skill if tests are failing** — CI will reject the PR and the skill will exit 1.
- **Commit message format**: Use conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`).
- **Squash merge**: All commits on the branch are squashed into one commit on `main`.
