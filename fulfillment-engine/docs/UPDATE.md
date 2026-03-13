# Workspace Update

> **Document Type**: Developer  
> **Status**: 🔄 Living doc  
> **Last Updated**: 2026-03-08  
> **Purpose**: Change log and version history

---

Date: 2026-03-08

Purpose: enhance TGT integration testing with comprehensive e2e flow matching FiRoam test coverage.

## What changed (2026-03-08 - Part 2)

- **Enhanced TGT integration test** ([src/tests/tgt.integration.test.ts](src/tests/tgt.integration.test.ts)):
  - Added full e2e order flow with QR code generation
  - Generates HTML + Markdown test reports (similar to FiRoam test)
  - Polls for eSIM credentials with exponential backoff
  - Validates LPA structure and extracts activation codes
  - Outputs to `test-output/tgt-*.{html,md,png}`
  - **Note**: TGT does not support order cancellation via API (only mentioned in error responses)
  
## Why this was needed

- TGT integration test was basic (56 lines) compared to FiRoam's comprehensive e2e test (838 lines)
- No QR generation or test reports for TGT orders
- No verification of actual eSIM delivery artifacts
- Needed feature parity for both vendor integration tests

---

Date: 2026-03-08

Purpose: harden TypeScript/lint verification and document npm scripts clearly.

## What changed (2026-03-08 - Part 1)

- Added stronger quality scripts in [package.json](package.json):
  - `type-check:fresh` → `prisma generate` + both TS checks
  - `verify` → full local gate (`type-check:fresh`, build, tests, lint --quiet)
  - `scripts:help` → quick human-readable command guide
- De-duplicated worker script definition:
  - `worker` is now an alias to `dev:worker` (same behavior, less duplication)
- Added defensive comments around Prisma delegate casting where stale editor diagnostics were observed:
  - [src/api/admin.ts](src/api/admin.ts)
  - [src/api/__tests__/admin.test.ts](src/api/__tests__/admin.test.ts)
- Added script reference documentation:
  - [docs/NPM_SCRIPTS_GUIDE.md](docs/NPM_SCRIPTS_GUIDE.md)

## Why this was needed

- Some TypeScript errors were editor-side diagnostics caused by stale generated types/context.
- Running a fresh Prisma generation before TS checks removes this class of false negatives.

---

Date: 2025-12-26

Purpose: concise handoff and next steps after recent FiRoam & schema work.

---

## What changed since last update

- Added `EsimOrder` Prisma model to persist canonical vendor payloads and encrypted sensitive fields. ([prisma/schema.prisma](prisma/schema.prisma))
- Introduced runtime validation with `zod` for vendor payloads:
  - `CanonicalEsimPayloadSchema` — normalized eSIM payload shape
  - `AddEsimOrderSchema` — request payload shape for `addEsimOrder`
  - `GetSkusSchema` / `SkuItemSchema` — response shape for `getSkus`
  - Files: [src/vendor/firoamSchemas.ts](src/vendor/firoamSchemas.ts)
- Hardened `FiRoamClient` ([src/vendor/firoamClient.ts](src/vendor/firoamClient.ts)):
  - Validates `addEsimOrder` inputs at runtime before sending to FiRoam.
  - Implements `getSkus()` to query vendor SKUs and validate responses.
  - Normalizes vendor responses into canonical payloads and persists them to `EsimOrder` (stores both `payloadJson` and `payloadEncrypted`).
  - Persists invalid vendor payloads with `invalid_payload` status and records validation errors.
- Replaced loose `any` casts with `Prisma.InputJsonValue` and tightened TypeScript types.
- Regenerated Prisma client and confirmed `tsc` passes locally.

---

## Current status (what's implemented)

