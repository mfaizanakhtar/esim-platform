-- CreateTable
CREATE TABLE "ShopifyVariant" (
    "variantId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productTitle" TEXT,
    "variantTitle" TEXT,
    "price" DECIMAL(28,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyVariant_pkey" PRIMARY KEY ("variantId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyVariant_variantId_key" ON "ShopifyVariant"("variantId");

-- CreateIndex
CREATE INDEX "ShopifyVariant_sku_idx" ON "ShopifyVariant"("sku");
