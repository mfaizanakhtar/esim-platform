-- Create the ProviderSkuMapping table
CREATE TABLE IF NOT EXISTS "ProviderSkuMapping" (
    "id" TEXT NOT NULL,
    "shopifySku" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSku" TEXT NOT NULL,
    "name" TEXT,
    "region" TEXT,
    "dataAmount" TEXT,
    "validity" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderSkuMapping_pkey" PRIMARY KEY ("id")
);

-- Create unique index on shopifySku
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderSkuMapping_shopifySku_key" ON "ProviderSkuMapping"("shopifySku");

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS "ProviderSkuMapping_provider_idx" ON "ProviderSkuMapping"("provider");
CREATE INDEX IF NOT EXISTS "ProviderSkuMapping_isActive_idx" ON "ProviderSkuMapping"("isActive");

-- Insert sample SKU mappings
-- Replace these with your actual Shopify SKUs and FiRoam package codes
INSERT INTO "ProviderSkuMapping" (id, "shopifySku", provider, "providerSku", name, region, "dataAmount", validity, "isActive", "createdAt", "updatedAt")
VALUES 
    (gen_random_uuid()::text, 'ESIM-EU-5GB', 'firoam', 'EU-5GB-30D', 'Europe 5GB eSIM', 'Europe', '5GB', '30 days', true, NOW(), NOW())
ON CONFLICT ("shopifySku") DO UPDATE SET
    provider = EXCLUDED.provider,
    "providerSku" = EXCLUDED."providerSku",
    name = EXCLUDED.name,
    region = EXCLUDED.region,
    "dataAmount" = EXCLUDED."dataAmount",
    validity = EXCLUDED.validity,
    "isActive" = EXCLUDED."isActive",
    "updatedAt" = NOW();

-- Add more mappings as needed
-- Example:
-- INSERT INTO "ProviderSkuMapping" (...) VALUES (...);

-- View all mappings
SELECT "shopifySku", provider, "providerSku", name, "isActive" 
FROM "ProviderSkuMapping" 
ORDER BY "createdAt" DESC;
