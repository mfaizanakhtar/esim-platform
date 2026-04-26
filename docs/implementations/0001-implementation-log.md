# Implementation Log + Enforcement

**ID:** 0001 · **Status:** shipped · **Owner:** faizanakh
**Shipped:** 2026-04-26 · **PRs:** _to be filled in at merge_

## What it does

Adds a per-feature record system at `docs/implementations/` so any agent can scan one index file and know what's been built — without re-deriving the picture from `git log` and grep. Every PR that adds or changes user-visible behaviour now has to ship an `implementations/<NNNN>-<slug>.md` entry. Three layers enforce this: a documented rule (CLAUDE.md), a hard gate in the `create-pr` skill (exits 2 before commit), and a CI check on every PR.

## Why

The topic-based docs in `docs/` (`database.md`, `shopify.md`, etc.) describe the system *as it currently is* — they don't tell an agent which features have been shipped, what the non-obvious gotchas are, or why something was built a particular way. Without that, every new agent (and every fresh context window) re-derives the picture from `git log`, which is slow, lossy, and frequently incorrect. The documented rule alone wasn't enough — past attempts to "remember to update X" have rotted. The enforcement layers ensure the system survives memory-loss and context resets.

## Key files

| Path | Role |
|------|------|
| `docs/implementations/INDEX.md` | The index agents scan first |
| `docs/implementations/_TEMPLATE.md` | Template to copy when adding a new entry |
| `CLAUDE.md` | Pointer to the index + Non-Negotiable Rule (item 6) |
| `fulfillment-engine/CLAUDE.md` | Same pointer + rule for backend agents |
| `.claude/skills/docs/SKILL.md` | Adds `docs/implementations/` row to "What to Document" table |
| `.claude/skills/create-pr/SKILL.md` | Documents the new gate, exit code 2 behaviour, `[skip-impl-log]` clause |
| `.claude/skills/create-pr/agent-pr-reviewed.sh` | **Layer 2 gate** — exits 2 if substantive code changed but `docs/implementations/` untouched |
| `.claude/skills/create-pr/agent-pr.sh` | Same gate in the backup script (kept in sync) |
| `.github/workflows/check-implementation-log.yml` | **Layer 3 CI guardrail** — same logic at PR level |

## Touchpoints

- Agent onboarding (CLAUDE.md files at root and per-package)
- `create-pr` skill workflow
- GitHub Actions on every PR

## Data model

None. This is documentation + tooling only.

## Gotchas / non-obvious decisions

- **Substantive paths are narrow on purpose.** Only `fulfillment-engine/src/`, `fulfillment-engine/extensions/`, and `dashboard/src/` trigger the gate. Tests (`__tests__`, `*.test.*`, `*.spec.*`), Prisma migrations, and everything outside those trees are excluded. This avoids false positives on infra-only PRs while still catching every behaviour change.
- **`[skip-impl-log]` is the escape hatch, not the default.** It's there for pure refactors, fixes that don't change observable behaviour, CI tweaks, and docs-only PRs. The CI workflow honours the same flag in PR title, body, or `skip-impl-log` label.
- **Gate runs after `git add -A` but before `git commit`.** If it fires, the script does `git reset --quiet HEAD` so the working tree is exactly as the user left it — they just add the missing entry and re-run. No commit needs undoing.
- **Both `agent-pr.sh` and `agent-pr-reviewed.sh` carry the gate.** They must stay in sync; if one diverges and someone uses `pr:create-simple`, the gate could be bypassed. Future cleanup: extract to a sourced `gate.sh`.
- **IDs are assigned at merge time, not at planning time.** That avoids collisions when multiple feature branches plan in parallel.
- **The `_TEMPLATE.md` underscore prefix** keeps it sorted at the top and visually distinct from real entries.
- **The CI workflow uses `BASE_SHA...HEAD_SHA` (three dots).** That's the merge-base diff — the right comparison for "what does this PR introduce." Using `..` (two dots) would include unrelated commits on main.

## Related docs

- `.claude/skills/docs/SKILL.md` — the broader documentation rule (topic-based docs)
- `.claude/skills/create-pr/SKILL.md` — full create-pr flow including the new gate

## Future work / known gaps

- **Backfill** — existing shipped features (multi-eSIM orders, vector embeddings + SSE, smart pricing, FiRoam/TGT integrations, AI mapping, Shopify extensions, etc.) need entries. Tracked as a separate plan.
- **Companion `log-implementation` skill** — auto-draft a `_TEMPLATE.md` fill-in from a PR diff using an LLM, so the agent doesn't write the entry from a blank slate. Layer 2 could invoke this instead of just printing the failure message.
- **Gate deduplication** — extract the gate into a sourced `gate.sh` so `agent-pr.sh` and `agent-pr-reviewed.sh` don't drift.
