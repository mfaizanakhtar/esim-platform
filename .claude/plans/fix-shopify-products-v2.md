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

### P3: AI-generated SEO
Use OpenAI to generate per-country:
- **SEO title**: e.g. "Saudi Arabia eSIM | Instant 4G/5G Data Plans | SAILeSIM"
- **SEO description**: e.g. "Buy Saudi Arabia eSIM. Instant activation, no physical SIM..."
- **Product description HTML**: Country-specific, mentions networks, coverage tips

## Implementation

### 1. Fix variant creation (`client.ts`)
- Test `inventoryPolicy` and `tracked` fields against the actual API
- Add GraphQL error logging in variant creation
- Remove invalid fields if needed

### 2. Variant set (80 per product, under 100 limit)

**Day-Pass**: 8 validities × 5 volumes = 40
- Validities: 1-Day, 2-Days, 3-Days, 5-Days, 7-Days, 10-Days, 15-Days, 30-Days
- Volumes: 1 GB, 2 GB, 3 GB, 5 GB, 10GB

**Total Data**: 5 validities × 8 volumes = 40
- Validities: 1-Day, 3-Days, 7-Days, 15-Days, 30-Days
- Volumes: 1 GB, 2 GB, 3 GB, 5 GB, 10GB, 15GB, 20GB, 30GB

**Total: 80** (under 100 limit)

### 3. Product metadata (`admin.ts`)
- `vendor`: "SAILeSIM"
- `tags`: Region tag (Europe, Asia, Middle East, Africa, Americas, Oceania)
- `descriptionHtml`: Embed flag image + description text
- Volume format: "1 GB" with space for ≤5GB, "10GB" without for ≥10GB (matching Saudi Arabia)

### 4. AI SEO generation
After product creation, call OpenAI to generate SEO title + description + rich product HTML.
Update product via `productUpdate` mutation. Runs in background.

### 5. Region mapping (`countryCodes.ts`)
Add `region` field: Europe, Asia, Middle East, Africa, North America, South America, Oceania, Caribbean.

## Files to Modify
- `fulfillment-engine/src/shopify/client.ts`
- `fulfillment-engine/src/api/admin.ts`
- `fulfillment-engine/src/utils/countryCodes.ts`

## Verification
1. Test variant creation with curl
2. `npm test -- --run`
3. Test with `{ countries: ["QA"] }`
4. Verify in Shopify: 80 variants, tags, SEO, flag
