# Daypass Package Implementation

> **Document Type**: Feature  
> **Status**: ✅ Current  
> **Last Updated**: 2026-03-01  
> **Purpose**: Short-term eSIM plan implementation

---

## Overview

Daypass packages provide daily data allowances (e.g., "1GB per day for 3 days = 3GB total"), unlike fixed packages which provide a total data allowance valid for a period (e.g., "1GB valid for 3 days total").

## Database Schema

Added to `ProviderSkuMapping`:
- `packageType`: String (`'fixed'` or `'daypass'`) - Default: `'fixed'`
- `daysCount`: Integer (nullable) - Number of days for daypass packages

## Migration Applied

```sql
-- File: prisma/migrations/add-daypass-support.sql
ALTER TABLE "ProviderSkuMapping" ADD COLUMN "packageType" TEXT DEFAULT 'fixed';
ALTER TABLE "ProviderSkuMapping" ADD COLUMN "daysCount" INTEGER;
CREATE INDEX "ProviderSkuMapping_packageType_idx" ON "ProviderSkuMapping"("packageType");
```

## FiRoam API Format

### Fixed Packages
```typescript
// API Call
{
  token: "...",
  skuId: "26",         // Japan
  priceId: "424",      // 1GB/3days fixed package
  count: "1",
  backInfo: "1",
  sign: "..."
}
```

### Daypass Packages
```typescript
// API Call
{
  token: "...",
  skuId: "26",           // Japan
  priceId: "17464",      // 1GB/day daypass package
  count: "1",
  daypassDays: "3",      // ← CRITICAL: Number of day passes
  backInfo: "1",
  sign: "..."
}
```

## Shopify Product Setup

### Fixed Package Example
```
Product: Japan 1GB eSIM
Variant SKU: "ESIM-JAPAN-1GB-3D-FIXED"
Title: "Japan 1GB eSIM (Valid 3 Days Total)"
Price: $0.72
```

Database mapping:
```typescript
{
  shopifySku: "ESIM-JAPAN-1GB-3D-FIXED",
  provider: "firoam",
  providerSku: "26:424",
  packageType: "fixed",
  daysCount: null,
  dataAmount: "1GB",
  validity: "3 days"
}
```

### Daypass Package Example
```
Product: Japan Daily 1GB eSIM
Variant SKU: "ESIM-JAPAN-1GB-3D-DAYPASS"
Title: "Japan 1GB/day eSIM × 3 Days (3GB Total)"
Price: $1.38
```

Database mapping:
```typescript
{
  shopifySku: "ESIM-JAPAN-1GB-3D-DAYPASS",
  provider: "firoam",
  providerSku: "26:daypass_priceid",  // Use priceId from packages with Support_Daypass=1
  packageType: "daypass",
  daysCount: 3,
  dataAmount: "1GB/day",
  validity: "3 days"
}
```

## Identifying Daypass Packages in FiRoam Data

In CSV files (`firoam-data/firoam-packages-<countryCode>.csv`):

```csv
SKU_ID,SKU_Name,API_Code,Support_Daypass
26,"Japan","392-0-?-1-G-D",1          ← Daypass (note the "?" in API_Code)
26,"Japan","392-0-3-1-G",0            ← Fixed package
```

Daypass indicators:
- `Support_Daypass=1`
- `API_Code` contains `?` (e.g., "392-0-?-1-G-D")
- Fields `minDay` and `maxDay` define valid range

## Provision Logic

File: `src/worker/jobs/provisionEsim.ts`

```typescript
const [skuId, priceId] = mapping.providerSku.split(':');

orderPayload = {
  skuId,
  priceId,
  count: '1',
  backInfo: '1',
  customerEmail: delivery.customerEmail || undefined,
};

// Add daypassDays parameter for daypass packages
if (mapping.packageType === 'daypass') {
  if (!mapping.daysCount) {
    throw new Error(`Daypass package requires daysCount field`);
  }
  orderPayload.daypassDays = String(mapping.daysCount);
}
```

## Key Differences

| Feature | Fixed Package | Daypass Package |
|---------|--------------|-----------------|
| Data Allowance | Total (e.g., 1GB for entire period) | Daily (e.g., 1GB/day) |
| Shopify SKU Suffix | `-FIXED` | `-DAYPASS` |
| `packageType` | `'fixed'` | `'daypass'` |
| `daysCount` | `null` | `3` (example) |
| FiRoam API | No `daypassDays` parameter | Includes `daypassDays: "3"` |
| `Support_Daypass` | 0 | 1 |
| API_Code Format | `392-0-3-1-G` | `392-0-?-1-G-D` |

## Finding Daypass Price IDs

Use the helper script to find the correct priceId for daypass packages:

```bash
npm run find:priceid
```

Or check CSV files:
```bash
grep "Support_Daypass.*1" firoam-data/firoam-packages-392.csv
```

## Testing

1. **Seed database** with test mappings:
   ```bash
   npm run db:seed
   ```

2. **Create Shopify order** with daypass SKU:
   - Use SKU: `ESIM-JAPAN-1GB-3D-DAYPASS`

3. **Monitor worker logs** for:
   ```
   [ProvisionJob] Daypass package: 3 days
   [ProvisionJob] FiRoam order created: EP20260125...
   ```

4. **Verify FiRoam API call** includes `daypassDays` parameter

## Files Modified

- ✅ `prisma/schema.prisma` - Added packageType and daysCount fields
- ✅ `prisma/migrations/add-daypass-support.sql` - Migration SQL
- ✅ `src/worker/jobs/provisionEsim.ts` - Added daypass handling logic
- ✅ `prisma/seed-sku-mappings.ts` - Added daypass examples
- ✅ `docs/SKU_MAPPING_FORMAT.md` - Updated documentation
- ✅ `docs/DAYPASS_IMPLEMENTATION.md` - This file

## Next Steps

1. Find actual daypass priceIds from FiRoam API
2. Update seed script with real priceIds
3. Create Shopify products for both fixed and daypass variants
4. Test end-to-end order flow
