-- CreateIndex
CREATE UNIQUE INDEX "EsimDelivery_orderId_lineItemId_key" ON "EsimDelivery"("orderId", "lineItemId");
