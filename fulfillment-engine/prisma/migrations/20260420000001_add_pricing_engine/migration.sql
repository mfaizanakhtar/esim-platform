-- AlterTable: Add pricing fields to ShopifyProductTemplateVariant
ALTER TABLE "ShopifyProductTemplateVariant" ADD COLUMN "priceLocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopifyProductTemplateVariant" ADD COLUMN "providerCost" DECIMAL(10,2);
ALTER TABLE "ShopifyProductTemplateVariant" ADD COLUMN "costFloor" DECIMAL(10,2);
ALTER TABLE "ShopifyProductTemplateVariant" ADD COLUMN "competitorPrice" DECIMAL(10,2);
ALTER TABLE "ShopifyProductTemplateVariant" ADD COLUMN "competitorBrand" TEXT;
ALTER TABLE "ShopifyProductTemplateVariant" ADD COLUMN "proposedPrice" DECIMAL(10,2);
ALTER TABLE "ShopifyProductTemplateVariant" ADD COLUMN "priceSource" TEXT;
ALTER TABLE "ShopifyProductTemplateVariant" ADD COLUMN "marketPosition" TEXT;
ALTER TABLE "ShopifyProductTemplateVariant" ADD COLUMN "lastPricedAt" TIMESTAMP(3);

-- CreateTable: CompetitorPrice
CREATE TABLE "CompetitorPrice" (
    "id" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "countrySlug" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "planName" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "dataMb" INTEGER NOT NULL,
    "validityDays" INTEGER NOT NULL,
    "coverageType" TEXT,
    "promoCode" TEXT,
    "originalPrice" DECIMAL(10,2),
    "rawPayload" JSONB,
    "scrapedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompetitorPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable: PricingRun
CREATE TABLE "PricingRun" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "scope" TEXT,
    "params" JSONB,
    "totalProcessed" INTEGER NOT NULL DEFAULT 0,
    "totalUpdated" INTEGER NOT NULL DEFAULT 0,
    "totalSkipped" INTEGER NOT NULL DEFAULT 0,
    "totalErrors" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PricingRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompetitorPrice_countryCode_brand_dataMb_validityDays_key" ON "CompetitorPrice"("countryCode", "brand", "dataMb", "validityDays");
CREATE INDEX "CompetitorPrice_countryCode_dataMb_validityDays_idx" ON "CompetitorPrice"("countryCode", "dataMb", "validityDays");
CREATE INDEX "CompetitorPrice_scrapedAt_idx" ON "CompetitorPrice"("scrapedAt");
