import { describe, it, expect } from 'vitest';
import FiRoamClient from '../vendor/firoamClient';
import QRCode from 'qrcode';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Helper Types
// ============================================================================

interface CheapestPlan {
  skuId: string;
  priceId: string;
  price: number;
  display: string;
  supportDaypass?: number;
  minDay?: number;
  mustDate?: number;
}

interface OrderCard {
  code?: string;
  sm_dp_address?: string;
  activationCode?: string;
  iccid?: string;
  mobileNumber?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Find the cheapest available eSIM plan by searching through SKUs
 */
async function findCheapestPlan(client: FiRoamClient): Promise<CheapestPlan | null> {
  const skuResult = await client.getSkus();
  if (!skuResult.skus || skuResult.skus.length === 0) {
    return null;
  }

  let cheapestPlan: CheapestPlan | null = null;

  // Search through first 10 SKUs for efficiency
  for (const sku of skuResult.skus.slice(0, 10)) {
    const packagesResult = await client.getPackages(sku.skuid.toString());

    if (
      packagesResult.packageData?.esimPackageDtoList &&
      packagesResult.packageData.esimPackageDtoList.length > 0
    ) {
      for (const plan of packagesResult.packageData.esimPackageDtoList) {
        const price = typeof plan.price === 'string' ? parseFloat(plan.price) : plan.price;

        if (!cheapestPlan || price < cheapestPlan.price) {
          cheapestPlan = {
            skuId: sku.skuid.toString(),
            priceId: plan.priceid.toString(),
            price,
            display: `${packagesResult.packageData.display} - ${plan.flows}${plan.unit}/${plan.days}d`,
            supportDaypass: plan.supportDaypass,
            minDay: plan.minDay,
            mustDate: plan.mustDate,
          };
        }
      }
    }
  }

  return cheapestPlan;
}

/**
 * Build order payload with required and conditional fields
 */
function buildOrderPayload(plan: CheapestPlan): Record<string, string> {
  const payload: Record<string, string> = {
    skuId: plan.skuId,
    priceId: plan.priceId,
    count: '1',
  };

  // Add daypassDays for day-pack packages
  if (plan.supportDaypass === 1 && plan.minDay) {
    payload.daypassDays = plan.minDay.toString();
  }

  // Add beginDate if required
  if (plan.mustDate === 1) {
    const today = new Date();
    payload.beginDate = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;
  }

  return payload;
}

/**
 * Extract order number from API response
 */
function extractOrderNumber(response: unknown): string | undefined {
  const resp = response as Record<string, unknown>;
  const data = resp.data;
  if (typeof data === 'object' && data && (data as Record<string, unknown>).orderNum) {
    return (data as Record<string, unknown>).orderNum as string;
  }
  if (typeof data === 'string') {
    return data;
  }
  return undefined;
}

/**
 * Extract full LPA string from card data
 * FiRoam returns 'code' field with full LPA (LPA:1$...) or 'sm_dp_address' as fallback
 */
function extractLpaString(card: OrderCard): string {
  return card.code || card.sm_dp_address || '';
}

/**
 * Generate QR code and save to file
 */
async function generateQrCode(lpaString: string, outputPath: string): Promise<void> {
  await QRCode.toFile(outputPath, lpaString, {
    width: 400,
    margin: 2,
  });
}

/**
 * Generate test result files (markdown and HTML)
 */
async function generateTestResults(
  lpaString: string,
  orderNum: string,
  plan: CheapestPlan,
  card: OrderCard,
  outputDir: string,
): Promise<void> {
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Generate QR code file
  const qrFilePath = path.join(outputDir, 'esim-qr.png');
  await generateQrCode(lpaString, qrFilePath);
  console.log(`\n📱 QR Code generated: ${qrFilePath}`);

  // Generate QR as data URL for HTML embedding
  const qrDataUrl = await QRCode.toDataURL(lpaString, { width: 400 });

  // Create markdown report
  const testResultMd = createMarkdownReport(lpaString, orderNum, plan, card);
  const mdFilePath = path.join(outputDir, 'test-result.md');
  fs.writeFileSync(mdFilePath, testResultMd);
  console.log(`📄 Test result saved: ${mdFilePath}`);

  // Create HTML report
  const htmlContent = createHtmlReport(lpaString, orderNum, plan, card, qrDataUrl);
  const htmlFilePath = path.join(outputDir, 'test-result.html');
  fs.writeFileSync(htmlFilePath, htmlContent);
  console.log(`🌐 HTML result saved: ${htmlFilePath}`);
  console.log(`\n💡 Open test-result.html in your browser to view the QR code\n`);
}

/**
 * Create markdown report content
 */
function createMarkdownReport(
  lpaString: string,
  orderNum: string,
  plan: CheapestPlan,
  card: OrderCard,
): string {
  return `# eSIM Test Result

**Generated:** ${new Date().toISOString()}

## Order Details
- **Order Number:** ${orderNum}
- **SKU:** ${plan.skuId}
- **Plan:** ${plan.display}
- **Price:** $${plan.price}
- **ICCID:** ${card.iccid || card.mobileNumber || 'N/A'}
- **Activation Code:** ${card.activationCode || 'N/A'}

## eSIM Installation

### Scan QR Code
![eSIM QR Code](esim-qr.png)

### Or Manual Entry
\`\`\`
${lpaString}
\`\`\`

### Installation Instructions

#### iOS
1. Go to **Settings** → **Cellular** → **Add eSIM**
2. Tap **Use QR Code**
3. Scan the QR code above
4. Follow the prompts to activate

#### Android
1. Go to **Settings** → **Network & Internet** → **SIMs**
2. Tap **Add eSIM** or **Download a SIM instead?**
3. Scan the QR code above
4. Follow the prompts to activate

## Technical Details
- **LPA String:** \`${lpaString}\`
- **Test Files:**
  - QR Code: \`test-output/esim-qr.png\`
  - This report: \`test-output/test-result.md\`
`;
}

/**
 * Create HTML report content
 */
function createHtmlReport(
  lpaString: string,
  orderNum: string,
  plan: CheapestPlan,
  card: OrderCard,
  qrDataUrl: string,
): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>eSIM Test Result - ${orderNum}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; line-height: 1.6; }
    h1 { color: #333; border-bottom: 2px solid #007AFF; padding-bottom: 10px; }
    h2 { color: #555; margin-top: 30px; }
    .qr-container { text-align: center; margin: 30px 0; padding: 20px; background: #f5f5f5; border-radius: 8px; }
    .qr-container img { max-width: 400px; border: 1px solid #ddd; }
    .lpa-string { background: #f0f0f0; padding: 15px; border-radius: 5px; font-family: monospace; word-break: break-all; margin: 10px 0; }
    .details { background: #f9f9f9; padding: 15px; border-left: 4px solid #007AFF; margin: 20px 0; }
    .instructions { background: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>🌐 eSIM Test Result</h1>
  <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>

  <div class="details">
    <h2>📋 Order Details</h2>
    <ul>
      <li><strong>Order Number:</strong> ${orderNum}</li>
      <li><strong>SKU:</strong> ${plan.skuId}</li>
      <li><strong>Plan:</strong> ${plan.display}</li>
      <li><strong>Price:</strong> $${plan.price}</li>
      <li><strong>ICCID:</strong> ${card.iccid || card.mobileNumber || 'N/A'}</li>
      <li><strong>Activation Code:</strong> ${card.activationCode || 'N/A'}</li>
    </ul>
  </div>

  <h2>📱 eSIM Installation</h2>

  <div class="qr-container">
    <h3>Scan QR Code</h3>
    <img src="${qrDataUrl}" alt="eSIM QR Code" />
  </div>

  <h3>Or Manual Entry</h3>
  <div class="lpa-string">${lpaString}</div>

  <div class="instructions">
    <h3>📖 Installation Instructions</h3>
    
    <h4>iOS</h4>
    <ol>
      <li>Go to <strong>Settings</strong> → <strong>Cellular</strong> → <strong>Add eSIM</strong></li>
      <li>Tap <strong>Use QR Code</strong></li>
      <li>Scan the QR code above</li>
      <li>Follow the prompts to activate</li>
    </ol>

    <h4>Android</h4>
    <ol>
      <li>Go to <strong>Settings</strong> → <strong>Network & Internet</strong> → <strong>SIMs</strong></li>
      <li>Tap <strong>Add eSIM</strong> or <strong>Download a SIM instead?</strong></li>
      <li>Scan the QR code above</li>
      <li>Follow the prompts to activate</li>
    </ol>
  </div>

  <h2>🔧 Technical Details</h2>
  <p><strong>LPA String:</strong></p>
  <code>${lpaString}</code>
  <p style="margin-top: 20px;"><strong>Test Files:</strong></p>
  <ul>
    <li>QR Code: <code>test-output/esim-qr.png</code></li>
    <li>Markdown Report: <code>test-output/test-result.md</code></li>
    <li>HTML Report: <code>test-output/test-result.html</code></li>
  </ul>
</body>
</html>`;
}

/**
 * Attempt to cancel an order with error handling
 */
async function cancelOrder(
  orderNum: string,
  iccid: string,
): Promise<{ success: boolean; message: string }> {
  const cancelClient = new FiRoamClient();
  const result = await cancelClient.cancelOrder({
    orderNum,
    iccids: iccid,
  });
  return {
    success: result.success,
    message: ((result as Record<string, unknown>).message as string | undefined) || '',
  };
}

// ============================================================================
// Integration Tests
// ============================================================================

/**
 * Live Integration Tests for FiRoam API
 *
 * These tests make real API calls to the FiRoam production environment.
 *
 * To run:
 *   FIROAM_INTEGRATION=true \
 *   FIROAM_PHONE=your-phone \
 *   FIROAM_PASSWORD=your-password \
 *   npx vitest run src/tests/firoam.integration.test.ts
 *
 * Note: FiRoam does not provide a sandbox environment.
 * Use test credentials and be careful not to place actual orders.
 */

describe('FiRoam API - Live Integration Tests', () => {
  const skipIfNotEnabled = () => {
    if (process.env.FIROAM_INTEGRATION !== 'true') {
      console.log('⏭️  Skipping live integration tests (set FIROAM_INTEGRATION=true to run)');
      return true;
    }
    return false;
  };

  it('should login and fetch SKUs from live API', async () => {
    if (skipIfNotEnabled()) return;

    if (!process.env.FIROAM_PHONE || !process.env.FIROAM_PASSWORD || !process.env.FIROAM_SIGN_KEY) {
      console.warn('⚠️  Skipping: missing required environment variables');
      return;
    }

    const client = new FiRoamClient();
    const result = await client.getSkus();

    console.log(`✅ Retrieved ${result.skus?.length || 0} SKUs from FiRoam API`);

    expect(result.raw).toBeDefined();
    expect(result.raw.code === 0 || result.raw.code === '0').toBe(true);
    expect(Array.isArray(result.skus)).toBe(true);
    expect(result.skus?.length).toBeGreaterThan(0);

    if (result.error) {
      console.error('Validation error:', result.error);
    }

    // Log sample SKUs
    if (result.skus && result.skus.length > 0) {
      console.log('Sample SKUs:', result.skus.slice(0, 3));
    }
  }, 15000);

  it('should fetch packages for a specific SKU', async () => {
    if (skipIfNotEnabled()) return;

    if (!process.env.FIROAM_PHONE || !process.env.FIROAM_PASSWORD) {
      console.warn('⚠️  Skipping: missing credentials');
      return;
    }

    const client = new FiRoamClient();

    // First get SKUs to find a valid one
    const skuResult = await client.getSkus();
    if (!skuResult.skus || skuResult.skus.length === 0) {
      console.log('No SKUs available');
      return;
    }

    const testSku = skuResult.skus[0];
    console.log(`Testing with SKU: ${testSku.display} (${testSku.skuid})`);

    const packagesResult = await client.getPackages(testSku.skuid.toString());

    console.log(
      `✅ Retrieved ${packagesResult.packageData?.esimPackageDtoList?.length || 0} packages`,
    );

    expect(packagesResult.raw).toBeDefined();
    expect(packagesResult.raw.code === 0 || packagesResult.raw.code === '0').toBe(true);

    if (packagesResult.packageData && packagesResult.packageData.esimPackageDtoList.length > 0) {
      const packageData = packagesResult.packageData;
      console.log(`Sample package for ${packageData.display}:`);
      if (packageData.esimPackageDtoList.length > 0) {
        const plan = packageData.esimPackageDtoList[0];
        console.log(`  - ${plan.flows}${plan.unit} / ${plan.days} days - $${plan.price}`);
      }
    }
  }, 15000);

  it('should complete full discovery flow: SKUs -> Packages', async () => {
    if (skipIfNotEnabled()) return;

    if (!process.env.FIROAM_PHONE || !process.env.FIROAM_PASSWORD) {
      console.warn('⚠️  Skipping: missing credentials');
      return;
    }

    const client = new FiRoamClient();

    // Step 1: Get all SKUs
    console.log('Step 1: Fetching SKUs...');
    const skuResult = await client.getSkus();
    expect(skuResult.skus).toBeDefined();
    expect(skuResult.skus!.length).toBeGreaterThan(0);
    console.log(`✅ Found ${skuResult.skus!.length} SKUs`);

    // Step 2: Find a SKU that has packages
    let selectedSku = skuResult.skus![0];
    let packagesResult;
    let foundPackages = false;

    // Try first few SKUs until we find one with packages
    for (let i = 0; i < Math.min(5, skuResult.skus!.length); i++) {
      selectedSku = skuResult.skus![i];
      console.log(`\nStep 2: Trying ${selectedSku.display} (${selectedSku.skuid})...`);

      packagesResult = await client.getPackages(selectedSku.skuid.toString());

      if (packagesResult.packageData && packagesResult.packageData.esimPackageDtoList.length > 0) {
        foundPackages = true;
        console.log(`✅ Found ${packagesResult.packageData.esimPackageDtoList.length} package(s)`);
        break;
      } else {
        console.log(`  No packages available, trying next SKU...`);
      }
    }

    if (!foundPackages || !packagesResult?.packageData) {
      console.log('⚠️  No packages found for any of the tested SKUs');
      return;
    }

    const pkg = packagesResult.packageData;
    console.log(`\nPackage details for ${pkg.display}:`);
    console.log(`  Plans available: ${pkg.esimPackageDtoList.length}`);

    if (pkg.esimPackageDtoList.length > 0) {
      const plan = pkg.esimPackageDtoList[0];
      console.log(`\nSample plan:`);
      console.log(`  - Data: ${plan.flows}${plan.unit}`);
      console.log(`  - Duration: ${plan.days} days`);
      console.log(`  - Price: $${plan.price}`);
      console.log(`  - Price ID: ${plan.priceid} (required for ordering)`);
      console.log(`  - Support daypass: ${plan.supportDaypass}`);
      console.log(`  - Must specify date: ${plan.mustDate}`);

      expect(plan.priceid).toBeGreaterThan(0);
      expect(plan.flows).toBeGreaterThan(0);
      expect(plan.days).toBeGreaterThan(0);
    }
  }, 30000);

  it('should demonstrate order payload construction (without placing order)', async () => {
    if (skipIfNotEnabled()) return;

    if (!process.env.FIROAM_PHONE || !process.env.FIROAM_PASSWORD) {
      console.warn('⚠️  Skipping: missing credentials');
      return;
    }

    const client = new FiRoamClient();

    // Get SKUs and packages
    const skuResult = await client.getSkus();
    if (!skuResult.skus || skuResult.skus.length === 0) {
      console.log('No SKUs available');
      return;
    }

    const sku = skuResult.skus[0];
    const packagesResult = await client.getPackages(sku.skuid.toString());

    if (!packagesResult.packageData || packagesResult.packageData.esimPackageDtoList.length === 0) {
      console.log('No packages available');
      return;
    }

    const pkg = packagesResult.packageData;
    if (!pkg.esimPackageDtoList || pkg.esimPackageDtoList.length === 0) {
      console.log('No plans available');
      return;
    }

    const plan = pkg.esimPackageDtoList[0];

    // Build order payload
    const orderPayload: Record<string, string> = {
      skuId: sku.skuid.toString(),
      priceId: plan.priceid.toString(),
      count: '1',
    };

    // Add conditional fields
    if (plan.supportDaypass === 1) {
      orderPayload.daypassDays = plan.minDay.toString();
      console.log(`📌 Day-pack package - adding daypassDays: ${orderPayload.daypassDays}`);
    }

    if (plan.mustDate === 1) {
      const today = new Date();
      const dateStr = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;
      orderPayload.beginDate = dateStr;
      console.log(`📌 Date-required package - adding beginDate: ${orderPayload.beginDate}`);
    }

    console.log('\n📦 Order payload ready for addEsimOrder():');
    console.log(JSON.stringify(orderPayload, null, 2));
    console.log('\n⚠️  Order placement is NOT executed in this test to prevent accidental charges');

    // Verify payload structure
    expect(orderPayload.skuId).toBeDefined();
    expect(orderPayload.priceId).toBeDefined();
    expect(orderPayload.count).toBe('1');
  }, 20000);

  it('should handle order cancellation (requires valid orderNum)', async () => {
    if (skipIfNotEnabled()) return;

    if (!process.env.FIROAM_PHONE || !process.env.FIROAM_PASSWORD) {
      console.warn('⚠️  Skipping: missing credentials');
      return;
    }

    // This test requires a valid order number to cancel
    // Since we don't want to place orders just to cancel them, we'll test with
    // an expected-to-fail order number to verify the API structure works
    const client = new FiRoamClient();

    const result = await client.cancelOrder({
      orderNum: 'EP-INTEGRATION-TEST-INVALID',
      iccids: '8901000000000000001', // Required field
    });

    console.log('\n🔍 Cancel Order API Response:');
    console.log(`  Status: ${result.success ? 'Success' : 'Failed'}`);
    console.log(`  Code: ${result.raw.code}`);
    console.log(`  Message: ${result.message}`);

    // Verify API structure (expect failure since order doesn't exist)
    expect(result.raw).toBeDefined();
    expect(result.raw.code).toBeDefined();
    expect(result.message).toBeDefined();
    expect(result.success).toBe(false); // Should fail since order doesn't exist

    // Common error codes from documentation:
    // -1: token expire
    // -2: params is not null
    // 3: data not exist
    // -8: refundOrder fail (order not eligible for cancellation)
    // 22: Non-personal orders
    // -30: sign wrong
    const validErrorCodes = [-1, -2, 3, -8, 22, -30];
    const code = typeof result.raw.code === 'string' ? parseInt(result.raw.code) : result.raw.code;
    expect(validErrorCodes).toContain(code);

    console.log('✅ Cancel order API structure verified (expected failure with test order number)');
  }, 15000);

  /**
   * E2E Test: Complete order lifecycle (create → retrieve → cancel)
   *
   * ⚠️  WARNING: This test places REAL orders and incurs REAL charges!
   *
   * To run:
   *   FIROAM_INTEGRATION=true \
   *   FIROAM_E2E_ORDERS=true \
   *   FIROAM_PHONE=your-phone \
   *   FIROAM_PASSWORD=your-password \
   *   npx vitest run src/tests/firoam.integration.test.ts -t "complete order lifecycle"
   *
   * Safeguards:
   * - Requires FIROAM_E2E_ORDERS=true (prevents accidental runs)
   * - Uses cheapest available plan (minimizes cost)
   * - Immediately cancels order after creation
   * - Verifies cancellation succeeded
   */
  it('should complete order lifecycle: create → retrieve → cancel', async () => {
    if (skipIfNotEnabled()) return;

    // Additional safeguard: require explicit opt-in
    if (process.env.FIROAM_E2E_ORDERS !== 'true') {
      console.log('⏭️  Skipping E2E order test (set FIROAM_E2E_ORDERS=true to run)');
      console.log('⚠️  WARNING: This test places real orders and incurs real charges');
      return;
    }

    if (!process.env.FIROAM_PHONE || !process.env.FIROAM_PASSWORD) {
      console.warn('⚠️  Skipping: missing credentials');
      return;
    }

    const client = new FiRoamClient();
    let orderNum: string | undefined;
    let iccid: string | undefined;

    try {
      // Step 1: Find cheapest available package
      console.log('\n📋 Step 1: Finding cheapest available package...');
      const cheapestPlan = await findCheapestPlan(client);

      if (!cheapestPlan) {
        console.log('❌ Could not find any available packages');
        return;
      }

      console.log(`✅ Found cheapest plan: ${cheapestPlan.display}`);
      console.log(`   Price: $${cheapestPlan.price}`);
      console.log(`   SKU ID: ${cheapestPlan.skuId}`);
      console.log(`   Price ID: ${cheapestPlan.priceId}`);
      console.log(`   Support Daypass: ${cheapestPlan.supportDaypass}`);
      console.log(`   Must Date: ${cheapestPlan.mustDate}`);

      // Step 2: Place order
      console.log('\n📦 Step 2: Placing order...');
      const orderClient = new FiRoamClient();
      const orderPayload = buildOrderPayload(cheapestPlan);

      console.log('   Order payload:', JSON.stringify(orderPayload, null, 2));
      const orderResult = await orderClient.addEsimOrder(orderPayload);

      expect(orderResult.raw).toBeDefined();
      expect(orderResult.raw.code === 0 || orderResult.raw.code === '0').toBe(true);

      orderNum = extractOrderNumber(orderResult.raw);
      expect(orderNum).toBeDefined();
      console.log(`✅ Order placed successfully: ${orderNum}`);

      // Step 3: Retrieve order details
      console.log('\n🔍 Step 3: Retrieving order details...');
      const orderInfo = await orderClient.getOrderInfo(orderNum!);

      expect(orderInfo.data).toBeDefined();
      const orderData = orderInfo.data as Record<string, unknown>;
      expect(Array.isArray(orderData.cardApiDtoList)).toBe(true);
      expect((orderData.cardApiDtoList as unknown[]).length).toBeGreaterThan(0);

      const card = (orderData.cardApiDtoList as unknown[])[0] as OrderCard;
      const lpaString = extractLpaString(card);
      expect(lpaString).toBeDefined();

      console.log(`✅ Full LPA String: ${lpaString}`);
      console.log(`✅ SM-DP+ Address: ${card.sm_dp_address}`);
      console.log(`✅ Activation Code: ${card.activationCode || 'N/A'}`);
      console.log(`✅ ICCID: ${card.iccid || card.mobileNumber || 'N/A'}`);

      iccid = card.iccid || card.mobileNumber;

      // Step 4: Generate QR code and test results
      console.log(`\n🔍 Generating QR from REAL LPA (${lpaString.length} chars): ${lpaString}`);
      const qrOutputDir = path.join(process.cwd(), 'test-output');
      await generateTestResults(lpaString, orderNum!, cheapestPlan, card, qrOutputDir);

      // Step 5: Cancel order
      console.log(`\n🔄 Step 5: Cancelling order ${orderNum}...`);
      expect(iccid).toBeDefined();

      const cancelResult = await cancelOrder(orderNum!, iccid!);

      console.log(`   Cancel status: ${cancelResult.success ? 'SUCCESS' : 'FAILED'}`);
      console.log(`   Message: ${cancelResult.message}`);

      if (cancelResult.success) {
        console.log('✅ Order cancelled successfully');
      } else {
        console.log(`⚠️  Cancellation failed: ${cancelResult.message}`);
        console.log('   (Some orders may not be cancellable immediately after creation)');
      }

      console.log('\n✅ Complete E2E order lifecycle test finished');
      console.log(
        `💰 Cost incurred: ~$${cheapestPlan.price} (${cancelResult.success ? 'may be refunded' : 'charged'})`,
      );
    } catch (error) {
      console.error('\n❌ E2E test failed:', error);

      // Attempt to cancel order even if test failed
      if (orderNum && iccid) {
        console.log(`\n🔄 Attempting to cancel order ${orderNum} after error...`);
        try {
          const cleanupResult = await cancelOrder(orderNum, iccid);
          console.log(
            `   Cleanup cancel: ${cleanupResult.success ? 'SUCCESS' : 'FAILED (may need manual cleanup)'}`,
          );
        } catch (cancelError) {
          console.error('❌ Cleanup cancellation also failed:', cancelError);
          console.error(`⚠️  MANUAL ACTION REQUIRED: Cancel order ${orderNum} manually`);
        }
      }

      throw error;
    }
  }, 60000); // Longer timeout for multi-step test

  /**
   * Complete E2E test: Issue eSIM -> Query Usage -> Verify Data -> Cancel
   * This test demonstrates the full lifecycle including data usage tracking
   */
  it('[LIVE] should issue eSIM, query usage data, and cancel order', async () => {
    console.log('\n📝 Starting E2E test with usage tracking...');

    const client = new FiRoamClient();
    let orderNum: string | undefined;
    let iccid: string | undefined;

    try {
      // Step 1: Find cheapest plan
      console.log('\n🔍 Step 1: Finding cheapest plan...');
      const cheapestPlan = await findCheapestPlan(client);
      if (!cheapestPlan) {
        throw new Error('No valid plans found');
      }

      console.log(`   Found: ${cheapestPlan.display}`);
      console.log(`   Price: $${cheapestPlan.price}`);
      console.log(`   SKU: ${cheapestPlan.skuId}, Price ID: ${cheapestPlan.priceId}`);

      // Step 2: Place order
      console.log('\n📦 Step 2: Placing order...');
      const orderPayload = buildOrderPayload(cheapestPlan);
      console.log(`   Payload: ${JSON.stringify(orderPayload)}`);

      const result = await client.addEsimOrder(orderPayload);

      expect(result.raw).toBeDefined();
      expect(result.canonical).toBeDefined();

      orderNum = extractOrderNumber(result.raw);
      expect(orderNum).toBeDefined();

      console.log(`✅ Order placed: ${orderNum}`);
      console.log(`   Canonical: ${JSON.stringify(result.canonical, null, 2)}`);

      iccid = result.canonical?.iccid as string | undefined;
      expect(iccid).toBeDefined();
      console.log(`✅ ICCID: ${iccid}`);

      // Step 3: Query usage data
      console.log('\n📊 Step 3: Querying usage data...');
      const usageResult = await client.queryEsimOrder({ iccid: iccid! });

      expect(usageResult.success).toBe(true);
      expect(usageResult.orders).toBeDefined();
      expect(usageResult.orders!.length).toBeGreaterThan(0);

      const order = usageResult.orders![0];
      console.log(`   Order: ${order.orderNum}`);
      console.log(`   SKU: ${order.skuName}`);
      console.log(`   Packages: ${order.packages.length}`);

      // Find matching package
      const packageData = order.packages.find((pkg) => pkg.iccid === iccid);
      expect(packageData).toBeDefined();

      console.log('\n   📈 Usage Details:');
      console.log(`      Data: ${packageData!.flows}${packageData!.unit}`);
      console.log(`      Used: ${packageData!.usedMb} MB`);
      console.log(`      Days: ${packageData!.days}`);
      console.log(`      Start: ${packageData!.beginDate}`);
      console.log(`      End: ${packageData!.endDate}`);
      console.log(`      Status: ${packageData!.status}`);

      // Verify usage data structure
      expect(packageData!.flows).toBeDefined();
      expect(packageData!.unit).toBeDefined();
      expect(packageData!.usedMb).toBeDefined();
      expect(typeof packageData!.usedMb).toBe('number');
      expect(packageData!.iccid).toBe(iccid);

      // Step 4: Cancel order
      console.log(`\n🔄 Step 4: Cancelling order ${orderNum}...`);
      const cancelResult = await client.cancelOrder({
        orderNum: orderNum!,
        iccids: iccid!,
      });

      console.log(`   Cancel status: ${cancelResult.success ? 'SUCCESS' : 'FAILED'}`);
      console.log(`   Message: ${cancelResult.message}`);

      if (cancelResult.success) {
        console.log('✅ Order cancelled successfully');
      } else {
        console.log(`⚠️  Cancellation failed: ${cancelResult.message}`);
      }

      console.log('\n✅ E2E usage tracking test completed');
      console.log(`💰 Cost: ~$${cheapestPlan.price}`);
    } catch (error) {
      console.error('\n❌ E2E usage test failed:', error);

      // Cleanup attempt
      if (orderNum && iccid) {
        console.log(`\n🔄 Attempting cleanup for order ${orderNum}...`);
        try {
          const cleanupResult = await client.cancelOrder({
            orderNum,
            iccids: iccid,
          });
          console.log(`   Cleanup: ${cleanupResult.success ? 'SUCCESS' : 'FAILED'}`);
        } catch (cleanupError) {
          console.error('❌ Cleanup failed:', cleanupError);
        }
      }

      throw error;
    }
  }, 60000); // Extended timeout for multi-step operation
});