- Project scaffold: TypeScript, ESLint, Prettier, scripts.
- Fastify server skeleton and webhook route in `src/api/webhook.ts` (handler placeholder).
- Prisma schema with `EsimDelivery`, `DeliveryAttempt`, and `EsimOrder` models.
- Crypto utilities (`src/utils/crypto.ts`) using AES-256-GCM for sensitive fields.
- FiRoam client: login/signing, `addEsimOrder`, `getOrderInfo`, `getSkus` and persistence logic.
- Worker & queue wiring (`pg-boss`) and worker job handler `provisionEsim`.

---

## Potential next todos (PR-sized, actionable)

1. API: SKUs

- Add `GET /skus` and `GET /skus/:id` endpoints that call `FiRoamClient.getSkus()` and return normalized results.
- Files: `src/api/catalog.ts`, add route registration in `src/server.ts` or API index.

2. Tests: API endpoints

- Add Vitest tests using Fastify `inject` for `GET /skus`, `GET /skus/:id`, and webhook endpoints.
- Files: `src/tests/api.catalog.test.ts`, `src/tests/api.webhook.test.ts`.

3. Webhook: persist + enqueue

- Implement idempotent persistence for `orders/paid` in `src/api/webhook.ts` (use order_id + line_item_id unique constraint or check).
- Enqueue `provision_esim` jobs with necessary payload (deliveryId + orderPayload).

4. Worker: retry policy & DLQ

- Add exponential backoff and dead-letter handling for failed provisioning jobs in pg-boss.
- Record `delivery_attempts` with result details.

5. Delivery: Email + QR generation

- Implement `src/email` service to render templates and send via Postmark/SendGrid/SES.
- Generate QR codes from LPA (use `qrcode` lib) and include fallback activation codes.

6. Admin endpoints

- Add protected admin routes to view deliveries, filter by status, retry failed deliveries, and re-send emails.

7. Validation helper

- Add `ensureAddEsimOrder(payload)` exported helper to centralize input validation/transform for reuse in webhook/tests.

8. Integration tests (E2E)

- Add an end-to-end test that mocks FiRoam (nock), enqueues a job, runs the worker handler, and asserts DB + email calls.

9. Docs & README

- Update README with environment variables, run steps, and troubleshooting (DB, migrations, FIROAM creds, ENCRYPTION_KEY rules).

10. CI & dev bootstrap

- Add GitHub Actions: `lint`, `typecheck`, `test`, and migration dry-run check.
- Add `docker-compose.yml` for Postgres + app dev convenience.

---

If you'd like I can start with one of the above; recommended first tasks: **Webhook: persist + enqueue** (connects API → worker) or **API: SKUs** (small, testable, and useful for UIs). Reply with which to start.

````markdown
# Workspace Update

Date: 2025-12-25

Purpose: provide a concise handoff for the current state of the eSIM backend and next actions for another engineer.

---

## What is done (summary)

- Project scaffold (Node.js + TypeScript)
  - package.json, tsconfig.json, ESLint, Prettier, README
- .env and .env.example created (placeholders for credentials)
- Prisma schema and client
  - `prisma/schema.prisma`
  - `src/db/prisma.ts`
- Fastify API skeleton
  - `src/server.ts`, `src/index.ts`, `src/api/webhook.ts` (webhook skeleton)
- FiRoam vendor client (implemented per documentation basics)
  - `src/vendor/firoamClient.ts` (login, signing, `addEsimOrder`, `getOrderInfo`)
- Encryption utilities
  - `src/utils/crypto.ts` (AES-256-GCM encrypt/decrypt)
- Worker + queue wiring
  - `src/queue/pgBoss.ts` (pg-boss instance)
  - `src/worker/index.ts` (worker entrypoint)
  - `src/worker/jobs/provisionEsim.ts` (provision handler)
- Added `worker` npm script

Files of interest:

- `FiRoam_documentation.txt` — vendor API spec (canonical source)

---

## How to run locally (quick)

Pre-req: Postgres available and `DATABASE_URL` set in `.env`.

1. Install deps

```bash
npm install
```

2. Generate Prisma client and run migrations

