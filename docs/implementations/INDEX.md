# Implementation Index

Every shipped feature or significant change is recorded here. **Agents: read this file first** to know what already exists in the codebase before starting work — it answers "what has been built?" in one scan.

This index complements the topic-based reference in `docs/` (which describes the system as it is *now*). The index tells you *what was built, when, and why* — the per-feature detail files contain the touchpoints, gotchas, and non-obvious decisions a future agent would otherwise have to re-derive from `git log` and grep.

To add a new entry, copy [`_TEMPLATE.md`](_TEMPLATE.md) to `NNNN-<slug>.md` (use the next free 4-digit ID), fill it in, and add a row to the table below.

Status vocabulary: `in-progress`, `shipped`, `deprecated`, `planned`.

| ID | Feature | Status | Summary | Detail |
|----|---------|--------|---------|--------|
| 0001 | Implementation Log + Enforcement | shipped | Per-feature record system at `docs/implementations/` with three-layer enforcement (CLAUDE.md rule, `create-pr` skill gate, CI guardrail) | [0001-implementation-log.md](0001-implementation-log.md) |
| 0002 | Regional SKU catalog (end-to-end) | shipped | `Region` entity, CRUD, discovery suggestions, REGION template generation, strict-coverage structured + AI mapping, and `/regions` dashboard page with 1-click Accept — full no-curl workflow | [0002-region-schema-crud.md](0002-region-schema-crud.md) |

> Backfill of existing shipped features (multi-eSIM orders, vector embeddings + SSE, smart pricing, FiRoam/TGT integrations, Shopify extensions, AI mapping, etc.) is tracked as a follow-up plan and will populate this table.
