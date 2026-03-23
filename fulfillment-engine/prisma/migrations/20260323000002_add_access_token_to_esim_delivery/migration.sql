-- Add accessToken to EsimDelivery for Shopify Customer Account UI Extension
-- The token is a UUID issued once after eSIM delivery and stored in the Shopify
-- order metafield so the extension can fetch eSIM credentials from the public API.

ALTER TABLE "EsimDelivery" ADD COLUMN "accessToken" TEXT;

CREATE UNIQUE INDEX "EsimDelivery_accessToken_key" ON "EsimDelivery"("accessToken");
