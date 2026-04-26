# Skill: Documentation

## Purpose
Keep `docs/` up to date whenever code changes. Documentation is as important as the code — agents must update it proactively, not as an afterthought.

---

## What to Document (and Where)

| You changed... | Update this doc |
|----------------|-----------------|
| A new or modified admin API endpoint | `docs/api-admin.md` |
| A new or modified public endpoint | `docs/api-public.md` |
| Prisma schema (new model, new field) | `docs/database.md` |
| Environment variable (new, removed, renamed) | `docs/env-vars.md` |
| FiRoam or TGT vendor logic / new vendor | `docs/vendors.md` |
| Shopify webhooks, extension, theme, toml | `docs/shopify.md` |
| SKU mapping logic, AI mapping, structured matching | `docs/sku-mapping.md` |
| Worker jobs (new job, retry policy, flow change) | `docs/worker-jobs.md` |
| Railway services, build/deploy process | `docs/deployment.md` |
| Encryption, auth, HMAC verification | `docs/security.md` |
| System architecture, data flow | `docs/architecture.md` |
| **Any new feature or behaviour change** | `docs/implementations/<NNNN>-<slug>.md` (see [INDEX](../../../docs/implementations/INDEX.md) and [_TEMPLATE](../../../docs/implementations/_TEMPLATE.md)) |

When adding a **new** doc topic that doesn't fit any existing file, create a new file in `docs/` and add it to `docs/README.md`.

### Implementation Log (`docs/implementations/`)

The topic-based docs above describe the system as it currently is. The implementation log is **per-feature**: it records what was built, why, the key files, and the non-obvious gotchas. Every PR that adds or changes user-visible behaviour MUST add or update an entry. The `create-pr` skill enforces this with a hard gate (exit code 2) unless the commit message contains `[skip-impl-log]`.

---

## When to Update Docs

Update docs **in the same PR** as the code change. Never leave docs stale.

**Always update:**
- New endpoint added → `api-admin.md` or `api-public.md`
- Schema changed → `database.md`
- New env var → `env-vars.md`
- Vendor integration changed → `vendors.md`
- Shopify app.toml or extension changed → `shopify.md`

**Use judgment:**
- Minor refactor with no behavior change → no doc update needed
- Bug fix that doesn't change the API contract → no doc update needed
- Any change that would confuse a developer reading the docs → update

---

## Documentation Style

- **Concise:** Docs are reference material, not tutorials. One sentence per concept.
- **Accurate:** If something is wrong in the docs, fix it — don't add a note saying "this may be outdated"
- **Tables over prose:** Use tables for endpoints, fields, env vars
- **Code examples:** Include request/response shapes for all API endpoints
- **File references:** Always reference the source file path so developers can find the code

---

## Creating New Documentation

When a significant new feature is built, create a new file:

```bash
# Create the doc
touch docs/<topic>.md

# Add to README.md index
# Edit docs/README.md and add a row to the index table
```

Use this template:

```markdown
# <Topic Name>

Brief one-line description of what this covers.

**Source:** `path/to/relevant/file.ts`

---

## Section 1
...
```

---

## Do NOT Document in docs/

- Git history or what changed when — that's what git log is for
- Temporary state or in-progress work — use tasks/plans instead
- Things already in CLAUDE.md or AGENTS.md
- Step-by-step tutorials — keep docs as reference material
