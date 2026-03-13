# Monorepo Migration Plan

> **Document Type**: Developer / Agent Reference
> **Status**: 🔄 In Progress
> **Created**: 2026-03-09
> **Purpose**: Step-by-step plan to migrate `esim_backend` into a monorepo named `esim-platform` with two modules: `fulfillment-engine` (current backend) and `dashboard` (new React admin UI). Agents executing any phase should read this file first, then the relevant module AGENTS.md.

---

## Target Structure

```
esim-platform/                        ← GitHub repo root
├── AGENTS.md                         ← Root: monorepo map, cross-cutting concerns
├── package.json                      ← pnpm workspaces config
├── pnpm-workspace.yaml               ← declares ["fulfillment-engine", "dashboard"]
├── .github/
│   └── workflows/
│       └── ci.yml                    ← PR pipeline: test both modules
├── fulfillment-engine/               ← Current backend (moved here)
│   ├── AGENTS.md                     ← Current AGENTS.md, updated paths
│   ├── src/
│   ├── prisma/
│   ├── docs/                         ← Current docs/ moved here
│   ├── scripts/
│   ├── package.json
│   ├── tsconfig.json
│   ├── tsconfig.build.json
│   ├── tsconfig.test.json
│   ├── tsconfig.scripts.json
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── railway.json
│   └── .env.example
└── dashboard/                        ← New React admin UI
    ├── AGENTS.md
    ├── src/
    │   ├── lib/
    │   │   ├── api.ts                ← Typed fetch wrapper (reads apiKey from store)
    │   │   └── queryClient.ts        ← TanStack Query setup
    │   ├── stores/
    │   │   ├── authStore.ts          ← apiKey, login(), logout()
    │   │   ├── toastStore.ts         ← global toast queue
    │   │   └── catalogSyncStore.ts   ← sync in-progress + last result
    │   ├── pages/
    │   │   ├── Login.tsx
    │   │   ├── Deliveries.tsx
    │   │   ├── DeliveryDetail.tsx
    │   │   ├── SkuMappings.tsx
    │   │   └── Catalog.tsx
    │   ├── components/
    │   │   ├── StatusBadge.tsx
    │   │   ├── ConfirmDialog.tsx
    │   │   ├── SyncButton.tsx
    │   │   └── Toaster.tsx
    │   ├── hooks/
    │   │   ├── useDeliveries.ts
    │   │   ├── useDelivery.ts
    │   │   ├── useSkuMappings.ts
    │   │   └── useCatalog.ts
    │   └── main.tsx
    ├── package.json
    ├── vite.config.ts
    ├── vitest.config.ts
    ├── tailwind.config.ts
    ├── tsconfig.json
    └── .env.example
```

---

## Phase Overview

| Phase | What | Status |
|-------|------|--------|
| 1 | GitHub repo rename | ✅ Done (user renames on GitHub + `git remote set-url`) |
| 2 | Monorepo root setup | ✅ Done |
| 3 | Move backend into `fulfillment-engine/` | ✅ Done |
| 4 | Update CI + Railway config | ✅ Done (ci.yml created, Railway root dir update pending) |
| 5 | Write root AGENTS.md | ✅ Done |
| 6 | Scaffold `dashboard/` | ⬜ Not started |
| 7 | Dashboard: Auth + routing shell | ⬜ Not started |
| 8 | Dashboard: Deliveries page | ⬜ Not started |
| 9 | Dashboard: Delivery detail + actions | ⬜ Not started |
| 10 | Dashboard: SKU Mappings CRUD | ⬜ Not started |
| 11 | Dashboard: Provider Catalog + sync | ⬜ Not started |
| 12 | Dashboard: AGENTS.md | ⬜ Not started |

---

## Phase 1 — GitHub Repo Rename

**Goal:** Rename `esim_backend` → `esim-platform` on GitHub. Preserves all history, PRs, and issues.

### Steps

1. Go to GitHub → repo → **Settings → General → Repository name**
2. Type `esim-platform` → click **Rename**
3. Update local remote:
   ```bash
   git remote set-url origin https://github.com/<your-username>/esim-platform.git
   git remote -v  # verify
   ```
4. GitHub auto-redirects old URLs — Railway/webhooks keep working immediately.

### Verification
- `git remote -v` shows new URL
- `git push` succeeds

---

## Phase 2 — Monorepo Root Setup

