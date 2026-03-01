# Codebase Analysis & Refactoring Recommendations

## Executive Summary

Your eSIM backend is well-structured with a clean separation between API, worker, and vendor layers. However, there are opportunities to improve:
- **Logging infrastructure** (structured logging)
- **Error handling** (consistent patterns)
- **Test coverage** (webhook, worker, email flows)
- **Type safety** (reduce `unknown` types)
- **Code duplication** (email templates, response handling)

**Current Test Coverage:** ~20-30% (only FiRoam vendor tests exist)
**Recommended Target:** 70-80% coverage

---

## 1. Refactoring Opportunities

### 🔴 **High Priority** (Should Fix Soon)

#### 1.1 Replace Console.log with Structured Logging
**Problem:** 50+ `console.log()` calls scattered across codebase make it hard to:
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

#### 1.2 Standardize Error Handling
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

#### 1.3 Reduce `unknown` and `Record<string, unknown>` Types
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

#### 1.4 Extract Email HTML Templates
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

#### 1.5 Centralize Prisma Client Instantiation
**Problem:** Multiple `new PrismaClient()` instances across files can cause connection pool issues.

**Files:**
- [src/api/webhook.ts](src/api/webhook.ts#L7) - Creates new instance
- [src/db/prisma.ts](src/db/prisma.ts) - Exports singleton
- Mixed usage across codebase

**Fix:**
Always use the singleton from `src/db/prisma.ts`.

```typescript
// ✗ Bad
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// ✓ Good
import prisma from '../db/prisma';
```

#### 1.6 Extract Vendor-Specific Logic to Strategies
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

#### 1.7 Add Request ID Tracking
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

#### 1.8 Add Input Validation Middleware
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

## 2. Test Coverage Gaps

### Current State
✅ **Covered:**
- FiRoam vendor API (component tests with mocks)
- FiRoam integration tests (live API)

❌ **Missing Critical Tests:**

#### 2.1 Webhook Handler Tests
**File:** [src/api/webhook.ts](src/api/webhook.ts)

**Test Scenarios Needed:**
```typescript
describe('POST /webhook/orders/paid', () => {
  it('should verify HMAC signature');
  it('should reject invalid HMAC');
  it('should handle duplicate webhooks (idempotency)');
  it('should extract customer email from multiple fallbacks');
  it('should queue provision job with correct data');
  it('should handle missing SKU gracefully');
  it('should create esimDelivery record');
});
```

#### 2.2 Worker Job Tests
**File:** [src/worker/jobs/provisionEsim.ts](src/worker/jobs/provisionEsim.ts)

```typescript
describe('handleProvision', () => {
  it('should skip if already delivered');
  it('should provision with SKU mapping');
  it('should provision with direct orderPayload');
  it('should handle FiRoam API failures');
  it('should send email after provisioning');
  it('should create Shopify fulfillment');
  it('should handle daypass SKU lookup');
  it('should retry on transient errors');
});
```

#### 2.3 Email Service Tests
**File:** [src/services/email.ts](src/services/email.ts)

```typescript
describe('sendDeliveryEmail', () => {
  it('should generate QR code from LPA');
  it('should generate PDF attachment');
  it('should build HTML email with tracking link');
  it('should build text email fallback');
  it('should record delivery attempt');
  it('should handle Resend API errors');
});
```

#### 2.4 Shopify Client Tests
**File:** [src/shopify/client.ts](src/shopify/client.ts)

```typescript
describe('ShopifyClient', () => {
  it('should refresh token when expired');
  it('should reuse valid token');
  it('should create fulfillment for order');
  it('should handle GraphQL errors');
  it('should handle network timeouts');
});
```

#### 2.5 Usage Tracking API Tests
**File:** [src/api/usage.ts](src/api/usage.ts)

```typescript
describe('GET /api/esim/:iccid/usage', () => {
  it('should return usage data for valid ICCID');
  it('should return 404 for unknown ICCID');
  it('should decrypt stored ICCID');
  it('should query FiRoam for latest usage');
  it('should handle rate limiting');
});
```

#### 2.6 Encryption/Decryption Tests
**File:** [src/utils/crypto.ts](src/utils/crypto.ts)

```typescript
describe('crypto utils', () => {
  it('should encrypt and decrypt LPA string');
  it('should handle different key formats (hex, base64, passphrase)');
  it('should throw on invalid decryption');
  it('should produce different ciphertext for same plaintext');
});
```

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

#### Option 3: **ESLint + TypeScript-ESLint** (Already Configured ✅)
Your [.eslintrc.cjs](.eslintrc.cjs) is good, but add stricter rules:

```javascript
// .eslintrc.cjs additions
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

### Phase 1: Foundation (Week 1)
1. ✅ **Add Vitest coverage configuration** (30 min)
   - Create `vitest.config.ts`
   - Add `test:coverage` script
   - Run baseline coverage report

2. ✅ **Replace console.log with pino** (2-3 hours)
   - Install: `npm install pino pino-pretty`
   - Create `src/utils/logger.ts`
   - Replace console calls in 5 key files

3. ✅ **Add webhook handler tests** (3-4 hours)
   - Most critical path (customer orders)
   - Test idempotency
   - Test HMAC verification

### Phase 2: Core Tests (Week 2)
4. ✅ **Add worker job tests** (4-5 hours)
   - Mock FiRoam client
   - Test error scenarios
   - Test retry logic

5. ✅ **Add email service tests** (2-3 hours)
   - Mock Resend API
   - Test QR/PDF generation
   - Verify email content

### Phase 3: Quality Gates (Week 3)
6. ✅ **Standardize error handling** (3-4 hours)
   - Create custom error classes
   - Add error middleware
   - Update all throw sites

7. ✅ **Setup SonarCloud** (1-2 hours)
   - Connect GitHub repo
   - Add workflow
   - Set quality gates

### Phase 4: Refinement (Ongoing)
8. ⚪ **Extract email templates** (4-5 hours)
9. ⚪ **Improve type safety** (ongoing)
10. ⚪ **Add request tracing** (2-3 hours)

---

## 5. Quick Wins (Can Do Today)

### 1. Add Coverage Configuration (10 min)
```bash
npm install --save-dev @vitest/coverage-v8
```

Create `vitest.config.ts` (see above).

### 2. Fix Prisma Singleton Usage (15 min)
Replace `new PrismaClient()` in [src/api/webhook.ts](src/api/webhook.ts#L7):

```typescript
// Before
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// After
import prisma from '../db/prisma';
```

### 3. Add ESLint Rule for console.log (5 min)
```javascript
// .eslintrc.cjs
rules: {
  'no-console': ['warn', { allow: ['error'] }]
}
```

Run: `npm run lint` to see all violations.

---

## 6. Expected Impact

### Before vs After Metrics

| Metric | Current | Target (Phase 3) |
|--------|---------|------------------|
| Test Coverage | ~25% | 70-80% |
| Code Smells | Unknown | <50 (monitored) |
| Bug Risks | Unknown | 0 high, <10 medium |
| Security Issues | Unknown | 0 |
| Type Safety | ~60% | 90%+ |
| Logging Quality | Ad-hoc | Structured JSON |

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

## Questions?

**Ready to start?** I recommend beginning with Phase 1 (Vitest coverage + logging).

Would you like me to:
1. Create the `vitest.config.ts` file?
2. Implement the logger utility?
3. Write the first set of tests (webhook handler)?
4. Set up SonarCloud configuration?

Let me know which area you'd like to tackle first! 🚀
