# Plan: Fix Product Creation + Match Saudi Arabia Format + AI SEO

## Context
Bulk product creation has two issues: (1) variants aren't being created (only the initial product shell exists), (2) our products differ from the ideal Saudi Arabia product in format, tags, volumes, SEO, etc. We'll fix everything in one pass.

## Problems to Fix

### P1: Variants not creating
`productVariantsBulkCreate` fails silently. Need to debug — likely the `inventoryPolicy: 'CONTINUE'` field isn't valid in `ProductVariantsBulkInput` for API 2026-04, or `tracked: false` isn't accepted in `InventoryItemInput`. Will test locally and fix.

### P2: Match Saudi Arabia product format
| Field | Saudi Arabia | Ours (current) | Fix |
|-------|-------------|----------------|-----|
| Volumes | 1GB-30GB with spaces ("2 GB") | "1GB" no spaces, max 20GB | Add 25GB, 30GB; use "X GB" format for <10 |
| Tags | Region-based ("Middle East") | ISO code ("de") | Add region tag from country→region map |
| Vendor | SAILeSIM | sailesim | Fix casing |
| inventoryPolicy | - | DENY | Set CONTINUE + tracked:false |
| Description | Has embedded flag | Plain text | Embed flag image in HTML |
| Volume option | "500 MB", "2 GB", "10GB" | "1GB" | Match exact Shopify format |

### P3: AI-generated SEO
Use OpenAI to generate per-country:
- **SEO title**: e.g. "Saudi Arabia eSIM | Instant 4G/5G Data Plans | SAILeSIM"
- **SEO description**: e.g. "Buy Saudi Arabia eSIM. Instant activation, no physical SIM. Day passes from $X. Coverage on STC, Mobily, Zain."
- **Product description HTML**: Country-specific, mentions networks, coverage tips

## Implementation

### 1. Fix variant creation (`client.ts`)
- Test `inventoryPolicy` and `tracked` fields against the actual API schema
- Add proper error logging for GraphQL-level errors in variant creation
- If `inventoryPolicy`/`tracked` aren't valid in bulk input, remove and set via separate mutation after creation

### 2. Update variant set to match Saudi Arabia
Expand volumes to include 25GB, 30GB. Format with spaces:

**Day-Pass**: 8 validities × 10 volumes = 80
- Validities: 1-Day, 2-Days, 3-Days, 5-Days, 7-Days, 10-Days, 15-Days, 30-Days
- Volumes: 500 MB, 1 GB, 2 GB, 3 GB, 5 GB, 10GB, 15GB, 20GB, 25GB, 30GB

**Total Data**: 8 validities × 10 volumes = 80
- Same validities and volumes

**Total: 160 → exceeds Shopify's 100 limit!**

Options to stay under 100:
- A) Trim: Day-Pass 8×6=48 + Total Data 5×8=40 = 88 ✓
- B) Remove 500MB and some large volumes: Day-Pass 8×7=56 + Total Data 5×7=35 = 91 ✓
- C) Match Saudi Arabia exactly: 26 variants (only plans that exist in catalog)

Saudi Arabia has 26 variants — only plans that actually exist. But for new countries we don't know which plans exist yet (mapping happens after creation). So we use a standardized set under 100.

**Proposed**: Day-Pass (8 validities × 5 volumes [1GB,2GB,3GB,5GB,10GB]) = 40 + Total Data (5 validities [1,3,7,15,30] × 8 volumes [1GB,2GB,3GB,5GB,10GB,15GB,20GB,30GB]) = 40 = **80 total**

### 3. Update product metadata (`admin.ts`)
- `vendor`: "SAILeSIM"
- `tags`: Region tag from country→region mapping (Europe, Asia, Middle East, Africa, Americas, Oceania)
- `descriptionHtml`: Include embedded flag image
- Volume format: "1 GB", "2 GB" (with space) for ≤5GB; "10GB", "15GB" (no space) for ≥10GB — matching Saudi Arabia exactly

### 4. AI SEO generation (`admin.ts` or new utility)
After creating each product, call OpenAI to generate:
```json
{
  "seoTitle": "Saudi Arabia eSIM | Instant Travel Data | SAILeSIM",
  "seoDescription": "Buy Saudi Arabia eSIM online...",
  "descriptionHtml": "<p>Get connected in Saudi Arabia...</p>"
}
```
Then update the product via `productUpdate` mutation with SEO fields.

Run as background task (fire-and-forget) after product creation to avoid timeout.

### 5. Add region mapping to `countryCodes.ts`
Add `region` field to each country: Europe, Asia, Middle East, Africa, North America, South America, Oceania, Caribbean.

## Files to Modify
- `fulfillment-engine/src/shopify/client.ts` — fix variant creation, add `updateProductSeo` method
- `fulfillment-engine/src/api/admin.ts` — update bulk-create with new format, AI SEO
- `fulfillment-engine/src/utils/countryCodes.ts` — add region field per country

## Verification
1. Test variant creation locally with curl against Shopify
2. `npm test -- --run` passes
3. Deploy and run bulk-create for a test country `{ countries: ["QA"] }`
4. Verify in Shopify: 80 variants, proper tags, SEO title/description, flag in description