```bash
npm run prisma:generate
npm run prisma:migrate
```

3. Start dev server (API)

```bash
npm run dev
```

4. Start worker (separate process)

```bash
npm run worker
```

Notes:

- For development you can spin Postgres with Docker: `docker run -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=esim -p 5432:5432 -d postgres:15`
- Fill `.env` with FIROAM credentials to test provisioning, or mock FiRoam endpoints.

---

## Current behavior & assumptions

- Webhook handler currently only acknowledges `orders/paid` and does not enqueue jobs yet.
- Worker expects `provision_esim` jobs with `deliveryId` and `orderPayload` (FiRoam `addEsimOrder` payload shape).
- FiRoam client signs requests using the `FIROAM_SIGN_KEY` algorithm described in `FiRoam_documentation.txt`.
- Sensitive vendor fields (LPA, activation codes, ICCID) are encrypted with `ENCRYPTION_KEY` before storing in DB.

---

## Prioritized next tasks (recommended order)

1. Wire webhook to create `EsimDelivery` record and enqueue `provision_esim` job (idempotent). File: `src/api/webhook.ts`.
2. Harden worker job handling:
   - Add job retry/backoff policy and dead-letter handling in `pg-boss` configuration.
   - Add delivery attempt logging (`delivery_attempts` table integration).
3. Email + QR generation integration: generate QR from LPA and send email (Postmark/SendGrid). Create `src/email` service.
4. Shopify fulfillment creation: call Shopify Admin API after successful provisioning to mark fulfillment.
5. Admin endpoints: add protected admin routes to view deliveries, retry failed ones, and re-send emails.
6. Secrets & key management: store `ENCRYPTION_KEY` securely (vault/secret manager), consider key rotation plan.
7. Tests: unit tests for `createSign`, crypto utils, and integration tests with a mocked FiRoam.
8. CI/CD: add GitHub Actions for lint/test/build and a `docker-compose.yml` for local dev.

---

## Handoff notes for the next engineer

- Look at `src/worker/jobs/provisionEsim.ts` to understand expected `orderPayload` and DB updates.
- Use `FiRoam_documentation.txt` to verify exact request fields required by `addEsimOrder` — client implemented minimal normalization.
- Be careful: `ENCRYPTION_KEY` must be 32 bytes (hex/base64/derived). Check `src/utils/crypto.ts` for acceptance rules.

---

If you want, I can now: (A) wire the webhook to enqueue jobs, or (B) add Docker Compose and a bootstrap script for Postgres + migrations. Reply with A or B.

## Recent changes since 2025-12-25

- Added a new `EsimOrder` Prisma model to persist canonical vendor payloads and encrypted sensitive fields.
  - File: [prisma/schema.prisma](prisma/schema.prisma)

- Introduced runtime schemas with `zod` for vendor integration:
  - `CanonicalEsimPayloadSchema` for the normalized eSIM payload.
  - `AddEsimOrderSchema` for the `addEsimOrder` request payload.
  - File: [src/vendor/firoamSchemas.ts](src/vendor/firoamSchemas.ts)

- Hardened the FiRoam client (`src/vendor/firoamClient.ts`):
  - Validates `addEsimOrder` inputs using `validateAddEsimOrder()` before sending to FiRoam.
  - Validates and normalizes vendor responses into the canonical payload and persists it to `EsimOrder` (stores both `payloadJson` and `payloadEncrypted`).
  - Persists invalid vendor payloads with an `invalid_payload` status and records the validation error.

- Replaced loose `any` casts with Prisma JSON types (`Prisma.InputJsonValue`) and tightened TypeScript typings across the client.

- Added `zod` to the project and ensured TypeScript compiles cleanly after changes.

These changes make vendor interactions safer (runtime validation + typed invariants) and add a small, auditable DB model for issued eSIM payloads.

Next recommended step (small): run the Prisma migration to add the `EsimOrder` table and then run the worker once to exercise a mocked FiRoam flow.
````

