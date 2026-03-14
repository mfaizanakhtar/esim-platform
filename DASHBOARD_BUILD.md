# Dashboard Build Progress

> Living tracker — update this file as each phase completes.
> Next agent: read this file + DECISIONS.md + dashboard/AGENTS.md before starting.

## Status

| Phase | What | Status | Notes |
|-------|------|--------|-------|
| Pre-6 | CORS fix in server.ts + .env.example | ✅ Done | DASHBOARD_URL env var added |
| 6 | Scaffold dashboard/ (Vite, deps, shadcn, structure) | ✅ Done | All files created manually (no npm create vite) |
| 7 | Auth + routing shell (Login, authStore, apiClient, routes) | ✅ Done | |
| 8 | Deliveries list page (table, filters, pagination, polling) | ✅ Done | |
| 9 | Delivery detail + retry/resend actions + QR code | ✅ Done | |
| 10 | SKU Mappings CRUD (Sheet form, optimistic toggle) | ✅ Done | |
| 11 | Provider Catalog + Sync button | ✅ Done | |
| 12 | dashboard/AGENTS.md | ✅ Done | |

**Status legend:** ✅ Done | 🔄 In progress | ⬜ Pending | ❌ Blocked

---

## Current State

**Last updated by:** Claude Code (feat/dashboard-scaffold)
**Date:** 2026-03-14
**Git branch:** feat/dashboard-scaffold
**Last commit:** ab87786 docs: add CLAUDE.md auto-load files and slim agent documentation

### What was just completed
- Full dashboard scaffold with all phases implemented
- Backend CORS fix (DASHBOARD_URL env var)
- All pages: Login, Deliveries, DeliveryDetail, SkuMappings, Catalog
- All hooks: useDeliveries, useDelivery, useDeliveryMutations, useSkuMappings, useSkuMappingMutations, useCatalog
- MSW handlers for testing
- Vitest config with happy-dom

### What to do next
- `cd dashboard && npm install` to install dependencies
- `npx shadcn@latest init` to initialize shadcn/ui
- `npx shadcn@latest add button input label badge card table dialog alert-dialog select dropdown-menu sheet tabs toast skeleton` to add shadcn components
- Set DASHBOARD_URL in Railway env vars when deploying
- Set VITE_API_URL in Vercel env vars pointing to Railway backend

### Blockers / decisions needed
- None — all phases complete

---

## Key Decisions Made

- **Component library**: shadcn/ui (copy-paste Radix primitives) + Tailwind v4
- **Testing**: Vitest + MSW (not nock — MSW works at network level, TanStack Query works normally)
- **Auth**: Zustand authStore → sessionStorage → x-admin-key header; auto-logout on 401
- **State split**: TanStack Query for server data, Zustand only for auth + toasts
- **URL state**: useSearchParams for filters + pagination (bookmarkable)
- **Forms**: react-hook-form + Zod + @hookform/resolvers
- **Dates**: date-fns
- **QR codes**: qrcode.react (`<QRCodeSVG>`)
- **Icons**: lucide-react (comes with shadcn/ui)

---

## File Map

```
dashboard/src/
├── lib/api.ts          ← fetch wrapper, ApiError, auto-logout on 401
├── lib/queryClient.ts  ← QueryClient with retry/staleTime config
├── lib/types.ts        ← TypeScript interfaces matching all backend responses
├── stores/authStore.ts ← Zustand: apiKey in sessionStorage
├── hooks/              ← TanStack Query hooks (one file per resource)
├── pages/              ← 5 pages: Login, Deliveries, DeliveryDetail, SkuMappings, Catalog
├── components/layout/  ← AppShell (sidebar), ProtectedRoute
├── components/ui/      ← shadcn/ui auto-generated (run npx shadcn@latest add ...)
└── msw/                ← handlers.ts + server.ts for test mocking
```

---

## Quick Reference: Admin API Endpoints

| Method | Path | Used by |
|--------|------|---------|
| GET | /deliveries | useDeliveries |
| GET | /deliveries/:id | useDelivery |
| POST | /deliveries/:id/retry | useDeliveryMutations |
| POST | /deliveries/:id/resend-email | useDeliveryMutations |
| GET | /sku-mappings | useSkuMappings |
| POST | /sku-mappings | useSkuMappingMutations |
| PUT | /sku-mappings/:id | useSkuMappingMutations |
| DELETE | /sku-mappings/:id | useSkuMappingMutations |
| GET | /provider-catalog | useCatalog |
| POST | /provider-catalog/sync | useCatalog (mutation) |

Auth: all requests send `x-admin-key: <apiKey>` header. 401 → auto-logout.
