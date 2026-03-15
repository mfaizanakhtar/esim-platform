import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import TgtClient from '~/vendor/tgtClient';
import QRCode from 'qrcode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '~/utils/logger';

// ============================================================================
// Helper Types
// ============================================================================

interface CheapestProduct {
  productCode: string;
  netPrice: number;
  display: string;
  productType: string;
  usagePeriod?: number;
  validityPeriod?: number;
  dataTotal?: number;
  dataUnit?: string;
}

interface OrderCredentials {
  ready: boolean;
  lpa?: string;
  iccid?: string;
  activationCode?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Find the cheapest available eSIM product
 */
async function findCheapestProduct(client: TgtClient): Promise<CheapestProduct | null> {
  const result = await client.listProducts({ pageNum: 1, pageSize: 50, lang: 'en' });
  if (!result.products || result.products.length === 0) {
    return null;
  }

  const sorted = [...result.products].sort((a, b) => a.netPrice - b.netPrice);
  const cheapest = sorted[0];

  return {
    productCode: cheapest.productCode,
    netPrice: cheapest.netPrice,
    display: cheapest.productName,
    productType: cheapest.productType,
    usagePeriod: cheapest.usagePeriod,
    validityPeriod: cheapest.validityPeriod,
    dataTotal: cheapest.dataTotal,
    dataUnit: cheapest.dataUnit,
  };
}

/**
 * Poll for order credentials with exponential backoff
 */
async function pollForCredentials(
  client: TgtClient,
  orderNo: string,
  maxAttempts = 10,
): Promise<OrderCredentials> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const credentials = await client.tryResolveOrderCredentials(orderNo);
    if (credentials.ready && credentials.lpa) {
      return credentials;
    }

    const delay = Math.min(1000 * Math.pow(1.5, attempt), 10000);
    logger.info({ attempt, maxAttempts, delayMs: delay }, 'Polling for credentials: not ready yet');
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  return { ready: false };
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
  orderNo: string,
  product: CheapestProduct,
  credentials: OrderCredentials,
  outputDir: string,
): Promise<void> {
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Generate QR code file
  const qrFilePath = path.join(outputDir, 'tgt-esim-qr.png');
  await generateQrCode(lpaString, qrFilePath);
  logger.info({ qrFilePath }, 'QR Code generated');

  // Generate QR as data URL for HTML embedding
  const qrDataUrl = await QRCode.toDataURL(lpaString, { width: 400 });

  // Create markdown report
  const testResultMd = createMarkdownReport(lpaString, orderNo, product, credentials);
  const mdFilePath = path.join(outputDir, 'tgt-test-result.md');
  fs.writeFileSync(mdFilePath, testResultMd);
  logger.info({ mdFilePath }, 'Markdown test result saved');

  // Create HTML report
  const htmlContent = createHtmlReport(lpaString, orderNo, product, credentials, qrDataUrl);
  const htmlFilePath = path.join(outputDir, 'tgt-test-result.html');
  fs.writeFileSync(htmlFilePath, htmlContent);
  logger.info({ htmlFilePath }, 'HTML test result saved');
  logger.info('Open tgt-test-result.html in your browser to view the QR code');
}

/**
 * Create markdown report content
 */
function createMarkdownReport(
  lpaString: string,
  orderNo: string,
  product: CheapestProduct,
  credentials: OrderCredentials,
): string {
  return `# TGT eSIM Test Result

**Generated:** ${new Date().toISOString()}

## Order Details
- **Order Number:** ${orderNo}
- **Product Code:** ${product.productCode}
- **Plan:** ${product.display}
- **Price:** $${product.netPrice}
- **Type:** ${product.productType}
- **Usage Period:** ${product.usagePeriod || 'N/A'} ${product.usagePeriod ? 'days' : ''}
- **Validity Period:** ${product.validityPeriod || 'N/A'} ${product.validityPeriod ? 'days' : ''}
- **Data:** ${product.dataTotal || 'Unlimited'} ${product.dataUnit || ''}
- **ICCID:** ${credentials.iccid || 'N/A'}
- **Activation Code:** ${credentials.activationCode || 'N/A'}

## eSIM Installation

### Scan QR Code
![eSIM QR Code](tgt-esim-qr.png)

### Or Manual Entry
\`\`\`
${lpaString}
\`\`\`

### Installation Instructions

#### iOS
1. Go to **Settings** → **Cellular** → **Add eSIM**
2. Choose **Use QR Code** and scan the QR code above
3. Follow the on-screen prompts to activate

#### Android
1. Go to **Settings** → **Network & Internet** → **SIMs** → **Add eSIM**
2. Scan the QR code or enter the activation code manually
3. Follow the on-screen prompts to activate

---
**Provider:** TGT Technology
**Test Type:** Live Integration Test
`;
}

