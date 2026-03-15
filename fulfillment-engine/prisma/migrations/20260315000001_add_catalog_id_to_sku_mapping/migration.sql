-- AlterTable: add providerCatalogId FK to ProviderSkuMapping
ALTER TABLE "ProviderSkuMapping" ADD COLUMN "providerCatalogId" TEXT;

-- AddForeignKey
ALTER TABLE "ProviderSkuMapping"
  ADD CONSTRAINT "ProviderSkuMapping_providerCatalogId_fkey"
  FOREIGN KEY ("providerCatalogId") REFERENCES "ProviderSkuCatalog"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "ProviderSkuMapping_providerCatalogId_idx" ON "ProviderSkuMapping"("providerCatalogId");
