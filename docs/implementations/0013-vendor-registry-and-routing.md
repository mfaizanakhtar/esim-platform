# Vendor registry + routing (provider lookup, failover priority)

**ID:** 0013 · **Status:** shipped · **Owner:** backfill
**Shipped:** pre-log · **PRs:** pre-log

## What it does

`src/vendor/registry.ts` is a single-file `Map<string, VendorProvider>` populated at module load. Every vendor implements the `VendorProvider` interface from `src/vendor/types.ts` — `name` + `provision(config, context) → EsimProvisionResult`. The provisioning job looks up `ProviderSkuMapping` rows for a Shopify SKU, sorts them by `priority`, and tries each provider via `getProvider(mapping.provider)` until one succeeds or all fail. Adding a new vendor is three steps: implement the interface, add the row to the registry map, insert mapping rows in the DB.

## Why

We need to support multiple eSIM vendors (FiRoam primary, TGT secondary, Airalo planned) without forking provisioning logic per vendor or peppering the worker with `if (provider === 'firoam')` checks. The interface + registry pattern keeps vendor-specific code isolated to `src/vendor/providers/<name>.ts` and lets us A/B vendors per SKU using DB rows instead of code changes. Priority + failover lets us define "FiRoam first, fall back to TGT if it fails" as data, not branching.

## Key files

| Path | Role |
|------|------|
| `fulfillment-engine/src/vendor/types.ts` | `VendorProvider` interface, `EsimProvisionResult`, `ProviderMappingConfig`, `ProvisionContext` |
| `fulfillment-engine/src/vendor/registry.ts` | The `Map<string, VendorProvider>`; `getProvider(name)`, `getRegisteredProviders()` |
| `fulfillment-engine/src/vendor/providers/firoam.ts` | FiRoam adapter |
| `fulfillment-engine/src/vendor/providers/tgt.ts` | TGT adapter |
| `fulfillment-engine/src/worker/jobs/provisionEsim.ts` | The failover loop — sorts mappings by `priority`, tries each provider in order |

## Touchpoints

- DB: `ProviderSkuMapping` (`provider` field is the registry key, `priority` orders the failover)
- Worker job: `provision-esim` is the only consumer of `getProvider`
- Admin API: `/admin/sku-mappings/*` and `/admin/providers` enumerate registered providers via `getRegisteredProviders()`

## Data model

- No tables owned by the registry itself. It reads `ProviderSkuMapping.provider` (string) and `priority` (int).

## Gotchas / non-obvious decisions

- **Registry map key is the string stored in `ProviderSkuMapping.provider`.** Renaming a provider in the registry without updating DB rows orphans every mapping for that vendor. Treat the map keys as a stable contract.
- **Failover uses `priority: 'asc'`.** Lowest priority number runs first. Don't change the ordering — the dashboard UI sorts the same way and operators set priorities expecting it.
- **Only `VendorError` triggers failover.** `JobDataError` and `MappingError` re-throw immediately so we don't try the next provider with the same broken config. See `provisionEsim.ts:114-124`.
- **Last-provider failure re-throws the original error.** If FiRoam returns `VendorError("X")` and TGT returns `VendorError("Y")`, the customer-facing failure is "Y" (the last attempt). Don't aggregate — operators want to see the most recent failure.
- **Adapters return `pending: true` for async vendors.** That's the contract signal that `provisionEsim` must NOT call `finalizeDelivery` and instead store `vendorOrderId` and let the poll/callback path handle finalization. Forgetting this on a new vendor → silent dropped emails.
- **Adapters parse their own `providerSku` format.** FiRoam uses `skuId:apiCode:priceId`; TGT uses the bare productCode. The interface deliberately doesn't standardise — adding constraints would force every new vendor into a colon-delimited shape. Document the format in the adapter's file header.
- **Tests instantiate the registry as-is, not via DI.** If you find yourself needing to mock the registry, mock the providers' `provision` methods instead — keeps the wiring honest.

## Related docs

- `docs/sku-mapping.md` — `ProviderSkuMapping`, priority, failover semantics
- `docs/vendors.md` — per-vendor reference
- `docs/database.md` — `ProviderSkuMapping` schema

## Future work / known gaps

- Adding Airalo is currently the standing example. No deploy required for new mappings, but a new provider class still needs a code change + redeploy. Acceptable today; if vendors multiply, a plugin loader would cut the cycle.
- Failover currently re-tries with the same `quantity: 1` even when the first vendor failed mid-batch. Multi-quantity orders aren't a problem in practice (we always provision 1 per delivery row), but worth knowing if we ever batch.
