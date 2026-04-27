# Encryption + idempotency primitives (crypto, errors, idempotency key)

**ID:** 0010 · **Status:** shipped · **Owner:** backfill
**Shipped:** pre-log · **PRs:** pre-log

## What it does

Three small modules anchor the system's correctness guarantees. `src/utils/crypto.ts` provides AES-256-GCM `encrypt`/`decrypt` for storing eSIM credentials at rest and a deterministic `hashIccid` HMAC for indexed lookups without exposing the raw ICCID. `src/utils/errors.ts` defines a three-class error hierarchy (`JobDataError`, `MappingError`, `VendorError`) and an `isRetryable` predicate so worker jobs can give pg-boss the right retry signal. `src/utils/idempotency.ts` produces the canonical `orderId::lineItemId` key used to dedupe deliveries.

## Why

Three forces converge here:

1. We store LPA / activation code / ICCID in our DB, so if the DB is ever copied off-host the contents must remain unreadable. AES-256-GCM with the env-supplied key satisfies that.
2. We need to look up deliveries by ICCID without putting the raw ICCID in any index. HMAC-SHA256 keyed by the same encryption secret gives us a deterministic, non-reversible-without-key index column.
3. The worker must distinguish "retry helps" (vendor flake) from "retry won't help" (bad data, missing config). Without a typed error hierarchy every job would either retry forever or never retry, both of which we've burned on before.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/src/utils/crypto.ts` | `encrypt`, `decrypt`, `hashIccid`. Reads `ENCRYPTION_KEY` from env. |
| `fulfillment-engine/src/utils/errors.ts` | `AppError` base, `JobDataError`, `MappingError`, `VendorError`, `isRetryable` |
| `fulfillment-engine/src/utils/idempotency.ts` | `makeIdempotencyKey(orderId, lineItemId)` |
| `fulfillment-engine/src/shopify/webhooks.ts` | `verifyShopifyWebhook` HMAC check (separate file, same crypto pattern) |

## Touchpoints

- Every read/write of `EsimDelivery.payloadEncrypted` and `topupIccid` (encrypt at write, decrypt at read).
- `iccidHash` column on `EsimDelivery` populated by `hashIccid` for indexed lookups in usage endpoints.
- All worker jobs (`provision-esim`, `finalize-delivery`, `cancel-esim`, `tgt-poll-order`) throw the typed errors so pg-boss sees the right retry semantics.
- Webhook handler (`src/api/webhook.ts`) calls `prisma.esimDelivery.findFirst({ orderId, lineItemId })` — the conceptual idempotency key, even though the helper string isn't strictly necessary at the call site.

## Data model

- No models owned by these utilities themselves. They write to:
  - `EsimDelivery.payloadEncrypted` (base64 of `iv|tag|ciphertext`)
  - `EsimDelivery.iccidHash` (hex HMAC-SHA256)
  - `EsimDelivery.topupIccid` (base64 same format as `payloadEncrypted`)

## Gotchas / non-obvious decisions

- **`ENCRYPTION_KEY` accepts three formats.** 64-hex chars (32 bytes), valid base64 of 32 bytes, or any other string (passed through SHA-256 to derive 32 bytes). The passphrase fallback makes local dev painless but production should use a 64-hex or base64 32-byte value — see `docs/env-vars.md`.
- **GCM auth tag is 16 bytes, IV is 12 bytes, prepended to ciphertext.** The on-disk format is `base64(iv || tag || ciphertext)`. Don't change this layout — every encrypted column in the DB depends on it.
- **`hashIccid` reuses `ENCRYPTION_KEY` as the HMAC secret.** Rotating the encryption key would invalidate every existing `iccidHash` lookup column. There's no key-rotation tooling yet; treat the key as effectively immutable post-launch.
- **Errors carry a `code` string for log filtering, not for client response shape.** Client-facing errors are still serialised as plain HTTP responses elsewhere; the `code` is only for grepping logs.
- **Only `VendorError` is retryable.** `JobDataError`/`MappingError` re-throw and pg-boss marks the job failed without retry. If you add a new error type, decide its retry semantics and update `isRetryable`.
- **The idempotency helper is a string concat.** It exists so future changes (e.g. adding a shop prefix when we go multi-shop) have one place to update. Today the webhook handler queries the composite directly via Prisma `findFirst({ orderId, lineItemId })` — both shapes coexist.
- **HMAC verification for Shopify webhooks lives in `shopify/webhooks.ts`, not `crypto.ts`.** Different secret (`SHOPIFY_CLIENT_SECRET`), different algorithm input (raw body bytes), keep them separate.

## Related docs

- `docs/security.md` — encryption + ICCID hashing reference
- `docs/env-vars.md` — `ENCRYPTION_KEY` format
- `docs/database.md` — `payloadEncrypted`, `iccidHash`, `topupIccid` columns
- `docs/worker-jobs.md` — retry semantics, links to `isRetryable`

## Future work / known gaps

- Key rotation tooling (re-encrypt + re-hash) is not implemented. If we ever need to rotate `ENCRYPTION_KEY`, that's a small migration to write.
- We don't envelope-encrypt with a KMS today — the DB-at-rest guarantee depends on the env var staying out of leaks. Acceptable given current scale; revisit if we add SOC2-style requirements.