/**
 * Create HTML report content
 */
function createHtmlReport(
  lpaString: string,
  orderNo: string,
  product: CheapestProduct,
  credentials: OrderCredentials,
  qrDataUrl: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TGT eSIM Test Result - ${orderNo}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      max-width: 800px;
      margin: 40px auto;
      padding: 20px;
      line-height: 1.6;
      color: #333;
    }
    h1 {
      color: #2c3e50;
      border-bottom: 3px solid #3498db;
      padding-bottom: 10px;
    }
    h2 {
      color: #34495e;
      margin-top: 30px;
    }
    .info-grid {
      display: grid;
      grid-template-columns: 1fr 2fr;
      gap: 10px;
      background: #f8f9fa;
      padding: 20px;
      border-radius: 8px;
      margin: 20px 0;
    }
    .info-label {
      font-weight: bold;
      color: #555;
    }
    .qr-container {
      text-align: center;
      margin: 30px 0;
      padding: 30px;
      background: white;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
    }
    .qr-container img {
      max-width: 100%;
      height: auto;
    }
    .lpa-code {
      background: #f4f4f4;
      padding: 15px;
      border-left: 4px solid #3498db;
      font-family: 'Courier New', monospace;
      word-break: break-all;
      margin: 20px 0;
    }
    .instructions {
      background: #e8f4f8;
      padding: 20px;
      border-radius: 8px;
      margin: 20px 0;
    }
    .platform {
      margin: 15px 0;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #ddd;
      color: #777;
      font-size: 0.9em;
    }
  </style>
</head>
<body>
  <h1>📱 TGT eSIM Test Result</h1>
  
  <p><strong>Generated:</strong> ${new Date().toISOString()}</p>

  <h2>Order Details</h2>
  <div class="info-grid">
    <div class="info-label">Order Number:</div>
    <div>${orderNo}</div>
    
    <div class="info-label">Product Code:</div>
    <div>${product.productCode}</div>
    
    <div class="info-label">Plan:</div>
    <div>${product.display}</div>
    
    <div class="info-label">Price:</div>
    <div>$${product.netPrice}</div>
    
    <div class="info-label">Type:</div>
    <div>${product.productType}</div>
    
    <div class="info-label">Usage Period:</div>
    <div>${product.usagePeriod || 'N/A'} ${product.usagePeriod ? 'days' : ''}</div>
    
    <div class="info-label">Validity Period:</div>
    <div>${product.validityPeriod || 'N/A'} ${product.validityPeriod ? 'days' : ''}</div>
    
    <div class="info-label">Data:</div>
    <div>${product.dataTotal || 'Unlimited'} ${product.dataUnit || ''}</div>
    
    <div class="info-label">ICCID:</div>
    <div>${credentials.iccid || 'N/A'}</div>
    
    <div class="info-label">Activation Code:</div>
    <div>${credentials.activationCode || 'N/A'}</div>
  </div>

  <h2>eSIM Installation</h2>
  
  <div class="qr-container">
    <h3>Scan This QR Code</h3>
    <img src="${qrDataUrl}" alt="eSIM QR Code" />
  </div>

  <h3>Or Use Manual Entry</h3>
  <div class="lpa-code">${lpaString}</div>

  <div class="instructions">
    <h3>Installation Instructions</h3>
    
    <div class="platform">
      <h4>📱 iOS</h4>
      <ol>
        <li>Go to <strong>Settings</strong> → <strong>Cellular</strong> → <strong>Add eSIM</strong></li>
        <li>Choose <strong>Use QR Code</strong> and scan the QR code above</li>
        <li>Follow the on-screen prompts to activate</li>
      </ol>
    </div>

    <div class="platform">
      <h4>🤖 Android</h4>
      <ol>
        <li>Go to <strong>Settings</strong> → <strong>Network & Internet</strong> → <strong>SIMs</strong> → <strong>Add eSIM</strong></li>
        <li>Scan the QR code or enter the activation code manually</li>
        <li>Follow the on-screen prompts to activate</li>
      </ol>
    </div>
  </div>

  <div class="footer">
    <p><strong>Provider:</strong> TGT Technology</p>
    <p><strong>Test Type:</strong> Live Integration Test</p>
    <p>
      <strong>Note:</strong> TGT does not support order cancellation. This eSIM has been provisioned.
    </p>
  </div>
