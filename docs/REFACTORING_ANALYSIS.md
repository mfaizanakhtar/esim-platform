# Codebase Analysis & Refactoring Recommendations

> **Document Type**: Status & Internal  
> **Status**: � In Progress  
> **Last Updated**: 2026-03-01  
> **Purpose**: Code quality analysis and refactoring recommendations

---

## Progress Snapshot (as of 2026-03-01)

| Area | Status |
|------|--------|
| Test coverage | ✅ Done — 99 tests / 11 files (was ~25%) |
| Prisma singleton | ✅ Done |
| ESLint rules | ✅ Done |
| tsconfig for test files | ✅ Done |
| Structured logging (pino) | ❌ Not started |
| Standardize error handling | ❌ Not started |
| Reduce `unknown` types | ❌ Not started |
| Extract email templates | ❌ Not started |
| Vendor strategy pattern | ❌ Not started — see §8 for full plan |
| Multi-vendor support | ❌ Not started — see §8 for full plan |
| Request ID tracking | ❌ Not started |
| Input validation (Zod) | ❌ Not started |
| SonarCloud setup | ❌ Not started |

---

## Executive Summary

Your eSIM backend is well-structured with a clean separation between API, worker, and vendor layers. However, there are opportunities to improve:
- **Logging infrastructure** (structured logging) ← **TODO**
- **Error handling** (consistent patterns) ← **TODO**
- **Test coverage** (webhook, worker, email flows) ← ✅ Done
- **Type safety** (reduce `unknown` types) ← **TODO**
- **Code duplication** (email templates, response handling) ← **TODO**

**Test Coverage as of 2026-03-01:** 99 tests, 11 test files — see breakdown in §2  
**Recommended Target:** 70-80% coverage

---

## 1. Refactoring Opportunities

### 🔴 **High Priority** (Should Fix Soon)

#### 1.1 Replace Console.log with Structured Logging — ❌ NOT DONE
**Problem:** 157 `console.*` calls remain in production code (surfaced by `no-console: warn` ESLint rule added 2026-03-01). Hard to:
- Filter logs by severity
- Query logs in production
- Add contextual metadata (requestId, userId, etc.)

**Files Affected:**
- [src/shopify/client.ts](src/shopify/client.ts)
- [src/vendor/firoamClient.ts](src/vendor/firoamClient.ts)
- [src/services/email.ts](src/services/email.ts)
- [src/worker/jobs/provisionEsim.ts](src/worker/jobs/provisionEsim.ts)
- [src/api/webhooks.ts](src/api/webhooks.ts)

**Recommendation:**
Use **pino** (fast, structured JSON logging) or **winston**.

**Example Implementation:**
```typescript
// src/utils/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' 
    ? { target: 'pino-pretty' } 
    : undefined
});

// Usage
logger.info({ orderId, deliveryId }, 'Processing eSIM delivery');
logger.error({ error: err.message }, 'Failed to provision eSIM');
```

#### 1.2 Standardize Error Handling — ❌ NOT DONE
**Problem:** Inconsistent error handling patterns:
- Some functions throw errors
- Some return `{ error: string }`
- Some catch and log but don't rethrow

**Example Issues:**
```typescript
// src/worker/jobs/provisionEsim.ts - mixes patterns
throw new Error('Missing SKU');  // ✓ Good
return { ok: false, reason: 'failed' };  // ✗ Inconsistent

// src/services/email.ts - catches but doesn't propagate
catch (error) {
  console.error('[EmailService] Failed:', error);
  // No rethrow - caller doesn't know it failed!
}
```

**Recommendation:**
Create custom error classes + centralized error handler.

```typescript
// src/utils/errors.ts
export class ProvisionError extends Error {
  constructor(
    message: string,
    public code: string,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'ProvisionError';
  }
}

// Usage
throw new ProvisionError('FiRoam API unavailable', 'VENDOR_TIMEOUT', true);
```

#### 1.3 Reduce `unknown` and `Record<string, unknown>` Types — ❌ NOT DONE
**Problem:** 50+ uses of `unknown` or loose typing reduce TypeScript safety.

**Files to Improve:**
- [src/vendor/firoamClient.ts](src/vendor/firoamClient.ts) - Response parsing
- [src/worker/jobs/provisionEsim.ts](src/worker/jobs/provisionEsim.ts) - Job data
- [src/api/webhook.ts](src/api/webhook.ts) - Webhook payload

