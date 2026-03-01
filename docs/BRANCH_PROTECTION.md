# Branch Protection & PR Pipeline Setup

This guide explains how to configure GitHub branch protection rules to ensure code quality and prevent breaking changes from reaching `main`.

---

## Overview

**Goal:** Ensure all code merged to `main` branch:
- ✅ Passes all tests
- ✅ Meets coverage thresholds (60%+)
- ✅ Has no linting errors
- ✅ Has no TypeScript compilation errors
- ✅ Is reviewed by at least one other developer

---

## GitHub Actions Workflow

The [.github/workflows/test.yml](../.github/workflows/test.yml) workflow runs automatically on:
- Pull requests to `main` or `develop`
- Direct pushes to `main` (for verification)

**What It Checks:**
1. **Tests** - Runs full test suite with coverage
2. **Linting** - Checks code style with ESLint
3. **Type Checking** - Validates TypeScript types
4. **Build** - Ensures code compiles successfully
5. **Security** - Runs `npm audit` for vulnerabilities
6. **Coverage** - Enforces thresholds defined in `vitest.config.ts`

---

## Setting Up Branch Protection

### Step 1: Navigate to Repository Settings

1. Go to your repository on GitHub
2. Click **Settings** tab
3. Click **Branches** in the left sidebar
4. Click **Add rule** (or edit existing rule for `main`)

### Step 2: Configure Branch Protection Rule

**Branch name pattern:** `main`

#### Required Status Checks

Enable: **✅ Require status checks to pass before merging**

Select these checks (from `.github/workflows/test.yml`):
- ✅ `Run Tests`
- ✅ `Security Audit`
- ✅ `Build Check`

Enable: **✅ Require branches to be up to date before merging**
- Forces developers to rebase/merge `main` before their PR can be merged

#### Pull Request Requirements

Enable: **✅ Require a pull request before merging**

Options:
- **Require approvals:** `1` (at least one approval required)
- **Dismiss stale reviews:** ✅ (re-request review after new commits)
- **Require review from Code Owners:** Optional (if you have CODEOWNERS file)

#### Additional Rules

Enable: **✅ Require conversation resolution before merging**
- All PR comments must be resolved

Enable: **✅ Do not allow bypassing the above settings**
- Even admins must follow these rules (recommended for production)

Optional:
- **Include administrators:** ✅ (enforce rules on admins too)
- **Restrict who can push to matching branches:** Optional (limit to specific teams)

### Step 3: Save Protection Rule

Click **Create** or **Save changes**

---

## Required Secrets

Add these secrets to your repository for the workflow to function:

### Repository Secrets (Settings → Secrets → Actions)

| Secret Name | Description | Required |
|-------------|-------------|----------|
| `CODECOV_TOKEN` | Codecov upload token | Optional (only if using Codecov) |
| `SHOPIFY_WEBHOOK_SECRET` | Shopify webhook secret (for integration tests) | Optional |
| `FIROAM_PHONE` | FiRoam test credentials | Optional (for integration tests) |
| `FIROAM_PASSWORD` | FiRoam test credentials | Optional (for integration tests) |

**Note:** The test workflow uses a PostgreSQL service container, so no DATABASE_URL secret is needed.

---

## Local Pre-commit Checks (Optional)

### Install Husky for Git Hooks

```bash
npm install --save-dev husky lint-staged
npx husky install
```

### Add Pre-commit Hook

```bash
npx husky add .husky/pre-commit "npm run lint && npm run type-check"
```

### Add Pre-push Hook

```bash
npx husky add .husky/pre-push "npm run test:coverage"
```

This ensures developers catch issues before pushing to GitHub.

---

## Workflow Triggers

### Automatic Triggers

```yaml
on:
  pull_request:
    branches: [main, develop]
    paths:
      - 'src/**'
      - 'prisma/**'
      - 'package.json'
      - 'vitest.config.ts'
```

**Runs when:**
- Pull request opened to `main` or `develop`
- Pull request updated (new commits pushed)
- Only if relevant files changed (not docs-only changes)

### Manual Trigger (Optional)

Add to workflow file:
```yaml
on:
  workflow_dispatch:  # Allows manual runs from GitHub UI
```

---

## Coverage Thresholds

Defined in [vitest.config.ts](../vitest.config.ts):

```typescript
coverage: {
  thresholds: {
    lines: 60,       // 60% of lines must be covered
    functions: 60,   // 60% of functions must be covered
    branches: 55,    // 55% of branches must be covered
    statements: 60,  // 60% of statements must be covered
  }
}
```

