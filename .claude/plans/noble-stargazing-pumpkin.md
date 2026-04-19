# Fix: Normalize daypass pricing for Smart Pricing and display

## Context
FiRoam daypass catalog entries store the **per-day** price (e.g. $1.50/day), while TGT daily packs store the **total** price (e.g. $8.00 for 7 days). Smart Pricing sorts by `catalogEntry.netPrice`, making FiRoam always appear cheapest even when TGT is actually cheaper over the full duration. The dashboard also displays raw `netPrice`, making comparison misleading.

## Approach
Compute an `effectivePrice` for each mapping = total cost for the SKU's duration. For FiRoam daypass: `netPrice × daysCount`. For everything else: `netPrice` as-is.

## Changes

### 1. Backend: Smart Pricing (`admin.ts` ~line 878-916)
- Include `packageType`, `daysCount` in the query alongside `catalogEntry.netPrice`
- When sorting, compute effective price:
  ```
  effectivePrice = (m.packageType === 'daypass' && m.daysCount)
    ? netPrice * daysCount
    : netPrice
  ```
- Sort by `effectivePrice` instead of raw `netPrice`

### 2. Backend: GET /admin/sku-mappings response
- Already returns full mapping + `catalogEntry`. No change needed — frontend can compute effective price.

### 3. Frontend: SkuMappings.tsx price display (~line 593-596)
- Show effective price instead of raw `netPrice`:
  ```
  const effectivePrice = m.packageType === 'daypass' && m.daysCount
    ? (Number(m.catalogEntry.netPrice) * m.daysCount).toFixed(2)
    : m.catalogEntry.netPrice;
  ```
- Add a tooltip or suffix like "(×5d)" to clarify the multiplication

## Files to modify
- `fulfillment-engine/src/api/admin.ts` — smart-pricing sort logic
- `dashboard/src/pages/SkuMappings.tsx` — price display

## Verification
- `npm test -- --run` in fulfillment-engine
- Check SkuMappings page: FiRoam daypass mappings should show total price (e.g. "$7.50 ×5d" instead of "$1.50")
- Run Smart Pricing and verify TGT isn't always deprioritized
