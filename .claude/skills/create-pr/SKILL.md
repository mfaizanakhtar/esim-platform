# Skill: Create PR

## Scripts in this skill

| Script | npm script | Purpose |
|--------|------------|---------|
| `agent-pr-reviewed.sh` | `npm run pr:create` ⭐ **default** | Full flow: branch → commit → push → PR → CI → CodeRabbit review → agent fixes → merge |
| `agent-pr-merge.sh` | `npm run pr:merge` | Re-poll CI for an existing PR and squash-merge (used by agent after fixing CodeRabbit issues) |
| `agent-pr.sh` | `npm run pr:create-simple` | Backup: same flow without CodeRabbit wait (use only if CodeRabbit is removed) |

---

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

### Default (with CodeRabbit review)

```bash
# Always use this
npm run pr:create "feat: add email retry logic"

# With an explicit branch name
npm run pr:create "fix: handle null email" "fix/null-email-handling"

# Or call the script directly
./.claude/skills/create-pr/agent-pr-reviewed.sh "feat: my feature"
./.claude/skills/create-pr/agent-pr-reviewed.sh "fix: my fix" "fix/my-branch-name"
```

### Backup (no CodeRabbit — only if CodeRabbit is removed)

```bash
npm run pr:create-simple "feat: add retry logic"
```

**What happens when CodeRabbit finds issues (exit code 2):**
1. Script prints all CodeRabbit inline + summary comments to stdout
2. Exits with code **2** — the agent reads the output, edits the relevant files
3. Agent then runs the fix loop printed by the script:
   ```bash
   git add -A
   git commit -m "review: address CodeRabbit feedback"
   git push origin <branch>
   npm run pr:merge <PR_NUMBER> "<original commit message>"
   ```

**What happens when the implementation log is missing (exit code 2):**
1. Script detects substantive code changed (`fulfillment-engine/src/`, `fulfillment-engine/extensions/`, `dashboard/src/`) but `docs/implementations/` was not touched
2. Prints which files triggered the check + required action
3. Exits with code **2** with no commit made and the working tree restored — the agent must add an `implementations/<NNNN>-<slug>.md` entry (and a row in `INDEX.md`), then re-run `npm run pr:create`
4. Skip clause: include `[skip-impl-log]` anywhere in the commit message for pure refactors / fixes / CI tweaks with no behaviour change

### Merge an existing PR after a fix push

```bash
npm run pr:merge 42 "feat: add retry logic"
# or directly:
./.claude/skills/create-pr/agent-pr-merge.sh 42 "feat: add retry logic"
```

---

## Flow (Step-by-Step)

### Standard (`agent-pr.sh`)

```
1. BRANCH → 2. STAGE & COMMIT → 3. PUSH → 4. OPEN PR → 5. POLL CI → 6. MERGE
```

### With CodeRabbit review (`agent-pr-reviewed.sh`)

```
1. BRANCH
   ├── If on main/master → derive branch name from commit message
   └── If already on a feature branch → use it as-is

2. STAGE & COMMIT
   ├── git add -A
   └── git commit -m "<commit message>"

3. PUSH
   └── git push origin <branch>

4. OPEN PR
   └── gh pr create → extract PR number from URL

5. POLL CI  (same as standard)
   └── Wait for all checks to pass (or fail)

6. WAIT FOR CODERABBIT  (poll every 15s, max 3 min)
   ├── GET /repos/{repo}/pulls/{pr}/comments   → inline (file:line) comments
   ├── GET /repos/{repo}/issues/{pr}/comments  → PR-level summary comments
   └── Filter for user.login == "coderabbitai"

7a. NO ACTIONABLE ISSUES → MERGE (squash)
    └── Same as standard merge step

7b. ACTIONABLE ISSUES FOUND → EXIT 2
    ├── Prints all inline comments (file:line + body)
    ├── Prints all summary comments (up to 2000 chars each)
    └── Prints fix loop commands for the agent to run:
          git add -A
          git commit -m "review: address CodeRabbit feedback"
          git push origin <branch>
          agent-pr-merge.sh <PR_NUMBER> "<COMMIT_MSG>"

8. AGENT FIX LOOP (after agent edits files)
   └── agent-pr-merge.sh → re-poll CI → squash merge
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
| **Implementation log missing for substantive change** | **Prints required action, restores tree, exits 2 — agent adds `implementations/` entry and re-runs (or adds `[skip-impl-log]` to the commit message)** |
| CI checks fail | Prints each failed check name + link, exits 1 |
| CI timeout (>10 min) | Prints PR URL for manual review, exits 1 |
| Already on a feature branch | Uses existing branch, ignores derived name |
| CodeRabbit found actionable issues | Prints comments, exits **2** — agent reads & fixes |
| CodeRabbit timeout (>3 min, no comment) | Proceeds to merge without review wait |
| No CodeRabbit actionable issues | Proceeds to merge automatically |

---

## Example Output

```
📌 On main, creating branch: feat/add-email-retry
✅ Committed: feat: add email retry logic
✅ Pushed: feat/add-email-retry
✅ PR created: https://github.com/org/repo/pull/42
⏳ Waiting for CI checks on PR #42...
   [15s] 3 checks — pending: 3, failed: 0
   [30s] 3 checks — pending: 1, failed: 0
   [45s] 3 checks — pending: 0, failed: 0
✅ All CI checks passed!

🐰 Waiting for CodeRabbit review on PR #42 (up to 180s)...
   [15s] CodeRabbit comments — inline: 0, summary: 0
   [30s] CodeRabbit comments — inline: 2, summary: 1

========================================================================
🐰 CODERABBIT REVIEW COMMENTS
========================================================================

── INLINE COMMENTS (file-level) ──────────────────────────────────────
[1] src/services/email.ts:42
    Consider adding error handling for the null case here.

── SUMMARY COMMENTS (PR-level) ───────────────────────────────────────
[1] https://github.com/org/repo/pull/42#issuecomment-123
    Overall the code looks good. A few minor issues to address...
========================================================================

⚠️  CodeRabbit found 3 actionable issue(s).

════════════════════════════════════════════════════════════════════════
  AGENT ACTION REQUIRED
════════════════════════════════════════════════════════════════════════
  1. Read the comments printed above.
  2. Edit the relevant source files to address the issues.
  3. Run the following commands to commit, push, and merge:

     git add -A
     git commit -m "review: address CodeRabbit feedback"
     git push origin feat/add-email-retry
     ./.claude/skills/create-pr/agent-pr-merge.sh 42 "feat: add email retry logic"

  PR URL: https://github.com/org/repo/pull/42
════════════════════════════════════════════════════════════════════════
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
- **CodeRabbit exit 2**: When `agent-pr-reviewed.sh` exits 2, the agent must:
  1. Read the printed comments carefully
  2. Edit the source files to address each issue
  3. Run the fix loop commands printed at the bottom of the output
  4. Do NOT call `agent-pr-reviewed.sh` again — call `agent-pr-merge.sh` instead