**CI will fail if coverage drops below these thresholds.**

### Increasing Thresholds Over Time

As you add more tests:
1. Update thresholds in `vitest.config.ts`
2. Commit the change
3. PR will ensure new threshold is met before merging

---

## PR Checklist Template

Create [.github/pull_request_template.md](../.github/pull_request_template.md):

```markdown
## Description
<!-- What changes does this PR introduce? -->

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Refactoring
- [ ] Documentation update
- [ ] Test coverage improvement

## Testing
- [ ] All tests pass locally
- [ ] Added new tests for changes
- [ ] Coverage thresholds met

## Checklist
- [ ] Code follows style guidelines (ESLint passes)
- [ ] TypeScript compilation succeeds
- [ ] Documentation updated (if needed)
- [ ] No console.log statements (use logger)
- [ ] Sensitive data encrypted (if applicable)

## Related Issues
<!-- Link to related issues: Fixes #123 -->
```

---

## Example PR Workflow

### Developer Perspective

1. **Create feature branch**
   ```bash
   git checkout -b feature/add-usage-api-tests
   ```

2. **Make changes and add tests**
   ```bash
   # Edit code
   # Add tests
   npm run test:coverage  # Verify locally
   ```

3. **Commit and push**
   ```bash
   git add .
   git commit -m "Add usage API tests"
   git push origin feature/add-usage-api-tests
   ```

4. **Create pull request on GitHub**
   - Automated checks run (see `.github/workflows/test.yml`)
   - Status checks appear on PR:
     - ✅ Run Tests
     - ✅ Security Audit
     - ✅ Build Check

5. **Address failures (if any)**
   - View failed check logs
   - Fix issues locally
   - Push new commits (checks re-run automatically)

6. **Request review**
   - Once all checks pass
   - Assign reviewer

7. **Merge after approval**
   - All checks ✅
   - 1+ approval ✅
   - Merge button enabled

### Reviewer Perspective

1. **Check CI status** - All checks must be green
2. **Review code changes** - Look for:
   - Code quality
   - Test coverage
   - Security concerns
   - Performance implications
3. **Request changes or approve**
4. **Merge** (if you have permissions)

---

## Troubleshooting

### ❌ Test failures in CI but pass locally

**Cause:** Environment differences

**Solution:**
```bash
# Run tests in CI-like environment
DATABASE_URL=postgresql://testuser:testpass@localhost:5432/esim_test \
ENCRYPTION_KEY=test-encryption-key-32-bytes-long! \
NODE_ENV=test \
npm run test:coverage
```

### ❌ Coverage threshold not met

**Cause:** New code not covered by tests

**Solution:**
```bash
# Generate coverage report
npm run test:coverage

# Open coverage report
open coverage/index.html

# Identify uncovered lines
# Add tests for those lines
```

### ❌ Linting errors

**Cause:** Code style violations

**Solution:**
```bash
# Auto-fix most issues
npm run lint:fix

# Fix remaining issues manually
npm run lint
```

### ❌ Type errors

**Cause:** TypeScript compilation issues

**Solution:**
```bash
# Check type errors
npm run type-check

# Fix reported errors
# Common fixes:
# - Add proper type annotations
# - Fix incorrect type usage
# - Update interface definitions
```

---

## Monitoring CI Performance

### Check Workflow Run Time

Typical run times:
- **Tests:** 2-5 minutes
- **Linting:** 30 seconds
- **Type Check:** 30 seconds
- **Build:** 1 minute
- **Total:** ~4-7 minutes

If workflow takes longer:
- Check for slow tests
- Consider parallelizing tests
- Cache dependencies better

### Cost Monitoring (GitHub Actions Minutes)

- **Free tier:** 2,000 minutes/month
- **This workflow:** ~5 minutes per PR
- **Estimated PRs supported:** ~400/month

**Optimize if needed:**
- Skip tests for docs-only changes
- Use matrix builds sparingly
- Cache node_modules

---

## Next Steps

1. ✅ **Merge initial test files** (this PR)
2. ✅ **Configure branch protection** (follow steps above)
3. ✅ **Test the workflow** (create a test PR)
4. 🔄 **Add more tests** (increase coverage incrementally)
5. 🔄 **Raise coverage thresholds** (as coverage improves)

---

## Resources

- [GitHub Branch Protection Rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Vitest Coverage](https://vitest.dev/guide/coverage)
- [ESLint](https://eslint.org/docs/latest/)

---

**Questions?** Refer to [REFACTORING_ANALYSIS.md](./REFACTORING_ANALYSIS.md) for overall strategy.
