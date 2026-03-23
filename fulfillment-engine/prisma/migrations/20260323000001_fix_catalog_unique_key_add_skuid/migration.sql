-- Migration: fix catalog unique key to include skuId
--
-- Root cause: ProviderSkuCatalog used (provider, productCode) as the unique key.
-- FiRoam's apiCode (productCode) is only unique *within* a SKU, not globally.
-- Multiple SKUs can have the same apiCode with different priceids, causing the
-- upsert to overwrite with whichever SKU was synced last — sending the wrong
-- priceid to FiRoam at provisioning time.
--
-- Fix: add skuId as a first-class column and change the unique key to
-- (provider, skuId, productCode). FiRoam entries use the numeric skuId as a
-- string; TGT and future providers default to "" so their constraint remains
-- equivalent to the old (provider, productCode).

-- Step 1: add columns (non-null skuId with default ""; nullable skuName)
ALTER TABLE "ProviderSkuCatalog" ADD COLUMN "skuId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ProviderSkuCatalog" ADD COLUMN "skuName" TEXT;

-- Step 2: backfill FiRoam rows — extract skuId and skuName from rawPayload
UPDATE "ProviderSkuCatalog"
SET
  "skuId"   = COALESCE("rawPayload"->>'skuId', ''),
  "skuName" = "rawPayload"->>'skuDisplay'
WHERE provider = 'firoam' AND "rawPayload" IS NOT NULL;

-- Step 3: drop the old unique index
DROP INDEX "ProviderSkuCatalog_provider_productCode_key";

-- Step 4: add the new unique index
CREATE UNIQUE INDEX "ProviderSkuCatalog_provider_skuId_productCode_key"
  ON "ProviderSkuCatalog"("provider", "skuId", "productCode");

-- Step 5: add supporting index on skuId for lookups
CREATE INDEX "ProviderSkuCatalog_skuId_idx" ON "ProviderSkuCatalog"("skuId");
