-- ─────────────────────────────────────────────────────────────────────────────
-- Add Region support to ShopifyProductTemplate.
--
-- Country-keyed and region-keyed templates coexist: each row is a COUNTRY
-- template (countryCode populated, regionCode NULL) or a REGION template
-- (regionCode populated, countryCode NULL). Both columns stay nullable + unique;
-- Postgres treats NULLs as distinct in unique indexes, so multiple rows can
-- share NULL on either side without conflict, while populated values remain
-- globally unique. This avoids touching every existing call site that does
-- `findUnique({ where: { countryCode: ... } })`.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Region table
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "parentCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "countryCodes" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Region_code_key" ON "Region"("code");
CREATE INDEX "Region_parentCode_idx" ON "Region"("parentCode");
CREATE INDEX "Region_isActive_idx" ON "Region"("isActive");

-- 2. Add templateType column. Default to 'COUNTRY' so every existing row
--    becomes a COUNTRY template automatically.
ALTER TABLE "ShopifyProductTemplate"
    ADD COLUMN "templateType" TEXT NOT NULL DEFAULT 'COUNTRY';

-- 3. Add regionCode column (nullable; only set on REGION templates).
ALTER TABLE "ShopifyProductTemplate"
    ADD COLUMN "regionCode" TEXT;

-- 4. countryCode becomes nullable so REGION rows can hold NULL there.
--    The existing unique index "ShopifyProductTemplate_countryCode_key"
--    is preserved — Postgres allows multiple NULLs in a unique index.
ALTER TABLE "ShopifyProductTemplate"
    ALTER COLUMN "countryCode" DROP NOT NULL;

-- 5. Unique index on regionCode (nullable, same NULLs-distinct semantics).
CREATE UNIQUE INDEX "ShopifyProductTemplate_regionCode_key"
    ON "ShopifyProductTemplate"("regionCode");

-- 6. Index on templateType for filtering COUNTRY vs REGION.
CREATE INDEX "ShopifyProductTemplate_templateType_idx"
    ON "ShopifyProductTemplate"("templateType");

-- 7. Foreign key: ShopifyProductTemplate.regionCode → Region.code.
--    ON DELETE SET NULL: if a region is deleted, orphan its templates
--    rather than cascading the deletion.
ALTER TABLE "ShopifyProductTemplate"
    ADD CONSTRAINT "ShopifyProductTemplate_regionCode_fkey"
    FOREIGN KEY ("regionCode") REFERENCES "Region"("code")
    ON DELETE SET NULL ON UPDATE CASCADE;
