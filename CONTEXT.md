# esim-platform — Agent Context

> Load this file at the start of a new agent session to get up to speed quickly.
> Last updated: 2026-03-23

---

## What This Is

eSIM fulfillment platform for **Fluxyfi** (fluxyfi.com). When Shopify orders are paid, eSIM credentials are provisioned from FiRoam or TGT Technology vendors and emailed to customers as QR codes.

**Monorepo (pnpm workspaces):**

| Module | Path | Stack |
|--------|------|-------|
| `fulfillment-engine` | `fulfillment-engine/` | TypeScript, Fastify, Prisma (PostgreSQL), pg-boss |
| `dashboard` | `dashboard/` | React 19 admin UI |
| `shopify` | `shopify/` | Shopify theme (Rise) — Liquid, CSS, JS |

---

## Infrastructure

| Service | Details |
|---------|---------|
| **Backend** | Railway — `https://esim-api-production-a56a.up.railway.app` |
| **Database** | Railway PostgreSQL |
| **Shopify store** | `fluxyfi-com.myshopify.com` (custom domain: fluxyfi.com) |
| **Shopify app** | `esim_fulfillment` — Dev Dashboard app, client credentials grant |
| **Theme** | Rise (live), ID `193336934730` |
| **Email** | Resend — sender `orders@fluxyfi.com` |

---

## Vendors

| Vendor | Provider key | Notes |
|--------|-------------|-------|
| FiRoam | `firoam` | Primary eSIM provider |
| TGT Technology | `tgt` | Secondary provider, async fulfillment |

TGT fulfillment modes: `hybrid` (default) → poll first, callback fallback.

---

## Key Architecture

### Order Flow
1. Shopify `orders/paid` webhook → `fulfillment-engine/src/api/webhook.ts`
2. Idempotency check (`orderId + lineItemId`) → create `EsimDelivery`
3. Enqueue `provision-esim` job (pg-boss)
4. Worker (`provisionEsim.ts`) → resolve SKU mapping → call vendor
5. FiRoam: synchronous → finalize immediately
6. TGT: async → `vendor_ordered` / `polling` / `awaiting_callback` status
   - Polling: `tgtPoll.ts` job retries
   - Callback: `tgtCallback.ts` route receives TGT webhook
7. `finalizeDelivery.ts` — idempotent, first-wins write — sends email + Shopify fulfillment

### Non-Negotiable Rules
1. **Never provision eSIM inside the webhook handler** — always enqueue
2. **Webhook handler must be idempotent** — check `orderId + lineItemId`
3. **All vendor API calls in worker jobs**, not HTTP handlers
4. **Sensitive data (LPA, activation code, ICCID) encrypted at rest** (AES-256)

---

## Database — Key Models

### `EsimDelivery`
```prisma
id                String   @id
orderId           String
orderName         String   // e.g. #1001
lineItemId        String
customerEmail     String?
status            String   // pending | provisioning | vendor_ordered | polling | awaiting_callback | delivered | failed
vendorReferenceId String?  // TGT order number
provider          String?  // 'firoam' | 'tgt' — set at provision time
iccidHash         String?  // HMAC-SHA256(iccid, ENCRYPTION_KEY) — indexed for O(1) lookup
payloadEncrypted  String?  // AES-256 encrypted JSON: { vendorId, lpa, activationCode, iccid }
@@index([iccidHash])
```

### `ProviderSkuMapping`
Maps Shopify SKUs → vendor product codes. Admin UI in `dashboard/`.

---

## API Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/webhook/orders/paid` | HMAC | Shopify webhook |
| GET | `/api/esim/usage?q=` | None | Search usage by ICCID / order# / email |
| GET | `/api/esim/:iccid/usage` | None | Usage by ICCID (legacy) |
| POST | `/api/tgt/callback` | Secret | TGT delivery webhook |
| GET/POST | `/admin/*` | `x-admin-key` header | Admin API |

### Usage Search (`GET /api/esim/usage?q=`)
- `q` contains `@` → email search → returns `{ results: [...] }`
- `q` matches `/^#?\d{1,8}$/` → order number search → single result
- Otherwise → ICCID search → single result (O(1) via `iccidHash`, legacy full-scan fallback)

---

## Shopify Theme

Theme files live in `shopify/` and are auto-deployed to the live theme on every merge to `main` that touches `shopify/**` (via `.github/workflows/shopify-deploy.yml`).

