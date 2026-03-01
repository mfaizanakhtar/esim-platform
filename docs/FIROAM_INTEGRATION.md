# FiRoam eSIM API Integration

> **Document Type**: Integration  
> **Status**: ✅ Current  
> **Last Updated**: 2026-03-01  
> **Purpose**: FiRoam vendor API client implementation

---

## Overview

Complete integration with FiRoam's eSIM provisioning API for ordering and managing eSIM cards.

## ⚠️ Critical API Requirements

### HTTP Methods & Content Types

The FiRoam API has specific HTTP requirements that differ from typical REST APIs:

| Endpoint            | HTTP Method | Content-Type                        | Body Format       |
| ------------------- | ----------- | ----------------------------------- | ----------------- |
| `/api_order/login`  | **GET**     | N/A                                 | Query parameters  |
| All other endpoints | **POST**    | `application/x-www-form-urlencoded` | Form-encoded body |

**Important**: POST endpoints do NOT accept `application/json` - they will return "sign wrong" errors.

### Signature Algorithm

1. Sort parameters alphabetically by key
2. Concatenate as `key1=value1key2=value2` (no `&` separators between pairs)
3. URL-encode the concatenated string using `encodeURIComponent()`
4. Append sign key to the encoded string
5. MD5 hash the result
6. Convert to uppercase hex

```typescript
// Example signature generation
function createSign(params: Record<string, unknown>, signKey: string): string {
  const sorted = Object.keys(params).sort();
  const joined = sorted.map((k) => `${k}=${params[k]}`).join(''); // No & separator!
  const encoded = encodeURIComponent(joined);
  const toHash = encoded + signKey;
  return md5(toHash).toUpperCase();
}
```

## Authentication

- **Sign Key Required**: Get your actual API sign key from FiRoam (not the test key `1234567890qwertyuiopasdfghjklzxc`)
- **Login Flow**:
  - Call `/api_order/login` via GET with query parameters
  - Receives a `token` valid for the session
  - Token is automatically included in subsequent requests

## eSIM Ordering Flow

### 1. Discovery Phase

#### Get Available SKUs

```typescript
const result = await firoamClient.getSkus();
// Returns: { raw, skus: SkuItem[] }
// SkuItem: { skuid, display, countryCode }
```

**Alternative**: Get SKUs grouped by continent

```typescript
const result = await firoamClient.getSkuByGroup();
// Returns: { raw, grouped: SkuByGroup }
// SkuByGroup: { continent: string[], data: Record<continent, SkuNewDto[]> }
```

### 2. Package Selection

#### Get Packages for a SKU

```typescript
const result = await firoamClient.getPackages(skuId);
// Returns: { raw, packages: PackageItem[] }
```

**PackageItem** contains:

- `skuid`: Product ID
- `esimpackageDto[]`: Array of available plans
  - `priceid`: **Required for ordering** - unique package identifier
  - `price`: Package price
  - `flows`: Data amount
  - `days`: Validity period
  - `unit`: Traffic unit (GB/MB)
  - `supportDaypass`: 0=Regular, 1=Inclusive (day-pack), 2=Enum
  - `minDay`/`maxDay`: Day range constraints for day-pack packages
  - `mustDate`: Whether start date is required (1=yes, 0=no)
  - `apiCode`: Unique package identifier
  - `premark`: Description/terms
  - `networkDtoList`: Supported networks
  - `countryImageUrlDtoList`: Country information

### 3. Order Placement

#### Place eSIM Order

```typescript
const result = await firoamClient.addEsimOrder({
  skuId: '123', // From step 1
  priceId: '456', // From esimpackageDto.priceid in step 2
  count: '1', // Quantity
  daypass: '7', // Optional: for day-pack packages (supportDaypass=1)
  beginDate: '12/27/2025', // Optional: if mustDate=1 in package details
});
// Returns: { raw, canonical?: CanonicalEsimPayload }
```

**Order Parameters**:

- `skuId`: Product ID from SKU list
- `priceId`: Package price ID from getPackages result
- `count`: Order quantity (string)
- `daypass`: Days for day-pack packages (required if supportDaypass=1)
  - Must be between `minDay` and `maxDay` from package details
- `beginDate`: Start date (required if mustDate=1 in package details)
  - Format: `MM/dd/yyyy`
- `remark`: Optional remarks

**Response**:

- `raw.data.orderNum`: Order number for tracking
- `canonical`: Normalized eSIM activation data
  - `lpa`: LPA string for eSIM installation
  - `activationCode`: Activation code
  - `iccid`: SIM card identifier

