# Architecture

## Overview

eSIM fulfillment platform that automatically provisions eSIM credentials after Shopify orders are paid. Supports two vendors: **FiRoam** (synchronous) and **TGT Technology** (asynchronous).

## Services

| Service | Path | Railway Name | URL |
|---------|------|-------------|-----|
| API + Webhooks | `fulfillment-engine/` | `esim-api` | `https://api.sailesim.com` |
| Background Worker | `fulfillment-engine/` | `esim-worker` | (internal) |
| Admin Dashboard | `dashboard/` | `Dashboard` | `https://dashboard.sailesim.com` |
| Database | — | pg-vector Postgres | `postgres-pgvector.railway.internal` |

The API and worker share the same codebase (`fulfillment-engine/`) but different entry points:
- API: `src/server.ts`
- Worker: `src/worker/index.ts`

## Data Flow

```
1. SHOPIFY ORDER PAID
   └── POST /webhook/orders/paid
       ├── Verify HMAC signature (SHOPIFY_CLIENT_SECRET)
       ├── Idempotency check (orderId + lineItemId)
       ├── Create EsimDelivery { status: 'pending' }
       ├── Write provisioning metafield to Shopify (fire-and-forget)
       ├── Enqueue 'provision-esim' job
       └── Return 200 immediately

2. WORKER: provision-esim job
   ├── Resolve SKU → ProviderSkuMapping (by priority)
   ├── Select vendor (firoam | tgt)
   │
   ├── FiRoam (synchronous)
   │   ├── Call FiRoam addEsimOrder()
   │   ├── Receive { lpa, activationCode, iccid } immediately
   │   └── Enqueue 'finalize-delivery'
   │
   └── TGT (asynchronous)
       ├── Call TGT createOrder()
       ├── Receive orderNo only
       ├── Set status: 'vendor_ordered'
       └── Enqueue 'tgt-poll-order' OR await callback webhook

3. WORKER: finalize-delivery job
   ├── Encrypt credentials (AES-256-GCM)
   ├── Store iccidHash (HMAC-SHA256) for O(1) lookup
   ├── Send email to customer (Resend)
   ├── Create Shopify fulfillment
   ├── Write 'delivered' metafield
   └── Set status: 'delivered'

4. CUSTOMER EXPERIENCE
   ├── Order status page (UI extension) — polls /esim/delivery/:token
   ├── Email link → /pages/esim-usage?iccid=... — usage tracking
   └── Cancel eSIM via customer account UI extension
```

## TGT Async Paths

TGT orders can resolve credentials in two ways (configured via `TGT_FULFILLMENT_MODE`):

```
hybrid (default)
  ├── Poll every TGT_POLL_INTERVAL_SECONDS (default 15s)
  ├── Up to TGT_POLL_MAX_ATTEMPTS (default 8)
  ├── If found → finalize immediately
  └── If timeout → set 'awaiting_callback', wait for webhook

polling
  └── Poll only, never wait for callback

callback
  └── Skip polling, wait for POST /api/tgt/callback only
```

## Shopify Integration Points

| Integration | How |
|-------------|-----|
| Order events | Webhooks: `orders/paid`, `orders/cancelled` |
| Delivery status display | `esim.delivery_tokens` metafield on order |
| Customer-facing status | UI extension on order status + thank-you pages |
| Fulfillment | Shopify Fulfillment API after credentials delivered |
| Usage tracking | Public page (`/pages/esim-usage`) via Rise theme |

## Key Design Decisions

- **Two-process split** (API + worker): webhook handler returns 200 immediately; all heavy work is async
- **No shop-level filtering** on admin endpoints: single-tenant, one admin key rules everything
- **Priority-ordered mappings**: multiple vendor SKUs per Shopify SKU, tried in priority order
- **pgvector for AI mapping**: cosine similarity pre-filters catalog to top 20 candidates before GPT call
- **iccidHash index**: ICCID lookup for usage page is O(1) without decrypting all records
