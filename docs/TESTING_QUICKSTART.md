# Testing & CI/CD - Quick Start

## ✅ What Was Set Up

### 1. Test Infrastructure
- ✅ [vitest.config.ts](../vitest.config.ts) - Coverage configuration (60% threshold)
- ✅ [.github/workflows/test.yml](../.github/workflows/test.yml) - PR pipeline automation
- ✅ New test scripts in package.json
- ✅ Coverage reporting with v8 provider

### 2. Initial Test Files Created
- ✅ [src/api/__tests__/webhook.test.ts](../src/api/__tests__/webhook.test.ts) - Webhook handler tests
- ✅ [src/worker/jobs/__tests__/provisionEsim.test.ts](../src/worker/jobs/__tests__/provisionEsim.test.ts) - Worker job tests
- ✅ [src/utils/__tests__/crypto.test.ts](../src/utils/__tests__/crypto.test.ts) - Encryption tests

### 3. Documentation
- ✅ [docs/BRANCH_PROTECTION.md](./BRANCH_PROTECTION.md) - Complete setup guide
- ✅ [docs/REFACTORING_ANALYSIS.md](./REFACTORING_ANALYSIS.md) - Overall strategy

---

## 🚀 Quick Commands

### Run Tests
```bash
# Run all tests (watch mode)
npm test

# Run tests once with coverage
npm run test:coverage

# Run tests with UI
npm run test:ui

# Run specific test file
npm test src/api/__tests__/webhook.test.ts
```

### Check Code Quality
```bash
# Lint code
npm run lint

# Fix linting issues
npm run lint:fix

# Type check
npm run type-check

# All quality checks
npm run lint && npm run type-check && npm run test:coverage
```

### View Coverage Report
```bash
# Generate coverage report
npm run test:coverage

# Open in browser (macOS)
open coverage/index.html

# Open in browser (Linux)
xdg-open coverage/index.html
```

---

## 📊 Current Coverage Status

Run this to see current coverage:
```bash
npm run test:coverage
```

**Expected Initial Coverage:** ~40-50% (with new tests)

**Files with Tests:**
- ✅ Webhook handler (idempotency, HMAC, email extraction)
- ✅ Worker job (SKU mapping, provisioning flow)
- ✅ Crypto utils (encryption/decryption)
- ✅ FiRoam vendor (existing - order flow, SKU discovery)

**Files Needing Tests:**
- ❌ Email service ([src/services/email.ts](../src/services/email.ts))
- ❌ Shopify client ([src/shopify/client.ts](../src/shopify/client.ts))
- ❌ Usage API ([src/api/usage.ts](../src/api/usage.ts))
- ❌ Job queue ([src/queue/jobQueue.ts](../src/queue/jobQueue.ts))

---

## 🔒 Setting Up Branch Protection

### Step 1: Go to GitHub Repository Settings
1. Navigate to your repo on GitHub
2. Settings → Branches → Add rule

### Step 2: Configure Protection for `main`
- **Branch name pattern:** `main`
- ✅ Require status checks before merging
  - Select: `Run Tests`, `Security Audit`, `Build Check`
- ✅ Require pull request before merging (1 approval)
- ✅ Require conversation resolution
- ✅ Do not allow bypassing

### Step 3: Test It
1. Create a test branch: `git checkout -b test/ci-pipeline`
2. Make a small change (e.g., add a comment)
3. Push and create PR
4. Watch automated checks run
5. Verify you cannot merge without passing checks

**Full Guide:** [docs/BRANCH_PROTECTION.md](./BRANCH_PROTECTION.md)

---

## 🎯 Next Steps (Priority Order)

### Week 1: Establish Baseline ✅ (Completed)
- [x] Create vitest.config.ts
- [x] Set up GitHub Actions workflow
- [x] Add webhook handler tests
- [x] Add worker job tests
- [x] Add crypto utils tests

### Week 2: Increase Coverage
- [ ] Add email service tests
  - Test QR code generation
  - Test PDF generation
  - Test email sending with Resend
  - Mock all external calls

- [ ] Add Shopify client tests
  - Test token refresh
  - Test order fetching
  - Test fulfillment creation
  - Mock GraphQL API