**Goal:** Add pnpm workspace config at repo root so `fulfillment-engine` and `dashboard` are managed as workspaces.

### Steps

1. Install pnpm if not present: `npm install -g pnpm`
2. Create root `package.json`:
   ```json
   {
     "name": "esim-platform",
     "private": true,
     "packageManager": "pnpm@9.x",
     "scripts": {
       "test:all": "pnpm -r test -- --run",
       "build:all": "pnpm -r build",
       "verify:all": "pnpm -r verify"
     }
   }
   ```
3. Create `pnpm-workspace.yaml`:
   ```yaml
   packages:
     - 'fulfillment-engine'
     - 'dashboard'
   ```
4. Create root `.gitignore` additions (node_modules at root if any).

### Verification
- `pnpm install` at root resolves both workspaces without errors

---

## Phase 3 — Move Backend into `fulfillment-engine/`

**Goal:** Move all current backend files into a `fulfillment-engine/` subdirectory while keeping Git history intact (use `git mv`).

### Files to move (everything currently at repo root except new root files)

```
src/                → fulfillment-engine/src/
prisma/             → fulfillment-engine/prisma/
docs/               → fulfillment-engine/docs/
scripts/            → fulfillment-engine/scripts/
firoam-data/        → fulfillment-engine/firoam-data/
csv-exports/        → fulfillment-engine/csv-exports/
thirdparty-documentation/ → fulfillment-engine/thirdparty-documentation/
test-output/        → fulfillment-engine/test-output/
package.json        → fulfillment-engine/package.json
tsconfig*.json      → fulfillment-engine/tsconfig*.json
Dockerfile          → fulfillment-engine/Dockerfile
docker-compose.yml  → fulfillment-engine/docker-compose.yml
railway.json        → fulfillment-engine/railway.json
shopify.app.toml    → fulfillment-engine/shopify.app.toml
.env.example        → fulfillment-engine/.env.example
AGENTS.md           → fulfillment-engine/AGENTS.md
README.md           → fulfillment-engine/README.md (or keep at root and update)
FiRoam_documentation.txt → fulfillment-engine/FiRoam_documentation.txt
FiRoam.pdf          → fulfillment-engine/FiRoam.pdf
```

### Steps

```bash
mkdir fulfillment-engine
git mv src fulfillment-engine/src
git mv prisma fulfillment-engine/prisma
git mv docs fulfillment-engine/docs
git mv scripts fulfillment-engine/scripts
git mv firoam-data fulfillment-engine/firoam-data
git mv csv-exports fulfillment-engine/csv-exports
git mv thirdparty-documentation fulfillment-engine/thirdparty-documentation
git mv test-output fulfillment-engine/test-output
git mv package.json fulfillment-engine/package.json
git mv tsconfig.json fulfillment-engine/tsconfig.json
git mv tsconfig.build.json fulfillment-engine/tsconfig.build.json
git mv tsconfig.scripts.json fulfillment-engine/tsconfig.scripts.json
git mv Dockerfile fulfillment-engine/Dockerfile
git mv docker-compose.yml fulfillment-engine/docker-compose.yml
git mv railway.json fulfillment-engine/railway.json
git mv shopify.app.toml fulfillment-engine/shopify.app.toml
git mv .env.example fulfillment-engine/.env.example
git mv AGENTS.md fulfillment-engine/AGENTS.md
git mv README.md fulfillment-engine/README.md
```

> **Note on tsconfig.test.json:** check if it exists separately or is inline — move accordingly.

### Post-move path fixes inside `fulfillment-engine/`

After moving, these internal references need checking (paths should still be relative, so most will be fine):

| File | What to check |
|------|--------------|
| `fulfillment-engine/package.json` | `prisma` schema path still `./prisma/schema.prisma` ✅ |
| `fulfillment-engine/tsconfig.json` | `paths` aliases (`~/`) still work relative to new location ✅ |
| `fulfillment-engine/railway.json` | `buildCommand` and `startCommand` — verify still correct |
| `fulfillment-engine/Dockerfile` | `COPY` paths — should still be relative ✅ |
| `fulfillment-engine/AGENTS.md` | Update all doc links from `docs/` → `docs/` (same relative) ✅ |

### Verification
```bash
cd fulfillment-engine
npm run type-check:fresh
npm test -- --run
npm run build
```
All should pass exactly as before.

---

## Phase 4 — Update CI + Railway Config

### Railway