</body>
</html>`;
}

// ============================================================================
// Skip Helper
// ============================================================================

function skipIfNotEnabled() {
  if (process.env.TGT_INTEGRATION !== 'true') {
    return true;
  }
  return false;
}

// ============================================================================
// Tests
// ============================================================================

describe('TGT API - Live Integration Tests', () => {
  it('should authenticate and fetch products from live API', async () => {
    if (skipIfNotEnabled()) return;

    if (!process.env.TGT_ACCOUNT_ID || !process.env.TGT_SECRET) {
      return;
    }

    const _client = new TgtClient();
    try {
      const result = await _client.listProducts({ pageNum: 1, pageSize: 20, lang: 'en' });
      expect(result.products.length).toBeGreaterThan(0);
    } catch (err) {
      logger.error(
        { err },
        'TGT auth/products call failed. Action needed: ' +
          '(1) Verify TGT_ACCOUNT_ID + TGT_SECRET in .env, ' +
          '(2) Contact TGT FAE to enable API access for this sandbox account, ' +
          '(3) Confirm sandbox URL: https://enterpriseapisandbox.tugegroup.com:8070/openapi',
      );
      throw err;
    }
  });

  it('should complete full e2e order flow with QR generation and test reports', async () => {
    if (skipIfNotEnabled()) return;

    if (process.env.TGT_E2E_ORDERS !== 'true') {
      logger.info('Skipping e2e order test (set TGT_E2E_ORDERS=true to enable)');
      return;
    }

    if (!process.env.TGT_ACCOUNT_ID || !process.env.TGT_SECRET) {
      logger.warn('Missing TGT_ACCOUNT_ID or TGT_SECRET');
      return;
    }

    logger.info('Starting TGT e2e integration test');

    const client = new TgtClient();

    // Step 1: Find cheapest product
    logger.info('Finding cheapest product');
    const product = await findCheapestProduct(client);
    expect(product).toBeDefined();
    logger.info(
      { display: product!.display, netPrice: product!.netPrice },
      'Found cheapest product',
    );

    // Step 2: Place order
    logger.info('Placing order');
    const channelOrderNo = `TGT-E2E-${Date.now()}`;
    const order = await client.createOrder({
      productCode: product!.productCode,
      channelOrderNo,
      idempotencyKey: crypto.randomUUID(),
      email: process.env.TGT_TEST_EMAIL || undefined,
    });
    expect(order.orderNo).toBeTruthy();
    logger.info({ orderNo: order.orderNo }, 'Order placed successfully');

    // Step 3: Poll for credentials (TGT may take time to provision)
    logger.info('Waiting for eSIM provisioning');
    const credentials = await pollForCredentials(client, order.orderNo);
    expect(credentials.ready).toBe(true);
    expect(credentials.lpa).toBeDefined();
    expect(credentials.lpa).toMatch(/^LPA:1\$/);
    logger.info(
      {
        iccid: credentials.iccid || 'N/A',
        activationCode: credentials.activationCode || 'N/A',
      },
      'eSIM provisioned successfully',
    );

    // Step 4: Verify LPA structure
    const lpaParts = credentials.lpa!.split('$');
    expect(lpaParts.length).toBeGreaterThanOrEqual(3);
    logger.info({ parts: lpaParts.length }, 'LPA validated');

    // Step 5: Generate test artifacts
    logger.info('Generating test reports');
    const outputDir = path.join(process.cwd(), 'test-output');
    await generateTestResults(credentials.lpa!, order.orderNo, product!, credentials, outputDir);

    logger.info('Full e2e test completed successfully');
    logger.warn('Note: TGT does not support order cancellation. This eSIM has been provisioned.');
  });
});
