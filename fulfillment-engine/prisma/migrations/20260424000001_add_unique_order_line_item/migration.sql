-- Delete any duplicate (orderId, lineItemId) rows before adding the constraint.
-- Keeps the earliest row (smallest id) for each pair.
DELETE FROM "EsimDelivery" a
  USING "EsimDelivery" b
  WHERE a."orderId" = b."orderId"
    AND a."lineItemId" = b."lineItemId"
    AND a."id" > b."id";

-- CreateIndex
CREATE UNIQUE INDEX "EsimDelivery_orderId_lineItemId_key" ON "EsimDelivery"("orderId", "lineItemId");
