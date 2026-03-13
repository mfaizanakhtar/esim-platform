# SKU Mapping Format

> **Document Type**: Feature  
> **Status**: ✅ Current  
> **Last Updated**: 2026-03-01  
> **Purpose**: SKU to FiRoam plan mapping strategy

---

## Overview

The `ProviderSkuMapping` table stores mappings between Shopify product SKUs and provider-specific package identifiers.

## FiRoam Format

For FiRoam provider, the `providerSku` field must follow this format:

```
skuId:priceId
```

### Example

```
26:17464
```

Where:
- `26` = FiRoam SKU ID (numeric identifier for the country/region)
- `17464` = FiRoam Price ID (numeric package identifier from API)

⚠️ **Important**: Use the numeric `priceId`, NOT the `apiCode` string!

## Finding the Correct Values

### Step 1: Find the SKU ID

Open `firoam-data/firoam-skus.csv` and find your destination:

```csv
SKU_ID,Display_Name,Country_Code,Region,Image_URL
26,"Japan",392,"Asia","https://..."
7,"United States",840,"North America","https://..."
13,"Malaysia",458,"Asia","https://..."
```

### Step 2: Find the Price ID

The FiRoam API returns packages with TWO identifiers:
- `apiCode`: String like "392-0-3-1-G" (human-readable)
- `priceid`: Numeric like 441 (used for ordering)

**You need the numeric `priceid`**, not the `apiCode`!

To find it, run this helper script:

```bash
npm run find:priceid
```

Or directly:

```bash
npx ts-node scripts/find-package-priceid.ts
```

Or check the CSV files (after re-generating with updated script):

```csv
SKU_ID,SKU_Name,Price_ID,API_Code,Data_Amount,Unit,Days,Price_USD,...
26,"Japan",17464,"392-1-1-300-M",300,"MB",1,0.14,...
26,"Japan",424,"392-0-3-1-G",1,"GB",3,0.72,...
```

### Step 3: Combine as `skuId:priceId`

```
26:17464
26:424
```

## Package Types

### Fixed Packages

Fixed packages have a set validity period (e.g., "1GB valid for 3 days total").

```typescript
{
  shopifySku: 'JP-1GB-3D-FIXED',
  provider: 'firoam',
  providerSku: '26:424',
  packageType: 'fixed',
  daysCount: null,
}
```

### Daypass Packages

Daypass packages provide data allowance per day (e.g., "1GB/day for 3 days = 3GB total").
These packages use the `Support_Daypass=1` packages from FiRoam.

```typescript
{
  shopifySku: 'JP-1GB-3D-DAYPASS',
  provider: 'firoam',
  providerSku: '26:daypass_priceid', // Use the priceId from packages with "?" in API_Code
  packageType: 'daypass',
  daysCount: 3, // Number of day passes (sends daypassDays: "3" to FiRoam API)
}
```

**Important**: Daypass packages require:
- A priceId from packages where `Support_Daypass=1`
- The `daysCount` field must be set
- The value must be between `minDay` and `maxDay` from the package info

## Database Examples

```typescript
{
  shopifySku: 'ESIM-JAPAN-300MB-1D',
  provider: 'firoam',
  providerSku: '26:17464',  // ← Format: skuId:priceId (NUMERIC!)
  name: 'Japan 300MB eSIM',
  region: 'Asia',
  dataAmount: '300MB',
  validity: '1 day',
  isActive: true
}
```

## API Request Format

When provisioning an eSIM, the worker will parse the `providerSku` and call the FiRoam API:

```javascript
{
  skuId: '26',        // ← Extracted from providerSku (first part)
  priceId: '17464',   // ← Extracted from providerSku (second part, NUMERIC!)
  count: '1',
  backInfo: '1',
  customerEmail: 'user@example.com'
}
```

## Seeding Data

Run the seed script to populate sample mappings:

```bash
npm run db:seed
```

Or directly:

```bash
npx ts-node prisma/seed-sku-mappings.ts
```

This will create mappings for:
- Japan (1GB, 5GB)
- USA (1GB, 10GB)
- Malaysia (1GB)

## Shopify Product Setup

1. In Shopify Admin, edit your product variant
2. Set the SKU field to match a `shopifySku` in the database
3. Example: `ESIM-JAPAN-1GB-3D`

When a customer purchases this variant, the webhook will:
1. Capture the SKU: `ESIM-JAPAN-1GB-3D`
2. Look up the mapping in database
3. Extract `26:392-0-3-1-G`
4. Call FiRoam API with `skuId=26` and `priceId=392-0-3-1-G`

## Error Handling

If you see this error:

```
Invalid providerSku format: 392-1-1-300-M. 
Expected format: "skuId:priceId" (e.g., "26:17464")
```

Or:

```
NumberFormatException: For input string: "392-1-1-300-M"
```

This means you're using the `apiCode` string instead of the numeric `priceId`. Update the database:

```sql
-- First, find the correct priceId using the helper script:
-- npm run find:priceid

-- Then update:
UPDATE "ProviderSkuMapping" 
SET "providerSku" = '26:17464'  -- Use numeric priceId!
WHERE "providerSku" = '26:392-1-1-300-M';
```