### 4. Order Retrieval

#### Get Order Information

```typescript
const orderInfo = await firoamClient.getOrderInfo(orderNum);
// Returns raw order details including card information
```

## API Endpoints Implemented

| Method                   | Endpoint                  | HTTP | Purpose                            |
| ------------------------ | ------------------------- | ---- | ---------------------------------- |
| `login()`                | `/api_order/login`        | GET  | Authenticate and get session token |
| `getSkus()`              | `/api_esim/getSkus`       | POST | Get flat list of available SKUs    |
| `getSkuByGroup()`        | `/api_esim/getSkuByGroup` | POST | Get SKUs grouped by continent      |
| `getPackages(skuId)`     | `/api_esim/getPackages`   | POST | Get package/plan details for a SKU |
| `addEsimOrder(payload)`  | `/api_esim/addEsimOrder`  | POST | Place an eSIM order                |
| `getOrderInfo(orderNum)` | `/api_esim/getOrderInfo`  | POST | Retrieve order details             |

## Typical Integration Flow

```typescript
// 1. List available destinations
const { skus } = await client.getSkus();

// 2. User selects a destination (e.g., Japan, skuid: 26)
const { packages } = await client.getPackages('26');

// 3. User selects a package (e.g., 3GB for 7 days)
const selectedPackage = packages[0].esimpackageDto.find((p) => p.flows === 3 && p.days === 7);

// 4. Place order
const order = await client.addEsimOrder({
  skuId: '26',
  priceId: selectedPackage.priceid.toString(),
  count: '1',
  // Add daypass/beginDate if required by package
});

// 5. Retrieve activation details
if (order.canonical) {
  // Store/email the LPA string and activation code
  const { lpa, activationCode, iccid } = order.canonical;
}
```

### eSIM Order Flow Options

The `addEsimOrder()` method supports two flow patterns:

#### Option 1: One-Step Flow (Recommended)

Use `backInfo="1"` to get full order details immediately in a single API call:

```typescript
const order = await client.addEsimOrder({
  skuId: '26',
  priceId: '12345',
  count: '1',
  backInfo: '1', // Returns full details including cardApiDtoList
});

// Full order details in response
console.log(order.raw.data.orderNum);
console.log(order.raw.data.cardApiDtoList[0].sm_dp_address); // LPA string
console.log(order.raw.data.cardApiDtoList[0].activationCode);
```

**Benefits:**

- Single API call (faster, fewer round-trips)
- Full order details returned immediately
- More efficient for production use

#### Option 2: Two-Step Flow (Legacy)

Omit `backInfo` parameter to use the traditional two-step flow:

```typescript
// Step 1: Place order (returns only orderNum)
const order = await client.addEsimOrder({
  skuId: '26',
  priceId: '12345',
  count: '1',
  // No backInfo parameter
});

// Step 2: Automatically calls getOrderInfo() internally
// order.canonical contains extracted credentials

// Manual retrieval (if needed later):
const orderDetails = await client.getOrderInfo(order.raw.data.orderNum);
```

**Benefits:**

- Explicit control over when to fetch details
- Backward compatible with existing implementations
- Useful if order details aren't needed immediately

**Note**: Both flows work identically from the caller's perspective. The `addEsimOrder()` method intelligently detects which flow to use based on the response structure and automatically extracts credentials in both cases.

## Data Persistence

All orders are persisted to the `EsimOrder` table via Prisma:

- `orderNum`: FiRoam order number
- `skuId`, `priceId`: Order parameters
- `orderPayload`: Full request payload (encrypted JSON)
- `responsePayload`: Full response (encrypted JSON)
- `canonical`: Normalized activation data (encrypted JSON)

## Environment Variables

```bash
FIROAM_BASE_URL=https://bpm.roamwifi.hk
FIROAM_PHONE=your-phone-number
FIROAM_PASSWORD=your-password
FIROAM_SIGN_KEY=your-actual-sign-key  # Get from FiRoam, not the test key!
```

### 3. Order Management

#### Cancel/Refund an Order

```typescript
const result = await client.cancelOrder({
  orderNum: 'EP-ORDER-123',
  iccids: '8901000000000000001', // Required: ICCID(s) to cancel
});

if (result.success) {
  console.log('Order cancelled successfully');
} else {
  console.error('Cancellation failed:', result.message);
}
```

**Parameters:**

- `orderNum` (required): The order number to cancel
- `iccids` (required): Comma-separated ICCIDs for cancellation (multiple SIMs)

