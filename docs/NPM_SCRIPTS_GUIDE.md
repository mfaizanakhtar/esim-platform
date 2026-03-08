# NPM Scripts Guide

> **Document Type**: Developer
> **Status**: ✅ Current
> **Last Updated**: 2026-03-08
> **Purpose**: Explain script intent, quality gates, and de-duplication decisions.

---

## Why this doc exists

`package.json` cannot contain inline comments. This file acts as the commented reference for all important scripts.

---

## Key quality commands

| Command | What it does | When to use |
|---|---|---|
| `npm run type-check:fresh` | Regenerates Prisma client, then runs both TypeScript configs (`type-check` and `type-check:all`) | Before commits and after Prisma/schema changes |
| `npm run verify` | Full guard: type-check + build + tests + lint (`--quiet`) | Before pushing / opening PR |
| `npm run lint` | Lints all `.ts` files including tests | During development |
| `npm run test -- --run` | Runs tests once (CI-style, non-watch) | Validate test stability |
| `npm run scripts:help` | Prints short script usage help | Quick reminder |

---

## De-duplication applied

### `worker` command

- Previous value duplicated `dev:worker` implementation.
- Current value is an alias:
  - `worker` → `npm run dev:worker`

This keeps backward compatibility while removing duplicate command definitions.

---

## Why `type-check:fresh` was added

Recent debugging showed that stale generated Prisma types can cause editor-only TypeScript diagnostics.

`type-check:fresh` ensures checks are done in this order:

1. `prisma generate`
2. `tsc --noEmit`
3. `tsc -p tsconfig.test.json --noEmit`

This catches both app and test typing issues in one command.

---

## Recommended daily workflow

1. `npm run type-check:fresh`
2. `npm run test -- --run`
3. `npm run verify` (before push)

---

## Notes

- Warnings in utility scripts (e.g. `console` in migration/maintenance scripts) are intentionally kept and can appear under lint without blocking CI.
- External folders opened in VS Code (for example sibling worktrees outside this workspace) can still produce diagnostics not covered by these workspace scripts.
