-- CreateTable
CREATE TABLE "ProviderSkuCatalog" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "productType" TEXT,
    "region" TEXT,
    "countryCodes" JSONB,
    "dataAmount" TEXT,
    "validity" TEXT,
    "netPrice" DECIMAL(28,2),
    "currency" TEXT,
    "cardType" TEXT,
    "activeType" TEXT,
    "rawPayload" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderSkuCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderSkuCatalog_provider_productCode_key" ON "ProviderSkuCatalog"("provider", "productCode");

-- CreateIndex
CREATE INDEX "ProviderSkuCatalog_provider_idx" ON "ProviderSkuCatalog"("provider");

-- CreateIndex
CREATE INDEX "ProviderSkuCatalog_isActive_idx" ON "ProviderSkuCatalog"("isActive");
