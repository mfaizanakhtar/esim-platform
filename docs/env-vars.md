# Environment Variables

## fulfillment-engine

Source: `fulfillment-engine/.env.example`

### Core

| Variable | Required | Purpose | Example |
|----------|----------|---------|---------|
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgresql://postgres:pass@postgres-pgvector.railway.internal:5432/railway?connection_limit=5&pool_timeout=30` |
| `PORT` | No | HTTP server port (default: 3000) | `3000` |
| `ENCRYPTION_KEY` | Yes | AES-256 key for credential encryption (32 bytes hex) | `a1b2c3d4...` (64 hex chars) |
| `ADMIN_API_KEY` | Yes | Protects `/admin/*` routes | Strong random string |

### Shopify

| Variable | Required | Purpose | Example |
|----------|----------|---------|---------|
| `SHOPIFY_SHOP_DOMAIN` | Yes | Store's `.myshopify.com` domain — used for Admin API calls | `sailesim.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Yes | OAuth app client ID from Partner Dashboard | `1d9541e35a5924941f451d33bf1c4c8f` |
| `SHOPIFY_CLIENT_SECRET` | Yes | OAuth client secret — also used for webhook HMAC verification | `shpss_...` |
| `SHOPIFY_ACCESS_TOKEN` | Yes | Permanent access token for Admin API | `shpat_...` |
| `SHOPIFY_CUSTOM_DOMAIN` | No | Custom storefront domain — used for `usageUrl` in emails | `sailesim.com` |

> **Important:** `SHOPIFY_SHOP_DOMAIN` must be the `.myshopify.com` domain, not the custom domain. The custom domain redirects Admin API calls and Axios converts POST → GET on redirect (404).

### FiRoam

| Variable | Required | Purpose | Example |
|----------|----------|---------|---------|
| `FIROAM_BASE_URL` | Yes | FiRoam API base URL | `https://bpm.roamwifi.hk` |
| `FIROAM_PHONE` | Yes | Login phone number | `+1234567890` |
| `FIROAM_PASSWORD` | Yes | Login password | |
| `FIROAM_SIGN_KEY` | Yes | HMAC signing key (32 chars) | |
| `FIROAM_INTEGRATION` | No | Enable integration tests | `false` |
| `FIROAM_TEST_PHONE` | No | Test account phone | |
| `FIROAM_TEST_PASSWORD` | No | Test account password | |
| `FIROAM_E2E_ORDERS` | No | Place real orders in E2E tests | `false` |

### TGT Technology

| Variable | Required | Purpose | Example |
|----------|----------|---------|---------|
| `TGT_BASE_URL` | Yes (if enabled) | TGT API endpoint | `https://enterpriseapi.tugegroup.com:8070/openapi` |
| `TGT_ACCOUNT_ID` | Yes (if enabled) | Account ID from TGT | |
| `TGT_SECRET` | Yes (if enabled) | API secret from TGT | |
| `TGT_CALLBACK_SECRET` | No | Webhook signature key (defaults to `TGT_SECRET`) | |
| `TGT_ENABLED` | No | Enable TGT vendor (default: false) | `true` |
| `TGT_FULFILLMENT_MODE` | No | `hybrid` \| `polling` \| `callback` (default: `hybrid`) | `hybrid` |
| `TGT_POLL_INTERVAL_SECONDS` | No | Polling interval (default: 15) | `15` |
| `TGT_POLL_MAX_ATTEMPTS` | No | Max polling retries (default: 8) | `8` |
| `TGT_INTEGRATION` | No | Enable TGT integration tests | `false` |
| `TGT_E2E_ORDERS` | No | Place real TGT orders (sandbox) | `false` |

### Email

| Variable | Required | Purpose | Example |
|----------|----------|---------|---------|
| `RESEND_API_KEY` | Yes | Transactional email via Resend | `re_...` |
| `EMAIL_FROM` | Yes | Sender address | `orders@sailesim.com` |
| `EMAIL_BCC` | No | BCC all outgoing emails | `ops@sailesim.com` |

### AI / Embeddings

| Variable | Required | Purpose | Example |
|----------|----------|---------|---------|
| `OPENAI_API_KEY` | Yes (for AI mapping) | GPT-4o-mini + text-embedding-ada-002 | `sk-...` |

---

## dashboard

| Variable | Required | Purpose | Notes |
|----------|----------|---------|-------|
| `VITE_API_URL` | Yes | Admin API base URL | **Build-time var** — changing requires full redeploy. Must include `/admin` suffix: `https://api.sailesim.com/admin` |

---

## Railway-Specific Notes

- `DATABASE_URL` on Railway points to `postgres-pgvector.railway.internal` — the pg-vector Postgres instance (the primary database)
- `VITE_API_URL` is baked into the dashboard bundle at build time — update it in Railway then **trigger a full redeploy** (not just restart)
- `esim-api` and `esim-worker` must have identical Shopify and vendor env vars — they share the same database and must agree on which store they're serving
