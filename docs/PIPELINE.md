# SKU Pipeline Documentation

> **Document Type**: Architecture & Design  
> **Status**: ✅ Current  
> **Last Updated**: 2026-03-01  
> **Purpose**: Data flow and transformation pipeline

---

## Overview

The SKU pipeline processes Shopify product exports and creates mappings to FiRoam eSIM packages. This enables automatic eSIM provisioning after successful Shopify payments.

## Pipeline Phases

### Prerequisites

1. **Shopify Export**: `products_export_1.csv` in project root
2. **FiRoam Catalog**: Run `npm run fetch:skus` to download FiRoam data

### Full Pipeline

Run all phases at once:
```bash
npm run pipeline
```

### Individual Phases

#### Phase 1: Generate SKUs
```bash
npm run generate:skus
```
- **Input**: `products_export_1.csv`
- **Output**: `shopify-skus-generated.csv`
- **Purpose**: Converts Shopify product variants into standardized SKU format
- **Format**: `{COUNTRY_CODE}-{DATA_AMOUNT}-{DAYS}D-{FIXED|DAYPASS}`
- **Example**: `GB-500MB-1D-DAYPASS`, `JP-3GB-7D-FIXED`

#### Phase 2: Match with FiRoam
```bash
npm run match:firoam
```
- **Input**: `shopify-skus-generated.csv`, `firoam-data/*.csv`
- **Output**: `shopify-firoam-mappings.csv`
- **Purpose**: Matches Shopify SKUs with FiRoam packages
- **Matching Logic**:
  - Country code mapping (ISO to FiRoam custom codes)
  - Data amount matching (exact match)
  - Duration matching (exact match)
  - Package type matching (daypass vs fixed)
- **Match Confidence**: 50-100 (higher = better match)

#### Phase 3: Generate Seed Script
```bash
npm run generate:seed
```
- **Input**: `shopify-firoam-mappings.csv`
- **Output**: `prisma/seed-all-mappings.ts`
- **Purpose**: Creates TypeScript seed file for database deployment
- **Includes**: Only MATCHED status SKUs
- **Batch Size**: 100 records per batch

#### Phase 4: Deploy to Database
```bash
npm run seed:all-mappings
```
- **Input**: `prisma/seed-all-mappings.ts`
- **Output**: Database records in `ProviderSkuMapping` table
- **Purpose**: Upserts all SKU mappings to production database
- **Operation**: Idempotent (safe to run multiple times)

#### Phase 5: Update Shopify Export
```bash
npm run update:export
```
- **Input**: `products_export_1.csv`, `shopify-skus-generated.csv`
- **Output**: `products_export_updated.csv`
- **Purpose**: Updates Variant SKU column (column 18) with generated SKUs
- **Note**: Contains ALL products (including unfulfillable)

#### Phase 6: Clean Export
```bash
npm run clean:export
```
- **Input**: `products_export_updated.csv`, `shopify-firoam-mappings.csv`
- **Output**: `products_export_cleaned.csv`
- **Purpose**: Removes products without FiRoam mappings
- **Removes**:
  - NO_PACKAGE: FiRoam doesn't offer this package
  - NO_COUNTRY: Country not in FiRoam catalog
  - Empty SKUs
- **Result**: 100% fulfillable products

#### Phase 7: Verify Mappings
```bash
npm run verify:mappings
```
- **Input**: `products_export_updated.csv`, database
- **Output**: Console report + `shopify-missing-mappings.csv`, `database-orphaned-mappings.csv`
- **Purpose**: Validates database coverage
- **Reports**:
  - Coverage percentage
  - Missing mappings
  - Orphaned database records

### Additional Commands

#### Analyze Missing SKUs
```bash
npm run analyze:missing
```
- **Purpose**: Categorizes why SKUs didn't match
- **Categories**:
  - Truncated country codes
  - Global/Template products
  - Daypass not supported
  - Data amount not offered
  - Days count not offered
  - Country not in FiRoam
  - Actually available (matching issue)

#### Find Package Price ID
```bash
npm run find:priceid
```
- **Purpose**: Helper to find FiRoam priceId for specific packages

#### Fetch FiRoam SKUs
```bash
npm run fetch:skus
```
- **Purpose**: Download latest FiRoam catalog
- **Output**: `firoam-data/firoam-skus.csv`, `firoam-data/firoam-packages-*.csv`

#### Database Seed (Manual Mappings)
```bash
npm run db:seed
```
- **Purpose**: Seed manual SKU mappings (for testing)

## File Descriptions

### Input Files

- **products_export_1.csv**: Shopify product export (13,454 variants)
- **firoam-data/firoam-skus.csv**: FiRoam countries (168 countries)
- **firoam-data/firoam-packages-{code}.csv**: FiRoam packages per country

### Output Files

