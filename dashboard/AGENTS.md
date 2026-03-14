# dashboard — Agent Instructions

> Auto-loaded by Claude Code when working in this directory.

## Stack

| Layer | Package | Notes |
|-------|---------|-------|
| Framework | React 19 + Vite 6 | SPA mode, no SSR |
| Routing | react-router-dom 7 | SPA mode, BrowserRouter |
| Server state | @tanstack/react-query 5 | All API data |
| Client state | zustand 5 | Auth key + ephemeral UI state only |
| UI components | Manual Tailwind v4 | CSS vars for theming |
| Forms | react-hook-form + zod + @hookform/resolvers | |
| Icons | lucide-react | |
| Dates | date-fns | format, formatDistanceToNow |
| QR codes | qrcode.react | QRCodeSVG component |
| Testing | vitest + @testing-library/react + msw | happy-dom environment |

## Auth Flow

1. User enters API key on `/login` page
2. App POSTs `GET /deliveries?limit=1` with the key to validate it
3. On 200 → key stored in `sessionStorage` via `useAuthStore`
4. On 401 → error shown to user
5. All API calls send `x-admin-key: <key>` header via `src/lib/api.ts`
6. Any 401 response from API → `authStore.logout()` + redirect to `/login`

## Store Inventory

| Store | File | State | Persistence |
|-------|------|-------|-------------|
| authStore | `src/stores/authStore.ts` | `apiKey: string | null` | sessionStorage |

## Hook Patterns

All data-fetching hooks live in `src/hooks/`. Each file maps to one backend resource:

```
useDeliveries(params)      → GET /deliveries
useDelivery(id)            → GET /deliveries/:id
useRetryDelivery(id)       → POST /deliveries/:id/retry (mutation)
useResendEmail(id)         → POST /deliveries/:id/resend-email (mutation)
useSkuMappings(params)     → GET /sku-mappings
useCreateSkuMapping()      → POST /sku-mappings (mutation)
useUpdateSkuMapping()      → PUT /sku-mappings/:id (mutation)
useToggleSkuMapping()      → PUT /sku-mappings/:id { isActive } (optimistic)
useDeleteSkuMapping()      → DELETE /sku-mappings/:id (mutation)
useCatalog(params)         → GET /provider-catalog
useSyncCatalog()           → POST /provider-catalog/sync (mutation)
```

### QueryClient config (`src/lib/queryClient.ts`)
- `staleTime: 30_000` — 30s before background refetch
- Retry skipped for 401 and 404 errors
- 401 → auto-logout

### Cache invalidation rules
- After any mutation on deliveries → invalidate `['deliveries']` + `['delivery', id]`
- After any SKU mapping mutation → invalidate `['sku-mappings']`
- After catalog sync → invalidate `['catalog']`

## Testing with MSW

MSW intercepts at the network level — TanStack Query, retries, and error handling all work normally.

```typescript
// In test files:
import { server } from '@/msw/server';
import { handlers } from '@/msw/handlers';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Override a handler for one test:
server.use(
  http.get('http://localhost:3000/admin/deliveries', () =>
    HttpResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  )
);
```

## URL State

Filters and pagination are stored in URL search params (bookmarkable):
- Deliveries: `?status=failed&page=2`
- Use `useSearchParams()` from react-router-dom

## Environment Variables

| Var | Where set | Description |
|-----|-----------|-------------|
| `VITE_API_URL` | `.env.local` / Vercel env | Full URL to backend admin prefix, e.g. `http://localhost:3000/admin` |

## Common Pitfalls

- **`sessionStorage` clears on tab close** — intentional. Users re-authenticate per session.
- **Don't use `localStorage`** for the API key — sessionStorage is safer (no persistence across tabs/sessions).
- **Always invalidate queries after mutations** — otherwise stale data stays in cache.
- **Polling**: `useDeliveries` auto-polls every 10s when any delivery has status `pending`, `provisioning`, or `polling`.
- **VITE_API_URL must NOT have a trailing slash** — paths in apiClient start with `/`.
- **shadcn/ui components**: if you add more components, run `npx shadcn@latest add <component>` — this copies source into `src/components/ui/`.

## Adding a New Page

1. Create `src/pages/NewPage.tsx`
2. Add a route in `src/App.tsx`
3. Add a nav item in `src/components/layout/AppShell.tsx`
4. Add a hook in `src/hooks/` if new backend endpoint needed
5. Add MSW handler in `src/msw/handlers.ts`

## Running Locally

```bash
cd dashboard
npm install
# Create .env.local with:
# VITE_API_URL=http://localhost:3000/admin
npm run dev          # Vite dev server on :5173
npm run test         # Vitest watch mode
npm run test:run     # Vitest single run
npm run build        # Production build
```

Backend must be running with `ADMIN_API_KEY` set (or unset for dev mode).