**Example Fix:**
```typescript
// Before
function extractOrderNumber(response: unknown): string | undefined {
  const resp = response as Record<string, unknown>;
  // ...
}

// After
interface FiRoamOrderResponse {
  code: number;
  message?: string;
  data?: {
    orderNum?: string;
  };
}

function extractOrderNumber(response: FiRoamOrderResponse): string | undefined {
  return response.data?.orderNum;
}
```

### 🟡 **Medium Priority** (Should Address)

#### 1.4 Extract Email HTML Templates — ❌ NOT DONE
**Problem:** 350+ lines of HTML string concatenation in [src/services/email.ts](src/services/email.ts#L425-L757) is:
- Hard to maintain
- Difficult to test rendering
- Not reusable for other email types

**Recommendation:**
Use a template engine (Handlebars, EJS, or React Email).

**Example with Handlebars:**
```typescript
// src/templates/esim-delivery.hbs
<html>
  <body>
    <h1>Your eSIM for {{productName}}</h1>
    <img src="cid:qr-code" alt="QR Code" />
    {{#if region}}
      <p>Region: {{region}}</p>
    {{/if}}
  </body>
</html>

// src/services/email.ts
import Handlebars from 'handlebars';
import fs from 'fs/promises';

const template = Handlebars.compile(
  await fs.readFile('./templates/esim-delivery.hbs', 'utf-8')
);

const html = template({ productName, region, qrCodeCid });
```

#### 1.5 Centralize Prisma Client Instantiation — ✅ DONE (2026-03-01)
**Fix applied:** `src/api/webhook.ts` now uses `import prisma from '../db/prisma'` singleton. All other files were already correct.

~~**Problem:** Multiple `new PrismaClient()` instances across files can cause connection pool issues.~~

~~**Files:**~~
- ~~[src/api/webhook.ts](src/api/webhook.ts#L7) - Creates new instance~~
- ~~[src/db/prisma.ts](src/db/prisma.ts) - Exports singleton~~
- ~~Mixed usage across codebase~~

**Fix:**
Always use the singleton from `src/db/prisma.ts`.

```typescript
// ✗ Bad
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// ✓ Good
import prisma from '../db/prisma';
```

#### 1.6 Extract Vendor-Specific Logic to Strategies — ❌ NOT DONE
**Problem:** [src/worker/jobs/provisionEsim.ts](src/worker/jobs/provisionEsim.ts#L78) hardcodes FiRoam logic.

**Current:**
```typescript
if (mapping.provider !== 'firoam') {
  throw new Error(`Unsupported provider: ${mapping.provider}`);
}
// ... 100 lines of FiRoam-specific code
```

**Recommended Pattern:**
```typescript
// src/vendor/providers/ProviderStrategy.ts
interface ProviderStrategy {
  provision(mapping: ProviderSkuMapping): Promise<EsimPayload>;
}

class FiRoamStrategy implements ProviderStrategy {
  async provision(mapping: ProviderSkuMapping) {
    // FiRoam-specific logic
  }
}

// Usage
const strategy = providerFactory.get(mapping.provider);
const esim = await strategy.provision(mapping);
```

### 🟢 **Low Priority** (Nice to Have)

#### 1.7 Add Request ID Tracking — ❌ NOT DONE
For distributed tracing across API → Queue → Worker.

```typescript
// src/middleware/requestId.ts
fastify.addHook('onRequest', async (request, reply) => {
  request.id = crypto.randomUUID();
  reply.header('X-Request-Id', request.id);
});

// Pass through queue jobs
await boss.send('provision-esim', { 
  ...jobData, 
  requestId: request.id 
});
```

#### 1.8 Add Input Validation Middleware — ❌ NOT DONE
Use Zod or TypeBox for route validation.

```typescript
// src/api/webhook.ts
const OrderPaidSchema = z.object({
  id: z.number(),
  email: z.string().email(),
  line_items: z.array(z.object({
    sku: z.string().optional()
  }))
});

app.post('/orders/paid', async (req, reply) => {
  const order = OrderPaidSchema.parse(req.body);
  // ...
});
```

---

## 2. Test Coverage

### Current State (as of 2026-03-01) — ✅ ALL DONE

**99 tests / 11 test files — all passing**

| Test File | Tests | Status |
|-----------|-------|--------|
| `src/api/__tests__/webhook.test.ts` | 16 | ✅ |
| `src/api/__tests__/usage.test.ts` | 9 | ✅ |
| `src/services/__tests__/email.test.ts` | 9 | ✅ |
| `src/shopify/__tests__/client.test.ts` | 12 | ✅ |
| `src/worker/jobs/__tests__/provisionEsim.test.ts` | 14 | ✅ |
| `src/utils/__tests__/crypto.test.ts` | 21 | ✅ |
| `src/tests/firoam.component.test.ts` | 3 | ✅ |
| `src/tests/firoam.cancelOrder.component.test.ts` | 7 | ✅ |
| `src/tests/firoam.orderFlow.component.test.ts` | 1 | ✅ |
| `src/tests/firoam.flexibleOrderFlow.component.test.ts` | 4 | ✅ |
| `src/tests/firoam.getSkus.component.test.ts` | 3 | ✅ |

### Notable patterns established
- Use `const mocks = vi.hoisted(...)` (single object ref) for mocks needed in `vi.mock` factories
- Nock for Shopify HTTP calls (no axios mocking needed)
- `makeDelivery(overrides)` factory pattern for Prisma model fixtures
- `tsconfig.test.json` + `npm run type-check:all` to type-check test files (excluded from main build)

### Previously Missing — Now Covered

#### 2.1 Webhook Handler Tests — ✅ DONE
**File:** [src/api/__tests__/webhook.test.ts](src/api/__tests__/webhook.test.ts) (16 tests)
- HMAC signature verification / rejection
- Duplicate webhook idempotency
- Customer email extraction fallbacks
- Job queuing with correct data
- Missing SKU handling
- esimDelivery record creation

#### 2.2 Worker Job Tests — ✅ DONE
**File:** [src/worker/jobs/__tests__/provisionEsim.test.ts](src/worker/jobs/__tests__/provisionEsim.test.ts) (14 tests)
- Skip if already delivered
- Provision with SKU mapping
- Provision with direct orderPayload
- FiRoam API failure handling
- Email sent after provisioning
- Shopify fulfillment creation
- Daypass SKU lookup

#### 2.3 Email Service Tests — ✅ DONE
**File:** [src/services/__tests__/email.test.ts](src/services/__tests__/email.test.ts) (9 tests)
- QR code generation from LPA
- PDF attachment generation
- Correct recipient / subject
- Resend API error handling
- Missing API key guard
- recordDeliveryAttempt DB write

#### 2.4 Shopify Client Tests — ✅ DONE
**File:** [src/shopify/__tests__/client.test.ts](src/shopify/__tests__/client.test.ts) (12 tests)
- Token cached within validity window
- Concurrent refresh deduplicated
- Token refresh failure
- createFulfillment happy path
- GraphQL errors / order not found
- No fulfillable orders / all closed
- userErrors from mutation

#### 2.5 Usage Tracking API Tests — ✅ DONE
**File:** [src/api/__tests__/usage.test.ts](src/api/__tests__/usage.test.ts) (9 tests)
- Valid ICCID returns usage data
- Unknown ICCID → 404
- ICCID decryption
- FiRoam query integration

#### 2.6 Encryption/Decryption Tests — ✅ DONE
**File:** [src/utils/__tests__/crypto.test.ts](src/utils/__tests__/crypto.test.ts) (21 tests)
- Encrypt/decrypt roundtrip
- Different key formats
- Invalid decryption throws

### Test Organization Recommendation

```
src/
├── api/
│   ├── webhook.ts
│   └── __tests__/
│       ├── webhook.test.ts
│       └── usage.test.ts
├── services/
│   ├── email.ts
│   └── __tests__/
│       └── email.test.ts
├── worker/
│   └── jobs/
│       ├── provisionEsim.ts
│       └── __tests__/
│           └── provisionEsim.test.ts
└── shopify/
    ├── client.ts
    └── __tests__/
        └── client.test.ts
```

---

## 3. Code Quality Tools Recommendations

### 🎯 **Recommended: SonarCloud** (Free for Open Source)

**Why SonarCloud:**
- ✅ Zero infrastructure (cloud-based)
- ✅ Automatic PR checks
- ✅ Tracks code coverage trends
- ✅ Detects code smells, bugs, security issues
- ✅ TypeScript support
- ✅ Free for public repos

**Setup Steps:**

```yaml
# .github/workflows/sonarcloud.yml
name: SonarCloud Analysis
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  sonarcloud:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run tests with coverage
        run: npm run test:coverage
      
      - name: SonarCloud Scan
        uses: SonarSource/sonarcloud-github-action@master
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

```properties
# sonar-project.properties
sonar.projectKey=your-org_esim_backend
sonar.organization=your-org
sonar.sources=src
sonar.tests=src
sonar.test.inclusions=**/*.test.ts,**/*.spec.ts
sonar.javascript.lcov.reportPaths=coverage/lcov.info
sonar.coverage.exclusions=**/*.test.ts,**/tests/**
```

### Alternative Tools

#### Option 2: **Codecov** (Coverage Only)
- Simpler, focuses only on coverage tracking
- Great PR comments showing coverage changes
- Free for open source

```yaml
# .github/workflows/codecov.yml
- name: Upload coverage to Codecov
  uses: codecov/codecov-action@v3
  with:
    files: ./coverage/lcov.info
```

#### Option 3: **ESLint + TypeScript-ESLint** — ✅ DONE (2026-03-01)
The following rules were added to [.eslintrc.cjs](.eslintrc.cjs):

```javascript
// .eslintrc.cjs — already applied
rules: {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unused-vars': ['error', { 
    argsIgnorePattern: '^_' 
  }],
  '@typescript-eslint/explicit-function-return-type': 'warn',
  'no-console': 'warn', // Enforce logger usage
}
```

#### Option 4: **Vitest Coverage** (Built-in)
Already using Vitest, just add coverage config:

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        'scripts/',
        'prisma/'
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70
      }
    }
  }
});
```

**Add to package.json:**
```json
{
  "scripts": {
    "test": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:ui": "vitest --ui"
  }
}
```

---

## 4. Implementation Priority

### Phase 1: Foundation — ✅ DONE
1. ✅ **Add Vitest coverage configuration** — existing `vitest.config.ts` used; `tsconfig.test.json` + `type-check:all` added (2026-03-01)
2. ❌ **Replace console.log with pino** — 157 warnings surfaced by ESLint `no-console`, but pino not yet installed or implemented
3. ✅ **Add webhook handler tests** — 16 tests in `src/api/__tests__/webhook.test.ts`

### Phase 2: Core Tests — ✅ DONE
4. ✅ **Add worker job tests** — 14 tests in `src/worker/jobs/__tests__/provisionEsim.test.ts`
5. ✅ **Add email service tests** — 9 tests in `src/services/__tests__/email.test.ts`

### Phase 3: Quality Gates — ❌ NOT DONE
6. ❌ **Standardize error handling** — custom error classes not created; throw patterns still inconsistent
7. ❌ **Setup SonarCloud** — not configured

### Phase 4: Refinement — ❌ NOT DONE
8. ❌ **Extract email templates** (4-5 hours)
9. ❌ **Improve type safety / reduce `unknown`** (ongoing)
10. ❌ **Add request tracing** (2-3 hours)

---

## 5. Quick Wins

### 1. Add Coverage Configuration — ✅ DONE (2026-03-01)
`tsconfig.test.json` created, `npm run type-check:all` script added. `@vitest/coverage-v8` was already installed.

### 2. Fix Prisma Singleton Usage — ✅ DONE (2026-03-01)
`src/api/webhook.ts` now imports `prisma` from `'../db/prisma'` singleton.

### 3. Add ESLint Rule for console.log — ✅ DONE (2026-03-01)
Added to `.eslintrc.cjs`: `'no-console': ['warn', { allow: ['error'] }]`  
Result: 157 warnings surfaced — all in production code. **Next step: replace with pino.**

---

## 6. Expected Impact

### Before vs After Metrics

| Metric | Before (2026-03-01) | After (2026-03-01) | Target |
|--------|---------------------|---------------------|--------|
| Test files | 5 | 11 | — |
| Total tests | ~25 | **99** | 70-80% coverage |
| `any` in prod code | unchecked | **0 (lint error)** | 0 |
| console.* calls | unchecked | 157 warnings surfaced | 0 |
| Prisma singletons | 1 leak | ✅ fixed | — |
| Type Safety | ~60% | ~65% | 90%+ |
| Logging Quality | Ad-hoc `console.*` | Ad-hoc (warned) | Structured JSON (pino) |

### Business Benefits
- 🚀 **Faster debugging** - Structured logs searchable in production
- 🛡️ **Fewer bugs** - High test coverage catches issues before deployment
- 📊 **Data-driven** - SonarCloud metrics guide improvements
- 🔐 **More secure** - Automated security scanning
- 🤝 **Easier onboarding** - Well-tested code is self-documenting

---

## 7. Resources & Next Steps

### Documentation to Create
1. **TESTING.md** - Testing guidelines and patterns
2. **LOGGING.md** - Logging standards and examples
3. **ERROR_HANDLING.md** - Error handling conventions

### Dependencies to Add
```json
{
  "dependencies": {
    "pino": "^8.17.2",
    "pino-pretty": "^10.3.1"
  },
  "devDependencies": {
    "@vitest/coverage-v8": "^4.0.16",
    "@vitest/ui": "^4.0.16"
  }
}
```

### Commands to Add
```json
{
  "scripts": {
    "test:coverage": "vitest run --coverage",
    "test:ui": "vitest --ui",
    "test:watch": "vitest",
    "lint:fix": "eslint . --ext .ts --fix",
    "type-check": "tsc --noEmit"
  }
}
```

---

## 8. Multi-Vendor Architecture Plan

> **Goal**: Make it easy to add new eSIM vendors (Airalo, eSIM World, Truphone, etc.) without touching the job handler, and allow SKU-to-vendor mappings to be managed at runtime without deploys.

### 8.1 What's Already in Good Shape

| Asset | Why It Helps |
|-------|--------------|
| `ProviderSkuMapping.provider` field in DB | Already stores the vendor name string (`'firoam'`) per mapping |
| `CanonicalEsimPayload` type in `firoamSchemas.ts` | Normalization concept already exists — just needs to be elevated to a shared interface |
| `src/vendor/firoamClient.ts` encapsulates FiRoam HTTP | The HTTP+auth complexity is already isolated — just needs a wrapper class |
| Admin route layer in `src/api/admin.ts` | Good place to add SKU mapping CRUD endpoints |

---

### 8.2 The Core Problem Today

`src/worker/jobs/provisionEsim.ts` is doing **two jobs at once**:

1. **Orchestration** — find delivery → update status → store eSIM → send email → Shopify fulfillment  
2. **FiRoam-specific provisioning** — parse `skuId:apiCode:priceId`, handle daypass package lookup, call `fiRoam.addEsimOrder()`, extract `vendorOrderNum` from the response

The FiRoam logic is baked in at lines 5, 77–180, and 189:

```typescript
// Hard to change:
const fiRoam = new FiRoamClient();          // module-level singleton, always FiRoam
...
if (mapping.provider !== 'firoam') {         // explicit block on every other vendor
  throw new Error(`Unsupported provider`);
}
// 100 lines of FiRoam-specific parsing...
const result = await fiRoam.addEsimOrder(orderPayload);  // direct call
```

To add Airalo today you'd have to fork the entire job handler into a parallel `if/else` block — messy and untestable.

**Also:** `providerSku` in the DB is a FiRoam-specific colon-delimited string (`"skuId:apiCode:priceId"`). Airalo uses a slug (`"airalo-package-slug"`). There's no way to store both cleanly without a schema change.

---

### 8.3 Recommended Architecture

#### Step 1 — Define a `VendorProvider` interface

**New file:** `src/vendor/types.ts`

```typescript
export interface EsimProvisionResult {
  vendorOrderId: string;    // vendor's internal order reference
  lpa: string;              // LPA string for QR code
  activationCode: string;   // manual activation code
  iccid: string;            // SIM identifier
}

// What the provider receives from the DB mapping row
export interface ProviderMappingConfig {
  providerSku: string;               // opaque — each provider knows how to parse it
  providerConfig?: Record<string, unknown> | null;  // JSON extras (see §8.4)
  packageType?: string | null;       // 'fixed' | 'daypass' (FiRoam concept, optional for others)
  daysCount?: number | null;
}

export interface VendorProvider {
  readonly name: string;
  provision(
    config: ProviderMappingConfig,
    context: { customerEmail: string; quantity: number }
  ): Promise<EsimProvisionResult>;
}
```

This is the **only contract** the job handler cares about.

---

#### Step 2 — Wrap FiRoam logic in a `FiRoamProvider` class

**New file:** `src/vendor/providers/firoam.ts`

Move everything FiRoam-specific **out of** `provisionEsim.ts` **into** this class:

```typescript
import { VendorProvider, ProviderMappingConfig, EsimProvisionResult } from '../types';
import FiRoamClient from '../firoamClient';

export class FiRoamProvider implements VendorProvider {
  readonly name = 'firoam';
  private client = new FiRoamClient();

  async provision(
    config: ProviderMappingConfig,
    ctx: { customerEmail: string; quantity: number }
  ): Promise<EsimProvisionResult> {
    // All the logic currently in provisionEsim.ts lines 85–189 moves here:
    // 1. Parse providerSku ("skuId:apiCode:priceId")
    // 2. Handle daypass package lookup (getPackages + filter)
    // 3. Build the orderPayload
    // 4. Call this.client.addEsimOrder(orderPayload)
    // 5. Extract vendorOrderNum from response
    // 6. Return EsimProvisionResult
  }
}
```

The existing `FiRoamClient` (auth, signing, HTTP) **stays unchanged** — `FiRoamProvider` just wraps it.

---

#### Step 3 — Provider registry / factory

**New file:** `src/vendor/registry.ts`

```typescript
import { VendorProvider } from './types';
import { FiRoamProvider } from './providers/firoam';

const registry = new Map<string, VendorProvider>([
  ['firoam', new FiRoamProvider()],
  // To add Airalo later: ['airalo', new AiraloProvider()]
]);

export function getProvider(name: string): VendorProvider {
  const provider = registry.get(name);
  if (!provider) {
    throw new Error(`Unsupported eSIM provider: "${name}". Registered: [${[...registry.keys()].join(', ')}]`);
  }
  return provider;
}
```

---

#### Step 4 — Clean up `provisionEsim.ts`

After the above, the job handler shrinks to pure orchestration. The vendor block goes from ~130 lines to ~5:

```typescript
// Before: 130 lines of FiRoam-specific code
// After:
const provider = getProvider(mapping.provider);
const esim = await provider.provision(
  {
    providerSku: mapping.providerSku,
    providerConfig: mapping.providerConfig,
    packageType: mapping.packageType,
    daysCount: mapping.daysCount,
  },
  { customerEmail: delivery.customerEmail, quantity: lineItem.quantity ?? 1 }
);
// esim.lpa, esim.activationCode, esim.iccid, esim.vendorOrderId
```

No more `if (mapping.provider !== 'firoam')` guard needed.

---

### 8.4 Database Schema Change

The `providerSku` field currently stores a FiRoam-specific colon-delimited string. Other vendors won't use this format. The cleanest solution:

**Keep `providerSku` as an opaque string** (each provider's class knows how to parse its own format), and **add a `providerConfig Json?` field** for vendor-specific structured extras:

```prisma
model ProviderSkuMapping {
  id           Int       @id @default(autoincrement())
  shopifySku   String    @unique
  provider     String    // 'firoam' | 'airalo' | etc.
  providerSku  String    // opaque — interpreted by the provider class
  providerConfig Json?   // NEW: vendor-specific structured data
  // FiRoam extras (keep for backwards compat or migrate into providerConfig)
  packageType  String?   @default("fixed")
  daysCount    Int?
  // Generic display fields — fine for all vendors
  name         String?
  region       String?
  dataAmount   String?
  validity     String?
  isActive     Boolean   @default(true)  // NEW: soft-delete support
  updatedAt    DateTime  @updatedAt      // NEW: audit trail
}
```

**FiRoam example row:**
```json
{ "provider": "firoam", "providerSku": "12345:ABC:67890", "packageType": "daypass", "daysCount": 30 }
```

**Airalo example row (future):**
```json
{ "provider": "airalo", "providerSku": "airalo-europe-5gb", "providerConfig": { "brand": "airalo", "type": "data" } }
```

This is a **non-breaking migration** — existing FiRoam rows stay as-is, `providerConfig` is nullable.

---

### 8.5 SKU Mapping Admin API

The `src/api/admin.ts` already handles delivery management. Add SKU mapping CRUD to the same file:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/admin/sku-mappings` | List all mappings (filterable by `?provider=firoam`) |
| `POST` | `/admin/sku-mappings` | Create a new Shopify SKU → vendor mapping |
| `PUT` | `/admin/sku-mappings/:id` | Update mapping (change vendor, fix providerSku, toggle isActive) |
| `DELETE` | `/admin/sku-mappings/:id` | Soft-delete (sets `isActive: false`) |

**Key use cases this enables:**
- Switch a product from FiRoam to Airalo: change `provider` + `providerSku` on the mapping row
- Deactivate a plan that's no longer sold: set `isActive: false`
- Add a new vendor's product: POST a new mapping row

No code deploy needed for any of these.

---

### 8.6 File Structure After Refactoring

```
src/vendor/
├── types.ts                    ← NEW: VendorProvider interface, EsimProvisionResult
├── registry.ts                 ← NEW: provider registry + getProvider() factory
├── firoamClient.ts             ← UNCHANGED: FiRoam HTTP client
├── firoamSchemas.ts            ← UNCHANGED: Zod schemas for FiRoam responses
└── providers/
    ├── firoam.ts               ← NEW: FiRoamProvider implements VendorProvider
    └── airalo.ts               ← FUTURE: AiraloProvider implements VendorProvider

src/worker/jobs/
└── provisionEsim.ts            ← SIMPLIFIED: orchestration only, calls getProvider()

prisma/
└── schema.prisma               ← ADD: providerConfig Json?, isActive Boolean, updatedAt
```

---

### 8.7 Adding a New Vendor (What It Looks Like After)

Once the pattern is in place, adding Airalo is a **3-file change + DB migration**:

1. **Create** `src/vendor/providers/airalo.ts` implementing `VendorProvider`
2. **Register** it in `src/vendor/registry.ts`: `registry.set('airalo', new AiraloProvider())`
3. **Write tests** in `src/vendor/providers/__tests__/airalo.test.ts`
4. **Add DB rows** via the admin API for each Airalo SKU

Zero changes to `provisionEsim.ts`, `webhook.ts`, email, or Shopify fulfillment logic.

---

### 8.8 Migration Path (Non-Breaking)

This refactoring is **fully backwards-compatible**. The migration is:

1. ✅ Create `src/vendor/types.ts` — new file, nothing depends on it yet
2. ✅ Create `src/vendor/providers/firoam.ts` — extract logic from `provisionEsim.ts`
3. ✅ Create `src/vendor/registry.ts` — register FiRoamProvider
4. ✅ Update `provisionEsim.ts` — replace ~130 lines with `getProvider()` call
5. ✅ Add `providerConfig`/`isActive`/`updatedAt` to Prisma schema — non-breaking, all nullable
6. ✅ Run `prisma migrate dev` — existing rows unaffected
7. ✅ Add admin API endpoints for SKU mapping CRUD

At no point does FiRoam stop working. The behaviour is identical — just reorganized.

---

### 8.9 Effort Estimate

| Task | Estimate |
|------|----------|
| Define `types.ts` interface | 30 min |
| Create `FiRoamProvider` (extract from job) | 2–3 hours |
| Create `registry.ts` | 30 min |
| Update `provisionEsim.ts` to use registry | 1 hour |
| Schema migration (`providerConfig`, `isActive`) | 1 hour |
| Admin API SKU mapping CRUD | 2–3 hours |
| Tests for `FiRoamProvider` (unit) | 2 hours |
| **Total** | **~9–11 hours** |

---

### 8.10 Recommended Order of Work

1. **Start with `types.ts`** — defines the contract everything else builds on
2. **Create `FiRoamProvider`** — copy/refactor existing logic, existing tests still pass
3. **Create `registry.ts`** — one-liner change to how the job finds the vendor
4. **Simplify `provisionEsim.ts`** — replace the FiRoam block with `getProvider()` call
5. **Schema migration** — add `providerConfig`/`isActive` columns
6. **Admin API** — CRUD endpoints for mapping management
7. **Add Airalo** (when ready) — just implement the interface, register, done