# Workspace Update

Date: 2025-12-25

Purpose: provide a concise handoff for the current state of the eSIM backend and next actions for another engineer.

---

## What is done (summary)

- Project scaffold (Node.js + TypeScript)
  - package.json, tsconfig.json, ESLint, Prettier, README
- .env and .env.example created (placeholders for credentials)
- Prisma schema and client
  - `prisma/schema.prisma`
  - `src/db/prisma.ts`
- Fastify API skeleton
  - `src/server.ts`, `src/index.ts`, `src/api/webhook.ts` (webhook skeleton)
- FiRoam vendor client (implemented per documentation basics)
  - `src/vendor/firoamClient.ts` (login, signing, `addEsimOrder`, `getOrderInfo`)
- Encryption utilities
  - `src/utils/crypto.ts` (AES-256-GCM encrypt/decrypt)
- Worker + queue wiring
  - `src/queue/pgBoss.ts` (pg-boss instance)
  - `src/worker/index.ts` (worker entrypoint)
  - `src/worker/jobs/provisionEsim.ts` (provision handler)
- Added `worker` npm script

Files of interest:

- `FiRoam_documentation.txt` — vendor API spec (canonical source)

---

## How to run locally (quick)

Pre-req: Postgres available and `DATABASE_URL` set in `.env`.

1. Install deps

```bash
npm install
```

2. Generate Prisma client and run migrations

```bash
npm run prisma:generate
npm run prisma:migrate
```

3. Start dev server (API)

```bash
npm run dev
```

4. Start worker (separate process)

```bash
npm run worker
```

Notes:

- For development you can spin Postgres with Docker: `docker run -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=esim -p 5432:5432 -d postgres:15`
- Fill `.env` with FIROAM credentials to test provisioning, or mock FiRoam endpoints.

---

## Current behavior & assumptions

- Webhook handler currently only acknowledges `orders/paid` and does not enqueue jobs yet.
- Worker expects `provision_esim` jobs with `deliveryId` and `orderPayload` (FiRoam `addEsimOrder` payload shape).
- FiRoam client signs requests using the `FIROAM_SIGN_KEY` algorithm described in `FiRoam_documentation.txt`.
- Sensitive vendor fields (LPA, activation codes, ICCID) are encrypted with `ENCRYPTION_KEY` before storing in DB.

---

## Prioritized next tasks (recommended order)

1. Wire webhook to create `EsimDelivery` record and enqueue `provision_esim` job (idempotent). File: `src/api/webhook.ts`.
2. Harden worker job handling:
   - Add job retry/backoff policy and dead-letter handling in `pg-boss` configuration.
   - Add delivery attempt logging (`delivery_attempts` table integration).
3. Email + QR generation integration: generate QR from LPA and send email (Postmark/SendGrid). Create `src/email` service.
4. Shopify fulfillment creation: call Shopify Admin API after successful provisioning to mark fulfillment.
5. Admin endpoints: add protected admin routes to view deliveries, retry failed ones, and re-send emails.
6. Secrets & key management: store `ENCRYPTION_KEY` securely (vault/secret manager), consider key rotation plan.
7. Tests: unit tests for `createSign`, crypto utils, and integration tests with a mocked FiRoam.
8. CI/CD: add GitHub Actions for lint/test/build and a `docker-compose.yml` for local dev.

---

## Handoff notes for the next engineer

- Look at `src/worker/jobs/provisionEsim.ts` to understand expected `orderPayload` and DB updates.
- Use `FiRoam_documentation.txt` to verify exact request fields required by `addEsimOrder` — client implemented minimal normalization.
- Be careful: `ENCRYPTION_KEY` must be 32 bytes (hex/base64/derived). Check `src/utils/crypto.ts` for acceptance rules.

---

If you want, I can now: (A) wire the webhook to enqueue jobs, or (B) add Docker Compose and a bootstrap script for Postgres + migrations. Reply with A or B.