- [ ] Add usage API tests
  - Test valid ICCID lookup
  - Test 404 for unknown ICCID
  - Test rate limiting
  - Mock FiRoam usage query

### Week 3: Enforce Quality Gates
- [ ] Configure branch protection rules (see above)
- [ ] Add PR template (see BRANCH_PROTECTION.md)
- [ ] Increase coverage threshold to 70%
- [ ] Set up Codecov (optional - for PR comments)

### Week 4: Optional Enhancements
- [ ] Add integration tests for full order flow
- [ ] Add load/performance tests
- [ ] Set up SonarCloud for code quality
- [ ] Add Husky pre-commit hooks

---

## 📝 PR Workflow Example

```bash
# 1. Create feature branch
git checkout -b feature/add-email-tests

# 2. Write tests
# Create src/services/__tests__/email.test.ts

# 3. Run tests locally
npm run test:coverage

# 4. Fix any issues
npm run lint:fix
npm run type-check

# 5. Commit and push
git add .
git commit -m "Add email service tests"
git push origin feature/add-email-tests

# 6. Create PR on GitHub
# - Automated checks run automatically
# - Wait for all checks to pass
# - Request review
# - Merge after approval
```

---

## 🐛 Troubleshooting

### Tests fail in CI but pass locally
```bash
# Run tests with CI environment variables
DATABASE_URL=postgresql://testuser:testpass@localhost:5432/esim_test \
ENCRYPTION_KEY=test-encryption-key-32-bytes-long! \
NODE_ENV=test \
npm run test:coverage
```

### Coverage threshold not met
```bash
# Generate HTML report
npm run test:coverage

# Open report to see uncovered lines
open coverage/index.html

# Add tests for uncovered code
```

### ESLint errors
```bash
# Auto-fix most issues
npm run lint:fix

# Check remaining issues
npm run lint
```

### TypeScript errors
```bash
# Check type errors
npm run type-check

# Fix reported errors in your editor
```

---

## 📈 Coverage Goals

### Current Targets (vitest.config.ts)
- Lines: 60%
- Functions: 60%
- Branches: 55%
- Statements: 60%

### Progressive Goals
- **End of Month 1:** 65%
- **End of Month 2:** 70%
- **End of Month 3:** 75%
- **Long-term:** 80%+

Update thresholds in [vitest.config.ts](../vitest.config.ts) as coverage improves.

---

## 🔗 Related Documentation

- [REFACTORING_ANALYSIS.md](./REFACTORING_ANALYSIS.md) - Full refactoring plan
- [BRANCH_PROTECTION.md](./BRANCH_PROTECTION.md) - Detailed CI/CD setup
- [AGENTS.md](../AGENTS.md) - System overview and guidelines
- [QUICKSTART.md](./QUICKSTART.md) - Local development setup

---

## ❓ Common Questions

**Q: Why is my PR blocked from merging?**
A: Check the status checks on your PR. All must pass:
- ✅ Tests must pass
- ✅ Coverage must meet thresholds (60%)
- ✅ Linting must pass
- ✅ TypeScript must compile
- ✅ Must have 1+ approval

**Q: How do I skip tests for docs-only changes?**
A: The workflow already filters by path. Changes to `docs/` only won't trigger tests.

**Q: Can I bypass branch protection?**
A: No (by design). Even admins must follow the rules to maintain quality.

**Q: How do I add a new test file?**
A: Create `__tests__/filename.test.ts` next to the file you're testing. Vitest will auto-discover it.

**Q: Do I need to update the workflow file?**
A: No, unless you're adding new quality checks (e.g., security scanning).

---

## ✨ Benefits of This Setup

### For Developers
- 🛡️ Catch bugs before they reach production
- 📊 See exactly what code needs tests
- 🚀 Faster code reviews (automated checks)
- 💡 Learn from test examples

### For the Project
- 🔒 Protected main branch (no accidental breaks)
- 📈 Increasing code quality over time
- 🤖 Automated quality enforcement
- 📝 Documentation of expected behavior (tests)

### For Business
- 💰 Fewer production bugs = lower costs
- ⚡ Faster feature delivery (confidence to deploy)
- 🎯 Data-driven quality metrics
- 🔐 Better security (automated audits)

---

**Ready to merge this PR?** Once these files are on `main`, follow the branch protection setup steps!
