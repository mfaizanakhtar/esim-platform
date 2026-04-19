# Plan: Bulk Create Shopify Country Products

## Context
The store has only 11 country products. The provider catalogs (FiRoam + TGT) cover 150+ individual countries. The user wants to create Shopify products for all available countries so they can be mapped in the dashboard.

## Data Summary
- **FiRoam**: 176 entries (mix of single countries + regional bundles like "Europe", "Asia 30", "Global")
- **TGT**: 100+ ISO country codes (extracted from `countryCodeList`)
- **Current Shopify**: 11 products, 410 total variants, max 81 variants per product
- **Current variant pattern**: Plan Type (Day-Pass / Total Data) × Validity (1D–30D) × Volume (500MB–30GB)

## Approach

### 1. Add `productCreate` + `productSetMedia` to ShopifyClient
- `fulfillment-engine/src/shopify/client.ts`
- Use Shopify's `productCreate` GraphQL mutation (API version 2026-04)
- Create product with 3 options: Plan Type, Validity, Volume
- Create all variant combinations with $5.00 price, SKU auto-generated as `{CC}-{DATA}-{VALIDITY}D-{TYPE}`
- Set flag image via `productCreateMedia` using `flagcdn.com` URL (e.g. `https://flagcdn.com/w640/gb.png`)
- Status: ACTIVE

### 2. Add admin endpoint `POST /admin/shopify-products/bulk-create`
- `fulfillment-engine/src/api/admin.ts`
- Accepts: `{ countries?: string[] }` — if omitted, uses all single-country codes from catalog
- Builds a unique country list by:
  1. Querying `ProviderSkuCatalog` for all distinct `countryCodes` values
  2. Filtering to single-country entries (FiRoam country names → ISO code mapping, TGT already ISO)
  3. Deduplicating across providers
  4. Excluding countries that already have a Shopify product (by checking existing variants' SKU prefix)
- For each country:
  - Creates a Shopify product titled "{Country Name}" with handle "{country-slug}"
  - Adds flag image from `https://flagcdn.com/w640/{cc_lower}.png`
  - Creates standardized variant set (must stay under Shopify's 100-variant limit):
    - **Day-Pass**: validities [1, 2, 3, 5, 7, 10, 15, 30] × volumes [1GB, 2GB, 3GB, 5GB, 10GB] = 40
    - **Total Data**: validities [1, 3, 7, 15, 30] × volumes [1GB, 2GB, 3GB, 5GB, 10GB, 20GB] = 30
    - **Total: 70 variants** (under 100 limit)
  - Sets SKU per variant: `{CC}-{DATA}-{VALIDITY}D-DAYPASS` or `{CC}-{DATA}-{VALIDITY}D-FIXED`
- Returns: `{ created: number, skipped: number, errors: string[] }`
- Rate limiting: Shopify allows ~2 mutations/sec; add small delay between products

### 3. Country name ↔ ISO code mapping
- `fulfillment-engine/src/utils/countryCodes.ts` (new file)
- Hardcoded ISO 3166-1 alpha-2 lookup: `{ code: string, name: string, slug: string }`
- Also maps FiRoam display names to ISO codes (e.g., "United Kingdom" → "GB", "Korea" → "KR", "UAE" → "AE")
- Skip regional bundles like "Europe", "Asia 30", "Global" — these aren't individual country products

### 4. Dashboard: Add "Create Products" button to Catalog page
- `dashboard/src/pages/Catalog.tsx`
- Button next to Sync that triggers `POST /admin/shopify-products/bulk-create`
- Shows progress/result

## Variant Set (70 per product, under 100 limit)

| Plan Type | Validities | Volumes | Count |
|-----------|-----------|---------|-------|
| Day-Pass | 1D, 2D, 3D, 5D, 7D, 10D, 15D, 30D (8) | 1GB, 2GB, 3GB, 5GB, 10GB (5) | 40 |
| Total Data | 1D, 3D, 7D, 15D, 30D (5) | 1GB, 2GB, 3GB, 5GB, 10GB, 20GB (6) | 30 |
| **Total** | | | **70** |

Trimmed from the current pattern (160) to stay under Shopify's 100-variant limit while covering main use cases.

## Files to Modify
- `fulfillment-engine/src/shopify/client.ts` — add `createProduct`, `createProductMedia`
- `fulfillment-engine/src/api/admin.ts` — add `POST /admin/shopify-products/bulk-create`
- `fulfillment-engine/src/utils/countryCodes.ts` — new file, ISO country map + FiRoam name→code
- `dashboard/src/pages/Catalog.tsx` — "Create Products" button
- `dashboard/src/hooks/useCatalog.ts` — mutation hook for bulk-create

## Verification
1. `npm run type-check && npm test -- --run` in fulfillment-engine
2. Run endpoint for a small test: `{ countries: ["AF", "AL"] }` — verify 2 products created in Shopify
3. Full run: omit `countries` → creates all ~150 individual country products
4. Check Shopify admin: products visible with flags, variants with correct SKUs
5. Dashboard: sync Shopify SKUs, then run structured auto-map
