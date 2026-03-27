-- AddMultiProviderPriorityLocks
-- Allows one Shopify SKU to map to multiple providers with priority-based failover.

-- Step 1: Add new columns
ALTER TABLE "ProviderSkuMapping"
  ADD COLUMN "priority"       INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "priorityLocked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "mappingLocked"  BOOLEAN NOT NULL DEFAULT false;

-- Step 2: Drop the old unique constraint on shopifySku alone
DROP INDEX IF EXISTS "ProviderSkuMapping_shopifySku_key";

-- Step 3: Add composite unique constraint (shopifySku, provider)
CREATE UNIQUE INDEX "ProviderSkuMapping_shopifySku_provider_key"
  ON "ProviderSkuMapping"("shopifySku", "provider");

-- Step 4: Add index for priority-ordered lookup during provisioning
CREATE INDEX "ProviderSkuMapping_shopifySku_priority_idx"
  ON "ProviderSkuMapping"("shopifySku", "priority");
