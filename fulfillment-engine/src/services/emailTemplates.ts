/**
 * eSIM delivery email templates.
 *
 * Extracted from email.ts so that HTML/text template logic lives in its own
 * module and the core email service stays focused on orchestration (QR, PDF,
 * send).  Import `buildEmailHtml` and `buildEmailText` from here; all shared
 * types are re-exported so callers can import everything from one place.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface EsimPayload {
  lpa: string;
  activationCode: string;
  iccid: string;
}

export interface DeliveryEmailData {
  to: string;
  orderNumber: string;
  productName?: string;
  esimPayload: EsimPayload;
  region?: string;
  dataAmount?: string;
  validity?: string;
  usageUrl?: string;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Parse SM-DP+ address from LPA string.
 * LPA format: `LPA:1$<smdp_address>$<activation_code>`
 */
export function parseSmdpFromLpa(lpa: string): string {
  const parts = lpa.split('$');
  if (parts.length >= 2) {
    return parts[1];
  }
  return 'smdp.io';
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

/**
 * Build HTML email content for eSIM delivery.
 * Uses a CID reference for the QR code image (Gmail-compatible inline image).
 */
export function buildEmailHtml(data: DeliveryEmailData): string {
  const { orderNumber, productName, esimPayload, region, dataAmount, validity, usageUrl } = data;
  const resolvedUsageUrl =
    usageUrl ?? `https://sailesim.com/pages/my-esim-usage?iccid=${esimPayload.iccid}`;

  const smdpAddress = parseSmdpFromLpa(esimPayload.lpa);
  const productTitle = productName || 'Your eSIM';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your eSIM is Ready!</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f5f5f5; }
    .container { max-width: 600px; margin: 0 auto; background: white; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; }
    .content { padding: 5px 30px; }
    .qr-section { text-align: center; background: #f8f9fa; padding: 30px; border-radius: 12px; margin: 20px 0; }
    .qr-code { max-width: 250px; margin: 20px auto; }
    .qr-code img { width: 100%; height: auto; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
    .details-box { background: #e8f4f8; padding: 20px; border-radius: 8px; margin: 20px 0; }
    .details-box h3 { margin-top: 0; color: #2c5282; }
    .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #d1e3ed; }
    .detail-row:last-child { border-bottom: none; }
    .detail-label { font-weight: 600; color: #4a5568; }
    .detail-value { color: #2d3748; font-family: monospace; word-break: break-all; }
    .instructions { margin: 30px 0; }
    .instructions h2 { color: #2c5282; border-bottom: 2px solid #667eea; padding-bottom: 10px; }
    .platform { background: #f7fafc; padding: 20px; border-radius: 8px; margin: 15px 0; border-left: 4px solid #667eea; }
    .platform h4 { margin: 0 0 10px 0; color: #4a5568; }
    .manual-codes { background: #fff3cd; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #ffc107; }
    .manual-codes h3 { margin-top: 0; color: #856404; }
    .code-box { background: white; padding: 12px; border-radius: 4px; font-family: monospace; font-size: 14px; word-break: break-all; margin: 10px 0; border: 1px solid #e2e8f0; }
    .footer { background: #2d3748; color: #a0aec0; padding: 20px; text-align: center; font-size: 12px; }
    .footer a { color: #90cdf4; }
    .warning { background: #fed7d7; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #fc8181; }
    .warning strong { color: #c53030; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Your eSIM is Ready!</h1>
      <p>Order ${orderNumber}</p>
    </div>
    
    <div class="content">
      <p>Thank you for your purchase! Your <strong>${productTitle}</strong> eSIM is ready to install.</p>
      
      ${
        region || dataAmount || validity
          ? `
      <div class="details-box">
        <h3>📱 eSIM Details</h3>
        <table border="0" cellpadding="0" cellspacing="0" width="100%">
          ${region ? `<tr><td style="font-weight: 600; color: #4a5568; padding: 8px 0; border-bottom: 1px solid #d1e3ed;">Region</td><td style="color: #2d3748; padding: 8px 0; border-bottom: 1px solid #d1e3ed; text-align: right;">${region}</td></tr>` : ''}
          ${dataAmount ? `<tr><td style="font-weight: 600; color: #4a5568; padding: 8px 0; border-bottom: 1px solid #d1e3ed;">Data</td><td style="color: #2d3748; padding: 8px 0; border-bottom: 1px solid #d1e3ed; text-align: right;">${dataAmount}</td></tr>` : ''}
          ${validity ? `<tr><td style="font-weight: 600; color: #4a5568; padding: 8px 0;">Validity</td><td style="color: #2d3748; padding: 8px 0; text-align: right;">${validity}</td></tr>` : ''}
        </table>
      </div>
      `
          : ''
      }

      <div class="warning">
        <strong>⚠️ Read This Before Installing:</strong>
        <ul>
          <li><strong>Install BEFORE you travel</strong> - you need WiFi to install</li>
          <li>Each QR code can only be installed <strong>once</strong> - keep this email safe</li>
          <li>After installing, keep the eSIM <strong>turned off</strong> until you reach your destination</li>
          <li>Only turn it on and enable <strong>Data Roaming</strong> when you arrive</li>
          <li>Don't delete the eSIM profile - it cannot be reinstalled</li>
        </ul>
      </div>

      <div class="qr-section">
        <h2>📲 Install Your eSIM</h2>
        <p style="margin-bottom: 20px;">
          <!-- Button for iPhone users -->
          <table border="0" cellpadding="0" cellspacing="0" style="margin: 0 auto;">
            <tr>
              <td align="center" bgcolor="#667eea" style="border-radius: 8px; padding: 16px 32px;">
                <a href="https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(esimPayload.lpa)}" target="_blank" style="color: #ffffff; text-decoration: none; font-weight: bold; font-size: 16px; display: inline-block;">
                  📱 Install on iPhone
                </a>
              </td>
            </tr>
          </table>
        </p>
        <p style="color: #666; font-size: 14px; margin-bottom: 20px;">
          <em>iPhone users: tap the button above for instant installation</em><br/>
          <em>Android users: scan the QR code below in your Settings app</em>
        </p>
        <div class="qr-code">
          <img src="cid:qrcode" alt="eSIM QR Code" />
        </div>
        <p style="margin-top: 20px; font-size: 12px; color: #888;">
          Keep this QR code safe - you may need it to reinstall your eSIM.
        </p>
      </div>

      <div class="instructions">
        <h2>📖 How to Install</h2>
        
        <div class="platform">
          <h4>🍎 iPhone (iOS 17.4+)</h4>
          <table border="0" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td width="40" valign="top" style="padding: 8px 0;"><div style="background: #667eea; color: white; width: 24px; height: 24px; border-radius: 50%; text-align: center; line-height: 24px; font-weight: bold; font-size: 14px;">1</div></td>
              <td valign="top" style="padding: 8px 0;">Make sure you're connected to <strong>WiFi</strong></td>
            </tr>
            <tr>
              <td width="40" valign="top" style="padding: 8px 0;"><div style="background: #667eea; color: white; width: 24px; height: 24px; border-radius: 50%; text-align: center; line-height: 24px; font-weight: bold; font-size: 14px;">2</div></td>
              <td valign="top" style="padding: 8px 0;">Tap the <strong>"Install on iPhone"</strong> button above (easiest method)</td>
            </tr>
            <tr>
              <td width="40" valign="top" style="padding: 8px 0;"><div style="background: #667eea; color: white; width: 24px; height: 24px; border-radius: 50%; text-align: center; line-height: 24px; font-weight: bold; font-size: 14px;">3</div></td>
              <td valign="top" style="padding: 8px 0;"><em>OR</em> Go to <strong>Settings → Cellular → Add eSIM</strong> and scan the QR code</td>
            </tr>
            <tr>
              <td width="40" valign="top" style="padding: 8px 0;"><div style="background: #667eea; color: white; width: 24px; height: 24px; border-radius: 50%; text-align: center; line-height: 24px; font-weight: bold; font-size: 14px;">4</div></td>
              <td valign="top" style="padding: 8px 0;">After installation, keep the eSIM <strong>turned off</strong> until you arrive at your destination</td>
            </tr>
          </table>
        </div>

        <div class="platform">
          <h4>🤖 Android</h4>
          <table border="0" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td width="40" valign="top" style="padding: 8px 0;"><div style="background: #667eea; color: white; width: 24px; height: 24px; border-radius: 50%; text-align: center; line-height: 24px; font-weight: bold; font-size: 14px;">1</div></td>
              <td valign="top" style="padding: 8px 0;">Make sure you're connected to <strong>WiFi</strong></td>
            </tr>
            <tr>
              <td width="40" valign="top" style="padding: 8px 0;"><div style="background: #667eea; color: white; width: 24px; height: 24px; border-radius: 50%; text-align: center; line-height: 24px; font-weight: bold; font-size: 14px;">2</div></td>
              <td valign="top" style="padding: 8px 0;">Go to <strong>Settings → Network &amp; Internet → SIMs</strong></td>
            </tr>
            <tr>
              <td width="40" valign="top" style="padding: 8px 0;"><div style="background: #667eea; color: white; width: 24px; height: 24px; border-radius: 50%; text-align: center; line-height: 24px; font-weight: bold; font-size: 14px;">3</div></td>
              <td valign="top" style="padding: 8px 0;">Tap <strong>Add eSIM</strong> or <strong>Download a SIM instead?</strong></td>
            </tr>
            <tr>
              <td width="40" valign="top" style="padding: 8px 0;"><div style="background: #667eea; color: white; width: 24px; height: 24px; border-radius: 50%; text-align: center; line-height: 24px; font-weight: bold; font-size: 14px;">4</div></td>
              <td valign="top" style="padding: 8px 0;">Choose <strong>Scan QR code</strong> and scan the code above</td>
            </tr>
            <tr>
              <td width="40" valign="top" style="padding: 8px 0;"><div style="background: #667eea; color: white; width: 24px; height: 24px; border-radius: 50%; text-align: center; line-height: 24px; font-weight: bold; font-size: 14px;">5</div></td>
              <td valign="top" style="padding: 8px 0;">After installation, keep the eSIM <strong>turned off</strong> until you arrive</td>
            </tr>
          </table>
        </div>
      </div>
      
      <div class="platform" style="background: #fffbeb; border-left-color: #f59e0b; margin-top: 20px;">
        <h4 style="color: #92400e;">🔌 How to Activate</h4>
        <table border="0" cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td width="40" valign="top" style="padding: 8px 0;"><div style="background: #f59e0b; color: white; width: 24px; height: 24px; border-radius: 50%; text-align: center; line-height: 24px; font-weight: bold; font-size: 14px;">1</div></td>
            <td valign="top" style="padding: 8px 0;">When you arrive at your destination, go to <strong>Settings → Cellular/Mobile</strong></td>
          </tr>
          <tr>
            <td width="40" valign="top" style="padding: 8px 0;"><div style="background: #f59e0b; color: white; width: 24px; height: 24px; border-radius: 50%; text-align: center; line-height: 24px; font-weight: bold; font-size: 14px;">2</div></td>
            <td valign="top" style="padding: 8px 0;">Select your eSIM and <strong>turn it on</strong></td>
          </tr>
          <tr>
            <td width="40" valign="top" style="padding: 8px 0;"><div style="background: #f59e0b; color: white; width: 24px; height: 24px; border-radius: 50%; text-align: center; line-height: 24px; font-weight: bold; font-size: 14px;">3</div></td>
            <td valign="top" style="padding: 8px 0;">Enable <strong>Data Roaming</strong> for the eSIM</td>
          </tr>
          <tr>
            <td width="40" valign="top" style="padding: 8px 0;"><div style="background: #f59e0b; color: white; width: 24px; height: 24px; border-radius: 50%; text-align: center; line-height: 24px; font-weight: bold; font-size: 14px;">4</div></td>
            <td valign="top" style="padding: 8px 0;">If no connection appears, toggle <strong>Airplane Mode</strong> on/off or restart your phone</td>
          </tr>
        </table>
      </div>

      <div style="background: linear-gradient(135deg, #e0f2fe 0%, #dbeafe 100%); padding: 25px; border-radius: 12px; margin: 25px 0; border: 2px solid #3b82f6;">
        <h2 style="color: #1e40af; margin: 0 0 15px 0; font-size: 20px;">📊 After Activation: Monitor Your Data</h2>
        <p style="color: #1e3a8a; margin: 0 0 20px 0; font-size: 15px;">Once your eSIM is active, track your data usage in real-time and check remaining balance.</p>
        <table border="0" cellpadding="0" cellspacing="0" style="margin: 0 auto;">
          <tr>
            <td align="center" bgcolor="#3b82f6" style="border-radius: 8px; padding: 14px 28px; box-shadow: 0 4px 6px rgba(59, 130, 246, 0.3);">
              <a href="${resolvedUsageUrl}" target="_blank" style="color: #ffffff; text-decoration: none; font-weight: bold; font-size: 16px; display: inline-block;">
                📈 View My Usage Dashboard
              </a>
            </td>
          </tr>
        </table>
        <p style="color: #64748b; margin: 15px 0 0 0; font-size: 13px; text-align: center;">
          <em>Check your remaining data, usage history, and validity period</em>
        </p>
      </div>

      <div class="manual-codes">
        <h3>⌨️ Manual Installation (if QR scan doesn't work)</h3>
        <p>Enter these details manually in your eSIM settings:</p>
        <p><strong>SM-DP+ Address:</strong></p>
        <div class="code-box">${smdpAddress}</div>
        <p><strong>Activation Code:</strong></p>
        <div class="code-box">${esimPayload.activationCode}</div>
        <p><strong>ICCID:</strong></p>
        <div class="code-box">${esimPayload.iccid}</div>
      </div>
    </div>
    
    <div class="footer">
      <p>Need help? Reply to this email or contact our support team.</p>
      <p>© ${new Date().getFullYear()} SaileSIM. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Plain-text template
// ---------------------------------------------------------------------------

/**
 * Build plain-text email content for eSIM delivery.
 * Used as the fallback for email clients that don't render HTML.
 */
export function buildEmailText(data: DeliveryEmailData): string {
  const { orderNumber, productName, esimPayload, region, dataAmount, validity, usageUrl } = data;
  const productTitle = productName || 'Your eSIM';
  const smdpAddress = parseSmdpFromLpa(esimPayload.lpa);
  const resolvedUsageUrl =
    usageUrl ?? `https://sailesim.com/pages/my-esim-usage?iccid=${esimPayload.iccid}`;

  return `
🎉 Your eSIM is Ready!
Order ${orderNumber}

Thank you for your purchase! Your ${productTitle} eSIM is ready to install.

📱 eSIM DETAILS
${region ? `Region: ${region}` : ''}
${dataAmount ? `Data: ${dataAmount}` : ''}
${validity ? `Validity: ${validity}` : ''}

📊 TRACK YOUR DATA USAGE
Monitor your eSIM data usage in real-time:
${resolvedUsageUrl}

Check your remaining data, usage history, and validity period.

📲 INSTALLATION
Scan the QR code attached to this email, or use the manual details below.

⌨️ MANUAL INSTALLATION
SM-DP+ Address: ${smdpAddress}
Activation Code: ${esimPayload.activationCode}
ICCID: ${esimPayload.iccid}

📖 INSTRUCTIONS

iPhone (iOS 17.4+):
1. Go to Settings → Cellular → Add eSIM
2. Tap "Use QR Code" and scan
3. Follow prompts to complete installation
4. Enable when you arrive at destination

Android:
1. Go to Settings → Network & Internet → SIMs → Add eSIM
2. Choose "Scan QR code"
3. Scan and confirm installation
4. Enable when ready to use

⚠️ IMPORTANT
- Install BEFORE you travel (requires internet)
- Each eSIM can only be installed ONCE
- Don't delete after installation
- Turn on the eSIM when you arrive

Need help? Reply to this email.

© ${new Date().getFullYear()} SaileSIM
`;
}
