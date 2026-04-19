-- CreateTable
CREATE TABLE "ShopifyProductTemplate" (
    "id" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "descriptionHtml" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "productType" TEXT NOT NULL DEFAULT 'eSIM',
    "vendor" TEXT NOT NULL DEFAULT 'SAILeSIM',
    "tags" JSONB NOT NULL DEFAULT '[]',
    "imageUrl" TEXT,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "shopifyProductId" TEXT,
    "shopifyPushedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyProductTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyProductTemplateVariant" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "planType" TEXT NOT NULL,
    "validity" TEXT NOT NULL,
    "volume" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyProductTemplateVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyProductTemplate_countryCode_key" ON "ShopifyProductTemplate"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyProductTemplate_handle_key" ON "ShopifyProductTemplate"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyProductTemplate_shopifyProductId_key" ON "ShopifyProductTemplate"("shopifyProductId");

-- CreateIndex
CREATE INDEX "ShopifyProductTemplate_status_idx" ON "ShopifyProductTemplate"("status");

-- CreateIndex
CREATE INDEX "ShopifyProductTemplateVariant_templateId_idx" ON "ShopifyProductTemplateVariant"("templateId");

-- CreateIndex
CREATE INDEX "ShopifyProductTemplateVariant_sku_idx" ON "ShopifyProductTemplateVariant"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyProductTemplateVariant_templateId_sku_key" ON "ShopifyProductTemplateVariant"("templateId", "sku");

-- AddForeignKey
ALTER TABLE "ShopifyProductTemplateVariant" ADD CONSTRAINT "ShopifyProductTemplateVariant_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ShopifyProductTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
