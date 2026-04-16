# Worker Jobs

**Queue:** pg-boss (PostgreSQL-backed job queue)
**Entry point:** `fulfillment-engine/src/worker/index.ts`
**Source:** `fulfillment-engine/src/worker/jobs/`

The worker runs as a separate Railway service (`esim-worker`) using the same codebase and database as `esim-api`.

---

## provision-esim

**Trigger:** Enqueued by `orders/paid` webhook handler
**File:** `src/worker/jobs/provisionEsim.ts`
**Retry policy:** 3 retries × 60s delay, 1-hour expiry

### Flow

```
1. Load EsimDelivery from DB
2. Resolve SKU → find ProviderSkuMapping (priority order)
3. Select vendor (firoam | tgt)
4. Call vendor.provision(delivery, mapping)
│
├── FiRoam (synchronous)
│   ├── Credentials returned immediately
│   ├── Update delivery: vendorReferenceId, provider, status='provisioning'
│   └── Enqueue 'finalize-delivery'
│
└── TGT (asynchronous)
    ├── Order created, orderNo returned
    ├── Create EsimOrder record
    ├── Set delivery status='vendor_ordered'
    └── Enqueue 'tgt-poll-order' (if hybrid or polling mode)
        or await callback webhook (if callback mode)
```

### Error Handling
- If vendor call fails → job retries up to 3 times
- After all retries exhausted → `status='failed'`, `lastError` set
- Can retry manually from dashboard: `POST /admin/deliveries/:id/retry`

---

## finalize-delivery

**Trigger:** End of FiRoam provisioning, or after TGT credentials arrive (poll or callback)
**File:** `src/worker/jobs/finalizeDelivery.ts`
**Retry policy:** 3 retries × 60s delay

### Flow

```
1. Load delivery + encrypted payload
2. Decrypt credentials
3. Send email to customer (Resend)
   └── Template: LPA QR code + activation code + ICCID
4. Create Shopify fulfillment
5. Update Shopify metafield: status='delivered', lpa, activationCode, iccid, usageUrl
6. Set delivery status='delivered'
7. Record DeliveryAttempt for audit trail
```

### Idempotency
- Checks if already delivered before doing anything
- First writer wins if two workers race

---

## tgt-poll-order

**Trigger:** Enqueued after TGT order creation (hybrid or polling mode)
**File:** `src/worker/jobs/tgtPoll.ts`
**Interval:** `TGT_POLL_INTERVAL_SECONDS` (default: 15s)
**Max attempts:** `TGT_POLL_MAX_ATTEMPTS` (default: 8)

### Flow

```
1. Call TGT tryResolveOrderCredentials(orderNo)
│
├── Credentials ready
│   └── Call finalizeDelivery() → status='delivered'
│
├── Not ready yet
│   ├── If attempts < max → reschedule poll (after TGT_POLL_INTERVAL_SECONDS)
│   └── If max reached (hybrid mode) → set status='awaiting_callback'
│       ├── Wait for POST https://api.sailesim.com/webhook/tgt/callback
│       └── (polling mode: set status='failed')
│
└── Error → log, retry on next tick
```

---

## cancel-esim

**Trigger:** Enqueued by `POST /admin/deliveries/:id/cancel` (dashboard) or `orders/cancelled` Shopify webhook
**File:** `src/worker/jobs/cancelEsim.ts`
**Retry policy:** 2 retries, 1-hour expiry

### Flow

```
1. Load delivery — if already terminal (cancelled/failed) → skip (idempotent)
2. If status ≠ 'delivered' → mark cancelled in DB immediately (no vendor action needed)
3. If status = 'delivered':
   │
   ├── FiRoam
   │   ├── queryEsimOrder(iccid) — check activation (usedMb > 0 or beginDate set)
   │   ├── If activated → block cancel, tag 'esim-cancel-failed' + 'esim-activated'
   │   └── If not activated → cancelOrder(orderNum, iccid) → mark cancelled
   │
   └── TGT (no cancel API)
       ├── queryOrders(iccid) — check profileStatus / activatedStartTime
       ├── If activated → block cancel, tag 'esim-cancel-failed' + 'esim-activated'
       └── If not activated → mark cancelled in DB
           └── tag 'esim-tgt-manual-cancel-needed' — must cancel in TGT portal

4. Always write note + tag to Shopify order
5. If refund=true → call shopify.cancelShopifyOrder() to issue full refund
```

### Shopify Outcome Tags

| Tag | Meaning |
|-----|---------|
| `esim-cancelled` | eSIM cancelled successfully |
| `esim-cancel-failed` | Cancel failed — manual action required |
| `esim-activated` | eSIM was already in use by customer |
| `esim-tgt-manual-cancel-needed` | Must cancel in TGT portal manually |

---

## Job Queue Operations

### Enqueuing Jobs (in code)

```typescript
const queue = getJobQueue();

// Provision a delivery
await queue.send('provision-esim', { deliveryId }, {
  retryLimit: 3,
  retryDelay: 60,
  expireInMinutes: 60,
});

// Finalize with delay
await queue.send('finalize-delivery', { deliveryId });
```

### Monitoring

Jobs are stored in PostgreSQL (pg-boss tables). To inspect:

```bash
# Check worker logs
./.claude/skills/railway/logs.sh esim-worker --lines 50

# Check API logs for job errors
./.claude/skills/railway/logs.sh esim-api --lines 50
```

### Retry a Stuck Delivery

```bash
POST /admin/deliveries/:id/retry
```

This re-enqueues a `provision-esim` job. Safe to call multiple times — idempotency check prevents duplicate deliveries.
