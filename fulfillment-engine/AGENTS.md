# Agent Instructions - Shopify eSIM Fulfillment System

## Start Here

| Task type | Read this |
|-----------|-----------|
| Any coding task | This file top-to-bottom, then the specific doc from the index below |
| Before committing | Run `npm run verify` (type-check + build + lint + tests) |
| Creating a PR | Use the **Create PR** skill: `npm run pr:create "feat: description"` |
| Active decisions/gotchas | [`../DECISIONS.md`](../DECISIONS.md) |

## Agent Skills

| Skill | Directory | Purpose | npm script |
|-------|-----------|---------|------------|
| Create PR | [`.claude/skills/create-pr/`](../.claude/skills/create-pr/SKILL.md) | Branch → commit → push → PR → CI → CodeRabbit review → agent fixes → merge | `npm run pr:create "<message>"` |

---

## Table of Contents
- [System Overview](#system-overview)
- [Coding Standards](#coding-standards)
- [Testing Strategy](#testing-strategy)
- [Documentation Strategy](#documentation-strategy)
- [Documentation Index](#documentation-index)

---

## System Overview

### What This System Does
Backend system that automatically provisions and delivers eSIMs after successful Shopify payments. Supports two vendor APIs — **FiRoam** (primary) and **TGT Technology** (secondary) — both behind a common `VendorProvider` interface.

**Key Characteristics:**
- Reliable, idempotent eSIM provisioning
- Low volume (≤1000 eSIMs total)
- Two-process architecture: API + Worker
- Shopify Custom App (webhooks only, no embedded UI)
- Multi-vendor: FiRoam (sync) + TGT (async callback/polling/hybrid)

### Architecture Pattern
```
Shopify Store (payment)
  → Webhook → API Process (idempotency check)
  → Job Queue → Worker Process
  → Vendor API (FiRoam or TGT, selected by SKU mapping)
  → Email Delivery + Shopify Fulfillment

TGT-specific async path:
  createOrder() → tgt-poll-order job (polling)
               ↘ POST /tgt/callback (webhook from TGT)
               → finalizeDelivery()
```

**Technology Stack:**
- Node.js + TypeScript
- Fastify (API framework)
- PostgreSQL + Prisma ORM
- pg-boss (job queue)
- Resend (email delivery)
- Railway (deployment)

---

## Coding Standards

### TypeScript Rules
- **Strict mode enabled** - No implicit any, proper null checks
- **No compiled .js files in src/** - Added to .gitignore
- **Explicit types** - Avoid `any`, use proper interfaces
- **Zod schemas** - For external API validation (FiRoam and TGT responses)

### File Organization
```
src/
├── api/                    # HTTP route handlers
│   ├── tgtCallback.ts      # TGT webhook receiver (POST /tgt/callback)
│   └── ...                 # Shopify webhook, admin routes
├── services/               # Business logic (email, jobs)
├── vendor/                 # External vendor API clients
│   ├── firoamClient.ts     # FiRoam HTTP client
│   ├── firoamSchemas.ts    # FiRoam Zod schemas
│   ├── tgtClient.ts        # TGT HTTP client (OAuth2 + signature)
│   ├── tgtConfig.ts        # TGT config helpers (mode, intervals)
│   ├── tgtSchemas.ts       # TGT Zod schemas (all responses + callbacks)
│   ├── types.ts            # VendorProvider interface
│   └── providers/
│       ├── firoam.ts       # FiRoam VendorProvider implementation
│       └── tgt.ts          # TGT VendorProvider implementation
├── worker/
│   └── jobs/
│       ├── tgtPoll.ts      # TGT polling job (tgt-poll-order)
│       └── finalizeDelivery.ts  # Shared: email + Shopify fulfillment
├── db/                     # Database client + helpers
├── utils/                  # Shared utilities (crypto, logger, errors)
└── server.ts               # Main entry point
```

**Vendor naming convention**: files are prefixed `firoam*` or `tgt*` — no sub-folders needed.

### Code Style
- **Functional approach** - Pure functions where possible
- **Error handling** - Try/catch with proper logging
- **Idempotency** - Check before provisioning (order_id + line_item_id)
- **Security** - Encrypt sensitive data (LPA strings, activation codes)

### Dependencies Management
- Use exact versions for critical packages
- Keep dev dependencies separate
- Document version constraints in comments if needed

### Environment Variables
- All secrets in `.env` (never committed)
- `.env.example` shows required variables
- Validate required env vars at startup

---

## Testing Strategy

### Test Organization
```
src/
├── __tests__/               # Unit tests (alongside code)
├── api/__tests__/           # API route tests
├── services/__tests__/      # Service layer tests
└── vendor/__tests__/        # Vendor integration tests
```

### Test Types

#### 1. Unit Tests
- **Location**: `src/**/__tests__/*.test.ts`
- **Purpose**: Test individual functions/classes
- **Framework**: Vitest
- **Mock**: External APIs, database calls
- **Run**: `npm test`

#### 2. Integration Tests
- **Location**: `test-output/` for results
- **Purpose**: Test full workflows (webhook → provisioning)
- **Database**: Use test database or in-memory
- **Run**: `npm run test:integration` (if configured)

#### 3. Manual Testing Checklist
- Webhook signature verification
- Duplicate order handling
- Email delivery with QR codes
- PDF generation
- Usage tracking API

### Test Requirements
- **Idempotency**: Verify duplicate webhooks don't provision twice
- **Error handling**: Test vendor API failures, retries
- **Data encryption**: Verify sensitive fields encrypted at rest
- **Email rendering**: Check Gmail, Outlook, Apple Mail compatibility

### Known Test Issues
- **Stale .js files**: If tests fail with "method not found", delete compiled .js files in src/
- **Environment**: Ensure test environment variables are set

---

## Documentation Strategy

### Documentation Principles
1. **Separation of Concerns**: Different docs for different audiences
2. **Versioning**: Document changes in UPDATE.md
3. **Examples**: Always include code examples where applicable
4. **Step-by-step**: Guides should be actionable, not just reference

### Documentation Types

#### 1. **Setup & Deployment Docs** (How to run the system)
- Quickstart guides for local development
- Deployment guides for production
- Configuration references

#### 2. **Integration Docs** (How to integrate with external systems)
- Shopify integration details
- FiRoam API integration
- Webhook implementation

#### 3. **Feature Docs** (How specific features work)
- Email delivery with usage tracking
- Usage tracking frontend
- Data encryption

#### 4. **Architecture Docs** (How the system is designed)
- High-level architecture
- Sequence diagrams
- Data flow pipelines

#### 5. **Developer Docs** (How to modify the system)
- Coding standards (this file)
- Testing approach
- SDK migration guides

### Updating Documentation
- **When adding features**: Create or update feature docs
- **When changing APIs**: Update integration docs
- **When fixing bugs**: Note in UPDATE.md if it affects usage
- **When refactoring**: Update architecture docs if structure changes

---

## Documentation Index

### 📋 Core Documentation (You Are Here)
- **AGENTS.md** (this file) - Master index, coding standards, testing strategy

### 🚀 Setup & Deployment

| Document | Purpose | When to Use | Status |
|----------|---------|-------------|--------|
| [README.md](README.md) | Project overview, quick links | First time viewing project | ✅ Current |
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | Local development setup | Setting up dev environment | ✅ Current |
| [docs/TESTING_QUICKSTART.md](docs/TESTING_QUICKSTART.md) | Testing setup & CI/CD quickstart | Running tests, understanding test infrastructure | ✅ Current |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | General deployment guide | Deploying to any platform | ⚠️ Generic |
| [docs/RAILWAY_DEPLOY.md](docs/RAILWAY_DEPLOY.md) | Railway-specific deployment | Deploying to Railway (current prod) | ✅ Current |
| [docs/BRANCH_PROTECTION.md](docs/BRANCH_PROTECTION.md) | GitHub branch protection & CI setup | Configuring PR workflow and CI checks | ✅ Current |

### 🔌 Integration Documentation

| Document | Purpose | When to Use | Status |
|----------|---------|-------------|--------|
| [docs/SHOPIFY_INTEGRATION.md](docs/SHOPIFY_INTEGRATION.md) | Shopify Custom App setup, webhook config | Setting up Shopify store integration | ✅ Current |
| [docs/WEBHOOK_IMPLEMENTATION.md](docs/WEBHOOK_IMPLEMENTATION.md) | Webhook handler implementation details | Understanding/modifying webhook logic | ✅ Current |
| [docs/FIROAM_INTEGRATION.md](docs/FIROAM_INTEGRATION.md) | FiRoam API client implementation | Working with FiRoam vendor API | ✅ Current |
| [FiRoam_documentation.txt](FiRoam_documentation.txt) | Official FiRoam API reference | Source of truth for FiRoam endpoints | ✅ Vendor doc |
| [docs/TGT_INTEGRATION.md](docs/TGT_INTEGRATION.md) | TGT Technology API client implementation | Working with TGT vendor API | ✅ Current |
| [thirdparty-documentation/TGT.txt](thirdparty-documentation/TGT.txt) | Official TGT API reference (v2.0) | Source of truth for TGT endpoints | ✅ Vendor doc |

### 🎨 Feature Documentation

| Document | Purpose | When to Use | Status |
|----------|---------|-------------|--------|
| [docs/EMAIL_USAGE_TRACKING.md](docs/EMAIL_USAGE_TRACKING.md) | Usage tracking link in delivery emails | Understanding email delivery flow | ✅ Current |
| [docs/SHOPIFY_USAGE_INTEGRATION.md](docs/SHOPIFY_USAGE_INTEGRATION.md) | Backend API for usage tracking (Phase 1) | Setting up usage API backend | ✅ Current |
| [docs/SHOPIFY_FRONTEND_SETUP.md](docs/SHOPIFY_FRONTEND_SETUP.md) | Shopify theme frontend for usage (Phase 2) | Creating Shopify usage page | ✅ Current |
| [docs/DAYPASS_IMPLEMENTATION.md](docs/DAYPASS_IMPLEMENTATION.md) | Day pass eSIM implementation | Working with short-term eSIM plans | ✅ Current |
| [docs/SKU_MAPPING_FORMAT.md](docs/SKU_MAPPING_FORMAT.md) | SKU to FiRoam mapping strategy | Managing product-to-plan mappings | ✅ Current |

### 🏗️ Architecture & Design

| Document | Purpose | When to Use | Status |
|----------|---------|-------------|--------|
| [docs/architecture.md](docs/architecture.md) | System architecture overview | Understanding high-level design | ✅ Current |
| [docs/sequence.md](docs/sequence.md) | Sequence diagrams for key flows | Visualizing order fulfillment flow | ✅ Current |
| [docs/PIPELINE.md](docs/PIPELINE.md) | Data flow pipeline documentation | Understanding data transformations | ✅ Current |

### 🔧 Developer Documentation

| Document | Purpose | When to Use | Status |
|----------|---------|-------------|--------|
| [docs/UPDATE.md](docs/UPDATE.md) | Change log, version history | Checking what changed between versions | 🔄 Living doc |
| [docs/NPM_SCRIPTS_GUIDE.md](docs/NPM_SCRIPTS_GUIDE.md) | NPM command reference, quality gates, script de-duplication notes | Understanding/maintaining package scripts | ✅ Current |
| [docs/SHOPIFY_SDK_MIGRATION.md](docs/SHOPIFY_SDK_MIGRATION.md) | Migration from old to new Shopify SDK | Upgrading Shopify dependencies | ✅ Current |
| [docs/GRAPHQL_VARIABLES_EXPLAINED.md](docs/GRAPHQL_VARIABLES_EXPLAINED.md) | Shopify GraphQL variable handling | Working with Shopify GraphQL API | ✅ Current |

### 📊 Status & Internal Documentation

| Document | Purpose | When to Use | Status |
|----------|---------|-------------|--------|
| [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) | Test & CI/CD setup completion summary | Reference for what testing infrastructure exists | 🗂️ Historical |
| [docs/REFACTORING_ANALYSIS.md](docs/REFACTORING_ANALYSIS.md) | Code quality analysis & recommendations | Planning refactoring work, understanding tech debt | 🗂️ Historical |
| [docs/MONOREPO_MIGRATION_PLAN.md](docs/MONOREPO_MIGRATION_PLAN.md) | Full plan to migrate to monorepo (`fulfillment-engine` + `dashboard`) | Executing the monorepo migration or scaffolding the admin UI | 🔄 Active (Phases 6-12 pending — dashboard/ not yet scaffolded) |

### 📁 Data Files (Not Documentation)
- `FiRoam.pdf` - FiRoam vendor documentation (PDF format)
- `firoam-data/*.csv` - FiRoam package data exports
- `csv-exports/*.csv` - Shopify product/SKU mapping exports

---

### 📖 Status Legend

- **✅ Current** - Up to date, actively maintained, safe to follow
- **⚠️ Generic** - Supplementary guide, prefer specific docs when available
- **🔄 Living doc** - Frequently updated, check for latest changes
- **🗂️ Historical** - Reference/archive, may contain outdated information

> 💡 **Tip**: Always check `docs/UPDATE.md` for recent changes that might affect your task.
> 📅 **Last index update**: 2026-03-13

---

## Quick Reference: Which Doc to Use?

### "I need to..."

**Set up the project locally**
→ [docs/QUICKSTART.md](docs/QUICKSTART.md)

**Deploy to production**
→ [docs/RAILWAY_DEPLOY.md](docs/RAILWAY_DEPLOY.md) or [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

**Connect Shopify store**
→ [docs/SHOPIFY_INTEGRATION.md](docs/SHOPIFY_INTEGRATION.md)

**Understand how webhooks work**
→ [docs/WEBHOOK_IMPLEMENTATION.md](docs/WEBHOOK_IMPLEMENTATION.md)

**Work with FiRoam API**
→ [docs/FIROAM_INTEGRATION.md](docs/FIROAM_INTEGRATION.md) + [FiRoam_documentation.txt](FiRoam_documentation.txt)

**Work with TGT API**
→ [docs/TGT_INTEGRATION.md](docs/TGT_INTEGRATION.md) + [thirdparty-documentation/TGT.txt](thirdparty-documentation/TGT.txt)

**Understand TGT fulfillment modes (callback/polling/hybrid)**
→ [docs/TGT_INTEGRATION.md#fulfillment-modes](docs/TGT_INTEGRATION.md#fulfillment-modes)

**Add usage tracking to emails**
→ [docs/EMAIL_USAGE_TRACKING.md](docs/EMAIL_USAGE_TRACKING.md)

**Build usage tracking page in Shopify**
→ [docs/SHOPIFY_USAGE_INTEGRATION.md](docs/SHOPIFY_USAGE_INTEGRATION.md) (backend) + [docs/SHOPIFY_FRONTEND_SETUP.md](docs/SHOPIFY_FRONTEND_SETUP.md) (frontend)

**Understand system architecture**
→ [docs/architecture.md](docs/architecture.md) + [docs/sequence.md](docs/sequence.md)

**Map Shopify products to FiRoam plans**
→ [docs/SKU_MAPPING_FORMAT.md](docs/SKU_MAPPING_FORMAT.md)

**Check what changed recently**
→ [docs/UPDATE.md](docs/UPDATE.md)

**Understand npm scripts / quality gates**
→ [docs/NPM_SCRIPTS_GUIDE.md](docs/NPM_SCRIPTS_GUIDE.md)

**Debug Shopify GraphQL**
→ [docs/GRAPHQL_VARIABLES_EXPLAINED.md](docs/GRAPHQL_VARIABLES_EXPLAINED.md)

---

## Agent Workflow Guidelines

### When Starting a New Task

1. **Read this file first** (AGENTS.md) to understand context
2. **Check `.claude/skills/`** for reusable agent skills (see [Agent Skills Index](#agent-skills-index) below)
3. **Identify the relevant doc** from the index above
4. **Read the specific doc** for detailed instructions
5. **Check UPDATE.md** for recent changes that might affect your task
6. **Review code in src/** to understand current implementation

### When Making Changes

1. **Follow coding standards** (see Coding Standards section)
2. **Write tests** for new functionality
3. **Update relevant documentation** if behavior changes
4. **Add entry to UPDATE.md** if it's a notable change
5. **Verify build passes**: `npm run build`
6. **Run tests**: `npm test`
7. **Check for linting errors**: `npx eslint . --ext .ts --quiet`
8. **Verify TypeScript compilation**: Check VS Code problems panel or run `npm run build`

### Verification Checklist (REQUIRED After Every Code Change)

**After making ANY code changes, you MUST run these verification steps:**

```bash
# 1. Fresh type checks (includes prisma generate)
npm run type-check:fresh

# 2. Build
npm run build

# 3. Run tests
npm test -- --run

# 4. Check linting
npx eslint . --ext .ts --quiet

# 5. Optional single-command guard (equivalent)
npm run verify

# 6. If all pass, commit is safe
```

**Why this matters:**
- TypeScript errors break production builds
- Linting errors indicate code quality issues
- Test failures mean broken functionality
- These checks catch issues before deployment

**When to skip:** NEVER. Always verify after making changes.

### PR Workflow Skill (Branch → Commit → PR → Merge)

**Skill**: [`.claude/skills/create-pr/`](.claude/skills/create-pr/SKILL.md) — read `SKILL.md` for full flow details.

**Use this instead of pushing directly to main.**

```bash
# Standard flow — CI + CodeRabbit review + agent fixes + merge
npm run pr:create "feat: add email retry logic"

# With explicit branch name
npm run pr:create "fix: handle null email" "fix/null-email-handling"

# Fallback: skip CodeRabbit (use only if CodeRabbit is removed)
npm run pr:create-simple "feat: add email retry logic"
```

**What `npm run pr:create` (`agent-pr-reviewed.sh`) does automatically:**
1. Creates a branch from `main` (name derived from commit message, e.g. `feat/add-email-retry-logic`)
2. Stages all uncommitted changes (`git add -A`)
3. Commits with your message
4. Pushes the branch
5. Opens a PR against `main` via `gh pr create`
6. Polls CI checks every 15s until all pass
7. Waits up to 3 min for CodeRabbit to post its review
8. **If CodeRabbit finds issues**: prints all comments (file:line + body) and exits 2 — the agent reads the output, edits the files, then runs the fix-loop commands printed at the bottom
9. **If no issues**: squash-merges and deletes the branch automatically

**After CodeRabbit exit 2 — fix loop:**
```bash
# Agent fixes the files, then:
git add -A
git commit -m "review: address CodeRabbit feedback"
git push origin <branch>
npm run pr:merge <PR_NUMBER> "<original commit message>"
```

**When CI fails:** the script prints which checks failed and exits — you fix the code and re-run.

**Requirements:** `gh` CLI authenticated (`gh auth status`)

### When Documenting

1. **Use existing doc structure** - Don't create redundant docs
2. **Update the relevant doc** from the index above
3. **Add to this index** if creating a new doc (rare)
4. **Include code examples** - Show, don't just tell
5. **Think about the reader** - Developer? Operator? Business user?

### Common Pitfalls to Avoid

❌ Creating new docs without checking existing ones
❌ Putting code logic in markdown files (keep code in src/)
❌ Forgetting to update docs when changing APIs
❌ Using `any` types instead of proper TypeScript interfaces
❌ Hardcoding secrets instead of using environment variables
❌ Skipping idempotency checks in provisioning logic
❌ Not encrypting sensitive eSIM data (LPA, activation codes)

### Best Practices

✅ Read the relevant integration doc before modifying external API calls
✅ Check sequence.md to understand the full order flow
✅ Test webhook idempotency - send duplicate webhooks manually
✅ Verify emails render correctly in Gmail, Outlook, Apple Mail
✅ Use Zod schemas for vendor API response validation
✅ Log important events (order received, eSIM provisioned, email sent)
✅ Handle vendor API errors gracefully with retries

---

## System Constraints & Requirements

### Non-Negotiable Rules (from Original Requirements)

1. **Never provision eSIM inside webhook handler** - Always use job queue
2. **Webhook handler must be idempotent** - Check order_id + line_item_id
3. **All vendor calls happen in worker jobs** - Not in HTTP handlers
4. **Shopify webhook retries must not cause duplicate provisioning**
5. **Failures are logged and retry-limited** - No infinite retries
6. **Manual resend must be possible** - Admin can retry failed deliveries
7. **Sensitive data encrypted at rest** - LPA, activation codes, ICCID

### What's Explicitly Out of Scope (MVP)

- Embedded Shopify UI / Admin panels
- App Store distribution
- Multi-store support (single store only)
- Advanced fraud detection
- Auto-scaling / Multi-region deployment
- Kubernetes / Complex orchestration

### Success Criteria

- ✅ Customer receives eSIM within minutes of payment
- ✅ Duplicate provisioning never happens
- ✅ Failed deliveries are visible and recoverable
- ✅ Backend is simple to reason about and extend
- ✅ Usage tracking works on mobile devices
- ✅ Emails render correctly across all major clients

---

## Contact & Support

For questions about:
- **System design**: Read [docs/architecture.md](docs/architecture.md)
- **Deployment issues**: Check [docs/RAILWAY_DEPLOY.md](docs/RAILWAY_DEPLOY.md)
- **FiRoam API**: See [docs/FIROAM_INTEGRATION.md](docs/FIROAM_INTEGRATION.md) + [FiRoam_documentation.txt](FiRoam_documentation.txt)
- **TGT API**: See [docs/TGT_INTEGRATION.md](docs/TGT_INTEGRATION.md) + [thirdparty-documentation/TGT.txt](thirdparty-documentation/TGT.txt)
- **Recent changes**: Review [docs/UPDATE.md](docs/UPDATE.md)

---

**Last Updated**: March 13, 2026
**System Version**: 0.2.0
**Deployment**: Railway (Production)
**Vendors**: FiRoam (primary, sync) + TGT Technology (secondary, async callback/polling)