**Important API Constraints:**

- The `remark` parameter is **not supported** due to FiRoam API signature validation issues
- Always use minimal payload (orderNum + iccids only) for reliable cancellation
- The `iccids` field is required even though documentation marks it as optional

**Returns:**

- `{ raw, success, message }` where:
  - `success` is `true` if `code === 0`
  - `message` contains the API response message
  - `raw` contains the full API response

**Common Error Codes:**

- `-1`: Token expired
- `-2`: Required parameters missing
- `3`: Order not found
- `22`: Cannot cancel non-personal orders
- `-30`: Signature error

**Note**: According to FiRoam documentation, some orders cannot be cancelled or refunded once the "install eSIM" button is clicked. The API will return appropriate error codes for non-cancellable orders.

## Testing

### Component Tests (Mocked)

Component tests verify the FiRoamClient component with mocked API responses. These test the component's behavior in isolation without making actual API calls.

```bash
# Run all component tests
npx vitest run src/tests/*.component.test.ts

# Run specific component test
npx vitest run src/tests/firoam.cancelOrder.component.test.ts
```

**Available Component Tests:**

- `firoam.component.test.ts` - Order placement flow
- `firoam.getSkus.component.test.ts` - SKU retrieval
- `firoam.orderFlow.component.test.ts` - Complete order flow
- `firoam.cancelOrder.component.test.ts` - Order cancellation

### Integration Tests (Live API)

### Component Tests (Mocked)

Fast unit tests with mocked HTTP responses:

```bash
# Run all component tests
npx vitest run src/tests/firoam*.component.test.ts

# Run specific component test
npx vitest run src/tests/firoam.getSkus.component.test.ts
```

### Integration Tests (Live API)

Real API calls against FiRoam production:

```bash
# Run all integration tests
FIROAM_INTEGRATION=true \
FIROAM_PHONE=your-phone \
FIROAM_PASSWORD=your-password \
npx vitest run src/tests/firoam.integration.test.ts

# Run specific integration test
FIROAM_INTEGRATION=true \
FIROAM_PHONE=your-phone \
FIROAM_PASSWORD=your-password \
npx vitest run src/tests/firoam.integration.test.ts -t "should login and fetch SKUs"
```

**Note**: FiRoam does not provide a sandbox environment. Integration tests run against production with test credentials. Be careful not to place actual orders during testing.

### Verified Working (as of Dec 2024)

- ✅ Login via GET with signature
- ✅ getSkus returns 171 SKUs
- ✅ getPackages returns plan details
- ✅ addEsimOrder places orders and returns eSIM credentials
- ✅ cancelOrder API structure verified
- ✅ Form-urlencoded POST requests
- ✅ Signature algorithm with encodeURIComponent

## Test Terminology

**Component Tests** vs **Unit Tests** vs **Integration Tests**:

- **Unit Tests**: Test pure functions or single units in complete isolation
- **Component Tests**: Test a component (like FiRoamClient) with mocked dependencies (API calls). We use nock to mock HTTP requests
- **Integration Tests**: Test actual API interactions with the real FiRoam service

This codebase uses **component tests** for mocked API testing because we're testing the FiRoamClient component's behavior with mocked network dependencies, not testing individual pure functions in isolation.

## Common Pitfalls

1. **HTTP Method for Login**: Login endpoint uses **GET**, not POST
2. **Content-Type for POST**: Must use `application/x-www-form-urlencoded`, NOT `application/json`
3. **Signature Encoding**: The concatenated string must be URL-encoded with `encodeURIComponent()` before appending the sign key
4. **Sign Key**: Must use your actual sign key from FiRoam account, not the example key
5. **Day-pack Packages**: When `supportDaypass=1`, the `daypass` parameter is required
6. **Date Format**: `beginDate` must be in `MM/dd/yyyy` format
7. **String Types**: FiRoam expects numeric values as strings (e.g., `count: "1"`, `skuId: "26"`)
8. **Price ID**: Use `priceid` from package details, not the package price itself
9. **No Sandbox**: FiRoam does not provide a sandbox/test environment - all tests run against production
10. **Cancel Order Constraints**: The refundOrder endpoint does not support the `remark` parameter (causes signature errors). Always use minimal payload: orderNum + iccids only

## Next Steps

Additional endpoints available in FiRoam API but not yet implemented:

- Verify resources before ordering
- SIM renewal
- Query order lists
- Send PDF email
- Physical SIM operations
- Account balance query