1. In Railway dashboard → service settings → **Root Directory**: set to `fulfillment-engine`
2. Build and start commands remain unchanged (they're relative)
3. Environment variables unchanged

### GitHub Actions CI

Create `.github/workflows/ci.yml` at repo root:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test-fulfillment-engine:
    name: Test fulfillment-engine
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: fulfillment-engine
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: fulfillment-engine/package-lock.json
      - run: npm ci
      - run: npm run verify

  test-dashboard:
    name: Test dashboard
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: dashboard
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: dashboard/package-lock.json
      - run: npm ci
      - name: Install Chromium for Vitest browser mode
        run: npx playwright install chromium --with-deps
      - run: npm run verify
```

### Verification
- Push a branch → both CI jobs appear on PR
- Both pass green

---

## Phase 5 — Root AGENTS.md

**Goal:** Create a lightweight root `AGENTS.md` that orients any agent to the monorepo.

### Contents to include

- Monorepo overview (what each module does, how they relate)
- Where to start for common tasks: "modify an API endpoint → read `fulfillment-engine/AGENTS.md`", "build a UI page → read `dashboard/AGENTS.md`"
- Shared environment variable contract (what `dashboard` needs to know about `fulfillment-engine`'s API)
- Deployment topology (Railway for `fulfillment-engine`, Railway/Vercel for `dashboard`)
- Cross-module conventions (TypeScript, pnpm, PR workflow)
- Link to each module's AGENTS.md

> **Agent note:** Keep root AGENTS.md short (< 100 lines). Deep detail lives in each module's AGENTS.md.

---

## Phase 6 — Scaffold `dashboard/`

**Goal:** Bare Vite + React project with all dependencies installed and Vitest configured.

### Tech stack

| Package | Version | Purpose |
|---------|---------|---------|
| `vite` | latest | Build tool |
| `react` + `react-dom` | 19 | UI framework |
| `react-router-dom` | v7 | Routing |
| `@tanstack/react-query` | v5 | Server state |
| `zustand` | v5 | Global UI state |
| `tailwindcss` | v4 | Styling |
| `shadcn/ui` | latest | Component library |
| `react-hook-form` | latest | Forms |
| `zod` | latest | Schema validation |
| `vitest` | latest | Test runner |
| `@vitest/browser` | latest | Browser mode for components |
| `playwright` | latest | Browser provider for Vitest browser mode |
| `@testing-library/react` | latest | Component test utilities |

### Steps

```bash
mkdir dashboard
cd dashboard
npm create vite@latest . -- --template react-ts
npm install @tanstack/react-query zustand react-router-dom react-hook-form zod
npm install -D vitest @vitest/browser @testing-library/react playwright tailwindcss @tailwindcss/vite
npx shadcn@latest init
```

### `vitest.config.ts` (workspace mode)

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    workspace: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'happy-dom',
          include: ['src/**/__tests__/**/*.test.ts?(x)'],
          exclude: ['src/components/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          browser: {
            enabled: true,
            provider: 'playwright',
            name: 'chromium',
            headless: true,
          },
          include: ['src/components/**/*.test.tsx'],
        },
      },
    ],
  },
});
```

### `.env.example`

```
VITE_API_URL=http://localhost:3000/admin
```

### Verification
- `npm run dev` starts Vite dev server
- `npm test -- --run` runs (0 tests, no failures)

---

## Phase 7 — Dashboard: Auth + Routing Shell

**Goal:** Working login page, protected routes, navigation skeleton.

### Subtasks

#### 7a. `authStore.ts`
```ts
// Persists apiKey to localStorage via zustand/middleware persist
interface AuthState {
  apiKey: string | null;
  login: (key: string) => void;
  logout: () => void;
}
```

#### 7b. `api.ts`
```ts
// Reads apiKey from authStore (not a hook — plain function)
// Base URL from import.meta.env.VITE_API_URL
// On 401 response → calls authStore.getState().logout()
async function apiFetch(path, options) { ... }
```

#### 7c. Login page (`Login.tsx`)
- Single password input + submit button
- On submit: calls `GET /admin/deliveries?limit=1` to validate key
- On 200: stores key, redirects to `/deliveries`
- On 401: shows "Invalid API key" error

#### 7d. Router setup (`main.tsx`)
```tsx
<BrowserRouter>
  <Routes>
    <Route path="/login" element={<Login />} />
    <Route element={<ProtectedLayout />}>   {/* redirects to /login if no key */}
      <Route path="/deliveries" element={<Deliveries />} />
      <Route path="/deliveries/:id" element={<DeliveryDetail />} />
      <Route path="/sku-mappings" element={<SkuMappings />} />
      <Route path="/catalog" element={<Catalog />} />
      <Route path="/" element={<Navigate to="/deliveries" />} />
    </Route>
  </Routes>
</BrowserRouter>
```

#### 7e. `ProtectedLayout.tsx`
- Sidebar nav (Deliveries / SKU Mappings / Catalog)
- `<Toaster />` component for global toasts
- `<Outlet />` for page content

### Tests
- `authStore.test.ts` (happy-dom): login sets key, logout clears it, persists to localStorage
- `api.test.ts` (happy-dom): attaches `x-admin-key` header, calls logout on 401

---

## Phase 8 — Dashboard: Deliveries Page

**Goal:** Paginated, filterable table of all deliveries.

### API used
- `GET /admin/deliveries?status=&limit=&offset=`

### Subtasks

#### 8a. `useDeliveries.ts` hook
```ts
// TanStack Query — re-fetches when filters change
function useDeliveries(params: { status?: string; limit: number; offset: number })
```

#### 8b. `Deliveries.tsx` page
- shadcn `Table` component
- Filter bar: status dropdown (all / pending / delivered / failed)
- Columns: Order Name, Customer Email, Status (`StatusBadge`), Created At, Last Error (truncated)
- Pagination: prev/next, "showing X–Y of Z"
- Row click → navigate to `/deliveries/:id`

#### 8c. `StatusBadge.tsx`
- `pending` → yellow badge
- `delivered` → green badge
- `failed` → red badge
- `processing` → blue badge

### Tests (browser mode)
- Renders table rows from mocked query data
- Status filter changes URL params
- StatusBadge renders correct colour per status

---

## Phase 9 — Dashboard: Delivery Detail + Actions

**Goal:** Single delivery view with retry and resend-email actions.

### API used
- `GET /admin/deliveries/:id`
- `POST /admin/deliveries/:id/retry`
- `POST /admin/deliveries/:id/resend-email`

### Subtasks

#### 9a. `useDelivery.ts` hook
```ts
function useDelivery(id: string)  // TanStack Query, single delivery
```

#### 9b. `DeliveryDetail.tsx` page
- Delivery metadata section (order name, email, status, timestamps)
- eSIM payload section: LPA string, ICCID, activation code, rendered QR code
  - Use `qrcode.react` package for QR rendering
- Attempts timeline (last 10 attempts, newest first)
- Action buttons:
  - **Retry** — shown only if `status === 'failed'`, opens `ConfirmDialog`
  - **Resend Email** — shown only if `status === 'delivered'`, opens `ConfirmDialog`

#### 9c. `ConfirmDialog.tsx`
- shadcn `AlertDialog` wrapper
- Props: `title`, `description`, `onConfirm`, `loading`

#### 9d. Mutations
- Both retry and resend use TanStack `useMutation`
- On success: invalidate `useDelivery` query + add success toast via `toastStore`
- On error: add error toast

### Tests (browser mode)
- Retry button disabled when status is not `failed`
- Resend button disabled when status is not `delivered`
- ConfirmDialog shows and calls onConfirm on confirm click

---

## Phase 10 — Dashboard: SKU Mappings CRUD

**Goal:** Full create/read/update/delete for provider SKU mappings.

### API used
- `GET /admin/sku-mappings`
- `POST /admin/sku-mappings`
- `PUT /admin/sku-mappings/:id`
- `DELETE /admin/sku-mappings/:id`

### Subtasks

#### 10a. `useSkuMappings.ts` hook
```ts
function useSkuMappings(params: { provider?: string; isActive?: boolean })
function useCreateMapping()   // useMutation
function useUpdateMapping()   // useMutation
function useDeleteMapping()   // useMutation
```

#### 10b. `SkuMappings.tsx` page
- Filter bar: provider (all / firoam / tgt), active only toggle
- shadcn `Table` with columns: Shopify SKU, Provider, Provider SKU, Name, Region, Active, Actions
- **Create** button → opens slide-out `Sheet` with form
- **Edit** (pencil icon per row) → opens same sheet pre-filled
- **Delete** (trash icon per row) → opens `ConfirmDialog`
- **Toggle active** (switch per row) → inline `PUT` call

#### 10c. Mapping form (inside Sheet)
- Fields: shopifySku, provider (select), providerSku, name, region, dataAmount, validity, isActive
- React Hook Form + Zod validation
- Submit calls create or update mutation

### Tests (browser mode)
- Form validates required fields before submit
- Table row shows edit/delete actions
- Delete confirmation dialog appears on delete click

---

## Phase 11 — Dashboard: Provider Catalog + Sync

**Goal:** Browse synced catalog entries and trigger sync per provider.

### API used
- `GET /admin/provider-catalog?provider=&limit=&offset=`
- `POST /admin/provider-catalog/sync`

### Subtasks

#### 11a. `useCatalog.ts` hook
```ts
function useCatalog(params: { provider?: string; limit: number; offset: number })
```

#### 11b. `catalogSyncStore.ts` (Zustand)
```ts
interface CatalogSyncState {
  isSyncing: boolean;
  lastResult: SyncResult | null;
  startSync: () => void;
  finishSync: (result: SyncResult) => void;
}
```

#### 11c. `SyncButton.tsx`
- Props: `provider: 'firoam' | 'tgt'`
- Reads `isSyncing` from store, shows spinner when active
- On click: calls `POST /admin/provider-catalog/sync`, updates store
- On complete: shows result toast (`processedPackages` synced)

#### 11d. `Catalog.tsx` page
- Provider tab switcher (FiRoam / TGT)
- `SyncButton` per provider with last sync result summary
- shadcn `Table` with columns: Product Code, Name, Region, Data, Validity, Price, Last Synced
- Search input (client-side filter on productCode/productName)
- Pagination

### Tests (browser mode)
- SyncButton shows spinner during sync
- After sync, result summary updates
- Table filters correctly on search input

---

## Phase 12 — `dashboard/AGENTS.md`

**Goal:** Write the dashboard-specific agent reference file.

### Contents
- Stack summary (Vite, React 19, React Router v7, TanStack Query v5, Zustand v5, shadcn/ui, Tailwind v4)
- Zustand store inventory (authStore, toastStore, catalogSyncStore) — what each owns
- API contract: how `api.ts` works, where `VITE_API_URL` comes from
- Page inventory (what each page covers, which API endpoints it uses)
- Testing setup (unit in happy-dom, components in Vitest browser mode)
- Coding standards (TypeScript strict, Zod for external data, no `any`)
- Common pitfalls (don't call `useAuthStore` inside `api.ts` — use `getState()`)
- Verification checklist (tsc --noEmit, npm test -- --run, npm run build)

---

## Shared Conventions Across Both Modules

- **TypeScript strict mode** — both modules
- **Zod** — `fulfillment-engine` for vendor API responses, `dashboard` for form validation and API response types
- **pnpm** — package manager for both
- **ESLint** — each module has its own config
- **PR workflow** — use `.claude/skills/create-pr/` skill from `fulfillment-engine` (update paths after migration)

---

## Environment Variable Contract

| Variable | Module | Purpose |
|----------|--------|---------|
| `VITE_API_URL` | dashboard | Points to `fulfillment-engine` admin base URL (e.g. `https://esim-platform.up.railway.app/admin`) |
| `ADMIN_API_KEY` | fulfillment-engine | Set in Railway — same value user enters in dashboard login |

---

## Post-Migration Checklist

- [x] Phase 1: GitHub renamed, local remote updated
- [x] Phase 2: pnpm workspace root created
- [x] Phase 3: Backend moved to `fulfillment-engine/`, all tests pass (363/363)
- [x] Phase 4: CI yml created (`ci.yml`); Railway root dir update → set to `fulfillment-engine/` in dashboard
- [x] Phase 5: Root AGENTS.md written
- [ ] Phase 6: `dashboard/` scaffolded, `npm test` passes (0 tests)
- [ ] Phase 7: Auth + routing shell working
- [ ] Phase 8: Deliveries page working
- [ ] Phase 9: Delivery detail + retry/resend working
- [ ] Phase 10: SKU Mappings CRUD working
- [ ] Phase 11: Catalog + sync working
- [ ] Phase 12: `dashboard/AGENTS.md` written

---

> **Agent tip:** Execute one phase at a time. After each phase, run the verification steps listed in that phase before moving on. Never skip Phase 3 verification — if `fulfillment-engine` tests fail after the move, fix before proceeding.
>
> **Last Updated**: 2026-03-09
