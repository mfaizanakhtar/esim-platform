-- AlterTable
ALTER TABLE "EsimDelivery" ADD COLUMN "provider" TEXT;
ALTER TABLE "EsimDelivery" ADD COLUMN "iccidHash" TEXT;

-- CreateIndex
CREATE INDEX "EsimDelivery_iccidHash_idx" ON "EsimDelivery"("iccidHash");
