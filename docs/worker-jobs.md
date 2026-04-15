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
**Interval:** `TGT_POLL_INTERVAL_SECONDS` (default: 5s)
**Max attempts:** `TGT_POLL_MAX_ATTEMPTS` (default: 60)

### Flow

```
1. Call TGT tryResolveOrderCredentials(orderNo)
│
├── Credentials ready
│   ├── Decrypt and store
│   └── Enqueue 'finalize-delivery'
│
├── Not ready yet
│   ├── If attempts < max → reschedule poll
│   └── If max reached → set status='awaiting_callback'
│                         (wait for POST /api/tgt/callback)
│
└── Error → log and retry
```

---

## cancel-esim

**Trigger:** Enqueued by `orders/cancelled` webhook handler
**File:** `src/worker/jobs/cancelEsim.ts`

### Flow

```
1. Load delivery
2. If status is already terminal (delivered, failed, cancelled) → skip
3. If credentials were provisioned → call vendor cancel (if supported)
4. Set status='cancelled'
```

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