- **shopify-skus-generated.csv**: Generated SKUs (13,391 SKUs)
- **shopify-firoam-mappings.csv**: Matching results with confidence scores
- **products_export_updated.csv**: Shopify export with SKUs (all products)
- **products_export_cleaned.csv**: Shopify export with SKUs (fulfillable only)
- **shopify-missing-mappings.csv**: SKUs without FiRoam mappings
- **database-orphaned-mappings.csv**: Database SKUs not in Shopify
- **should-have-matched.csv**: SKUs that exist in FiRoam but didn't match

## SKU Format

### Shopify SKU Structure
```
{COUNTRY_CODE}-{DATA_AMOUNT}-{DAYS}D-{PACKAGE_TYPE}
```

**Examples:**
- `GB-500MB-1D-DAYPASS` - UK, 500MB, 1 day, daypass
- `JP-3GB-7D-FIXED` - Japan, 3GB, 7 days, fixed
- `GLOBAL-1GB-30D-FIXED` - Global, 1GB, 30 days, fixed

### FiRoam providerSku Structure
```
{skuId}:{priceId}
```

**Example:**
- `120:17464` - UK (skuId: 120), 500MB 1-day daypass (priceId: 17464)

## Country Code Mapping

### Important Notes

1. **FiRoam uses CUSTOM country codes**, not ISO 3166-1 numeric
   - Example: Serbia is 891 in FiRoam, not 688 (ISO)
   - Always verify against `firoam-skus.csv`

2. **Global Packages**
   - FiRoam code: 99911 (Global), 99116 (Global 100)
   - Covers 86+ countries
   - Includes daypass and fixed packages

3. **Truncated Country Codes**
   - Fixed in Phase 1 with proper ISO code mapping
   - Examples: UKRAIN → UA, SWEDEN → SE, SLOVEN → SI

## Common Issues

### Issue: Low Match Rate

**Symptoms**: Phase 2 reports low percentage of matched SKUs

**Causes**:
1. Missing country codes in `COUNTRY_CODES` map
2. FiRoam doesn't offer specific data amounts or durations
3. Daypass not supported for that country

**Solution**:
1. Run `npm run analyze:missing` to categorize issues
2. Add missing countries to `scripts/generate-shopify-skus.ts`
3. Add country code mappings to `scripts/match-firoam-packages.ts`
4. Re-run pipeline

### Issue: Database Shows Orphaned Mappings

**Symptoms**: Phase 7 shows mappings in database but not in Shopify

**Causes**:
1. Old products removed from Shopify
2. Country codes changed (e.g., UKRAIN → UA)
3. Test data

**Solution**: Safe to ignore or manually clean up database

### Issue: Products Not Fulfillable

**Symptoms**: Customer orders but eSIM not provisioned

**Causes**:
1. SKU not in database (run Phase 7 to verify)
2. Package type mismatch (daypass vs fixed)
3. FiRoam API down or changed

**Solution**:
1. Verify SKU exists in database
2. Check `src/worker/jobs/provisionEsim.ts` logs
3. Test with `npm run find:priceid`

## Best Practices

1. **Always run full pipeline** after adding/updating Shopify products
2. **Review `products_export_cleaned.csv`** before uploading to Shopify
3. **Keep FiRoam catalog updated**: Run `npm run fetch:skus` monthly
4. **Monitor match rate**: Should be 50%+ after fixes
5. **Test provisioning** after major changes

## Workflow Example

### Scenario: Adding New Products to Shopify

1. Add products in Shopify Admin
2. Export products: Admin → Products → Export
3. Download as `products_export_1.csv`
4. Place in project root
5. Run full pipeline: `npm run pipeline`
6. Review `products_export_cleaned.csv`
7. Upload to Shopify: Admin → Products → Import → Select "Overwrite"
8. Test an order

### Scenario: FiRoam Adds New Countries

1. Run `npm run fetch:skus` to update catalog
2. Re-run pipeline: `npm run pipeline`
3. New countries automatically mapped
4. Upload updated export to Shopify

### Scenario: Fixing Match Rate

1. Run `npm run analyze:missing`
2. Review categories (truncated codes, missing countries, etc.)
3. Fix country code mappings in `scripts/generate-shopify-skus.ts`
4. Fix FiRoam code mappings in `scripts/match-firoam-packages.ts`
5. Re-run pipeline: `npm run pipeline`
6. Verify improved match rate

## Performance

- **Phase 1**: ~2 seconds (13,391 SKUs)
- **Phase 2**: ~15 seconds (168 countries, 13,391 SKUs)
- **Phase 3**: ~5 seconds (7,356 mappings, 2.2 MB file)
- **Phase 4**: ~6-8 seconds (7,356 database upserts)
- **Phase 5**: ~1 second (13,454 rows)
- **Phase 6**: ~1 second (filtering)
- **Phase 7**: ~2 seconds (comparison)

**Total**: ~35-40 seconds for full pipeline

## Help

Run help command:
```bash
npm run pipeline:help
```

View this documentation:
```bash
cat docs/PIPELINE.md
```