### eSIM Usage Page
- **Template**: `shopify/templates/page.esim-usage.liquid`
- **JS**: `shopify/assets/esim-usage.js`
- **CSS**: `shopify/assets/esim-usage.css`
- **Live URL**: `https://fluxyfi.com/pages/<handle>` — check Shopify Admin → Pages for the page using the `esim-usage` template
- Auto-submits from `?iccid=` URL param (email link flow)
- Search form accepts ICCID, order number, or email
- Handles both FiRoam (circular progress + validity) and TGT (simple stats) response shapes
- Email search renders multi-card grid with "View Details" drill-down

### Local Theme Workflow
```bash
# Credentials in shopify/.env.shopify (gitignored)
npm run theme:pull   # pull from live Shopify theme
npm run theme:push   # push to live theme
npm run theme:dev    # local dev server
```

### Shopify App Scopes
`read_orders, read_products, read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders, read_themes, write_themes`

To update scopes: edit `fulfillment-engine/shopify.app.toml` → `shopify app deploy --force` → reinstall app.

---

## Environment Variables

### fulfillment-engine (`fulfillment-engine/.env`)
```
DATABASE_URL
ENCRYPTION_KEY                 # 32-byte key — used for AES-256 + ICCID hashing
SHOPIFY_SHOP_DOMAIN            # fluxyfi.com (custom domain)
SHOPIFY_CLIENT_ID
SHOPIFY_CLIENT_SECRET
SHOPIFY_WEBHOOK_SECRET
FIROAM_BASE_URL / FIROAM_PHONE / FIROAM_PASSWORD / FIROAM_SIGN_KEY
TGT_BASE_URL / TGT_ACCOUNT_ID / TGT_SECRET
TGT_FULFILLMENT_MODE           # hybrid | polling | callback
RESEND_API_KEY / EMAIL_FROM
ADMIN_API_KEY
```

### Shopify theme (`shopify/.env.shopify`)
```
SHOPIFY_FLAG_STORE=fluxyfi-com.myshopify.com
SHOPIFY_FLAG_THEME_ID=193336934730
SHOPIFY_CLI_THEME_TOKEN=       # get via: cd fulfillment-engine && npx ts-node scripts/get-theme-token.ts
```

### GitHub Secrets (CI)
`SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_FLAG_THEME_ID`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`

---

## Common Commands

```bash
# Backend
cd fulfillment-engine
npm run dev              # start API + worker
npm run verify           # type-check + build + lint + tests (run before committing)
npm run prisma:migrate   # apply DB migrations
npm run prisma:generate  # regenerate Prisma client after schema changes

# Theme
npm run theme:pull       # pull live theme
npm run theme:push       # push to live theme
npm run theme:dev        # local dev server

# Create PR (full flow: branch → CI → CodeRabbit → merge)
npm run pr:create "feat: description"
```

---

## CI / GitHub Actions

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `.github/workflows/ci.yml` | PR + push to main | Tests, build, lint, coverage |
| `.github/workflows/shopify-deploy.yml` | Push to main (`shopify/**`) | Auto-deploy theme to Shopify |

Branch protection on `main`: requires PR + CI pass. Required approvals = 0 (solo developer).

---

## Key Files

| File | Purpose |
|------|---------|
| `fulfillment-engine/src/api/webhook.ts` | Shopify orders/paid handler |
| `fulfillment-engine/src/worker/jobs/provisionEsim.ts` | Main provisioning job |
| `fulfillment-engine/src/worker/jobs/finalizeDelivery.ts` | Idempotent delivery finalization |
| `fulfillment-engine/src/worker/jobs/tgtPoll.ts` | TGT polling job |
| `fulfillment-engine/src/api/tgtCallback.ts` | TGT callback webhook |
| `fulfillment-engine/src/api/usage.ts` | Usage tracking API |
| `fulfillment-engine/src/vendor/registry.ts` | Provider discovery by name |
| `fulfillment-engine/src/vendor/types.ts` | VendorProvider interface |
| `fulfillment-engine/prisma/schema.prisma` | DB schema |
| `fulfillment-engine/shopify.app.toml` | Shopify app config (scopes, webhooks) |
| `shopify/templates/page.esim-usage.liquid` | Usage tracking Shopify page |
| `shopify/assets/esim-usage.js` | Usage page frontend logic |
| `fulfillment-engine/AGENTS.md` | Detailed backend agent instructions |
| `DECISIONS.md` | Architecture decisions and gotchas |
