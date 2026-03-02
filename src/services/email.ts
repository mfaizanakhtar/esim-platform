/**
 * Email Service for eSIM Delivery
 * Uses Resend API for email delivery
 */
import { Resend } from 'resend';
import QRCode from 'qrcode';
import PDFDocument from 'pdfkit';
import type { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';
// Types and parseSmdpFromLpa live in emailTemplates.ts — import them from there
// so that callers who import types directly from emailTemplates.ts stay in sync.
// buildEmailHtml/buildEmailText local copies below are identical to emailTemplates.ts;
// they will be removed in a follow-up cleanup once the duplicate is no longer needed.
import { parseSmdpFromLpa, type EsimPayload, type DeliveryEmailData } from './emailTemplates';

// Re-export shared types so existing callers (`import ... from './email'`) keep working.
export type { EsimPayload, DeliveryEmailData };

/**
 * Generate QR code as base64 string for CID attachment
 */
async function generateQRCodeBase64(lpa: string): Promise<string> {
  const buffer = await QRCode.toBuffer(lpa, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 300,
    color: {
      dark: '#000000',
      light: '#FFFFFF',
    },
  });

  return buffer.toString('base64');
}

/**
 * Generate PDF with eSIM details and QR code
 */
async function generateEsimPDF(data: DeliveryEmailData): Promise<string> {
  const { orderNumber, productName, esimPayload, region, dataAmount, validity } = data;
  const productTitle = productName || 'Your eSIM';
  const smdpAddress = parseSmdpFromLpa(esimPayload.lpa);

  // Generate QR code as buffer
  const qrCodeBuffer = await QRCode.toBuffer(esimPayload.lpa, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 300,
    color: {
      dark: '#000000',
      light: '#FFFFFF',
    },
  });

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(chunks);
        resolve(pdfBuffer.toString('base64'));
      });
      doc.on('error', reject);

      // Header with gradient-like effect using rectangles
      doc.rect(0, 0, doc.page.width, 120).fill('#667eea');

      // Title
      doc
        .fillColor('#FFFFFF')
        .fontSize(28)
        .font('Helvetica-Bold')
        .text('Your eSIM is Ready!', 50, 40, {
          align: 'center',
        });

      doc.fontSize(14).font('Helvetica').text(`Order ${orderNumber}`, 50, 75, {
        align: 'center',
      });

      // Reset position
      let yPos = 150;

      // Product details
      doc.fillColor('#333333').fontSize(16).font('Helvetica-Bold').text(productTitle, 50, yPos);
      yPos += 30;

      // eSIM Details box
      if (region || dataAmount || validity) {
        doc.fontSize(14).font('Helvetica-Bold').text('eSIM Details', 50, yPos);
        yPos += 25;

        doc.fontSize(11).font('Helvetica');
        if (region) {
          doc.text(`Region: ${region}`, 70, yPos);
          yPos += 20;
        }
        if (dataAmount) {
          doc.text(`Data: ${dataAmount}`, 70, yPos);
          yPos += 20;
        }
        if (validity) {
          doc.text(`Validity: ${validity}`, 70, yPos);
          yPos += 30;
        }
      }

      // Add page break if needed
      if (yPos > 650) {
        doc.addPage();
        yPos = 50;
      }

      // Important Notes - BEFORE installation
      doc
        .fontSize(14)
        .font('Helvetica-Bold')
        .fillColor('#c53030')
        .text('READ BEFORE INSTALLING', 50, yPos);
      yPos += 18;
      doc.fontSize(10).font('Helvetica').fillColor('#333333');

      const importantNotes = [
        '• Install BEFORE you travel - you need WiFi to install',
        '• Each QR code can only be installed ONCE - keep this document safe',
        '• After installing, keep the eSIM turned OFF until you arrive',
        '• Only turn it on and enable Data Roaming when you reach your destination',
        "• Don't delete the eSIM profile - it cannot be reinstalled",
      ];

      importantNotes.forEach((note) => {
        doc.text(note, 70, yPos);
        yPos += 14;
      });

      yPos += 20;

      // iPhone Quick Install Button
      doc
        .fontSize(11)
        .font('Helvetica-Bold')
        .fillColor('#667eea')
        .text('iPhone Quick Install:', 50, yPos);
      yPos += 15;

      const iphoneInstallUrl = `https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(esimPayload.lpa)}`;

      // Create a clickable button-like link
      doc
        .fontSize(12)
        .font('Helvetica-Bold')
        .fillColor('#FFFFFF')
        .rect(50, yPos, 200, 35)
        .fillAndStroke('#667eea', '#667eea');

      doc.fillColor('#FFFFFF').text('Click to Install on iPhone', 50, yPos + 10, {
        width: 200,
        align: 'center',
        link: iphoneInstallUrl,
        underline: false,
      });

      yPos += 40;

      doc
        .fontSize(8)
        .font('Helvetica')
        .fillColor('#666666')
        .text('(Opens directly in iPhone settings when clicked)', 50, yPos, {
          width: 500,
        });
      yPos += 25;

      // QR Code section
      doc
        .fontSize(16)
        .font('Helvetica-Bold')
        .fillColor('#667eea')
        .text('Scan to Install', 50, yPos);
      yPos += 25;

      // Add QR code image
      doc.image(qrCodeBuffer, 50, yPos, { width: 220, height: 220 });
      yPos += 235;

      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#666666')
        .text('Scan this QR code in Settings → Add eSIM', 50, yPos, {
          width: 500,
          align: 'center',
        });
      yPos += 20;

      // Check if we need a new page for manual installation section (needs ~150px)
      if (yPos > 650) {
        doc.addPage();
        yPos = 50;
      }

      // Manual Installation Details
      doc
        .fontSize(12)
        .font('Helvetica-Bold')
        .fillColor('#333333')
        .text('Manual Installation (if QR scan fails)', 50, yPos);
      yPos += 18;

      doc.fontSize(9).font('Helvetica-Bold').fillColor('#333333').text('SM-DP+ Address:', 50, yPos);
      yPos += 12;
      doc.fontSize(8).font('Courier').fillColor('#2d3748').text(smdpAddress, 50, yPos);
      yPos += 14;

      doc
        .fontSize(9)
        .font('Helvetica-Bold')
        .fillColor('#333333')
        .text('Activation Code:', 50, yPos);
      yPos += 12;
      doc
        .fontSize(8)
        .font('Courier')
        .fillColor('#2d3748')
        .text(esimPayload.activationCode, 50, yPos);
      yPos += 14;

      doc.fontSize(9).font('Helvetica-Bold').fillColor('#333333').text('ICCID:', 50, yPos);
      yPos += 12;
      doc.fontSize(8).font('Courier').fillColor('#2d3748').text(esimPayload.iccid, 50, yPos);
      yPos += 20;

      // Add new page for instructions if needed
      if (yPos > 650) {
        doc.addPage();
        yPos = 50;
      }

      // Installation Instructions
      doc
        .fontSize(14)
        .font('Helvetica-Bold')
        .fillColor('#333333')
        .text('Installation Instructions', 50, yPos);
      yPos += 20;

      // iPhone
      doc
        .fontSize(12)
        .font('Helvetica-Bold')
        .fillColor('#667eea')
        .text('iPhone (iOS 17.4+)', 50, yPos);
      yPos += 18;
      doc.fontSize(10).font('Helvetica').fillColor('#333333');

      const iPhoneSteps = [
        "1. Make sure you're connected to WiFi",
        '2. Go to Settings → Cellular → Add eSIM',
        '3. Tap "Use QR Code" and scan the code above',
        '4. Follow prompts to complete installation',
        '5. Keep the eSIM turned OFF until you arrive at your destination',
      ];

      iPhoneSteps.forEach((step) => {
        doc.text(step, 70, yPos);
        yPos += 14;
      });

      yPos += 10;

      // Android
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#667eea').text('Android', 50, yPos);
      yPos += 18;
      doc.fontSize(10).font('Helvetica').fillColor('#333333');

      const androidSteps = [
        "1. Make sure you're connected to WiFi",
        '2. Go to Settings → Network & Internet → SIMs',
        '3. Tap "Add eSIM" or "Download a SIM instead?"',
        '4. Choose "Scan QR code" and scan the code above',
        '5. Keep the eSIM turned OFF until you arrive',
      ];

      androidSteps.forEach((step) => {
        doc.text(step, 70, yPos);
        yPos += 14;
      });

      yPos += 15;

      // Activation Instructions
      doc
        .fontSize(14)
        .font('Helvetica-Bold')
        .fillColor('#f59e0b')
        .text('How to Activate (When You Arrive)', 50, yPos);
      yPos += 18;
      doc.fontSize(10).font('Helvetica').fillColor('#333333');

      const activationSteps = [
        '1. When you arrive at your destination, go to Settings → Cellular/Mobile',
        '2. Select your eSIM and turn it on',
        '3. Enable Data Roaming for the eSIM',
        '4. If no connection, toggle Airplane Mode on/off or restart your phone',
      ];

      activationSteps.forEach((step) => {
        doc.text(step, 70, yPos);
        yPos += 14;
      });

      yPos += 15;

      // Usage Tracking Section - AFTER activation
      doc
        .fontSize(14)
        .font('Helvetica-Bold')
        .fillColor('#1a1f71')
        .text('After Activation: Monitor Your Data', 50, yPos);
      yPos += 18;
      doc.fontSize(10).font('Helvetica').fillColor('#333333');
      doc.text('Once your eSIM is active, track your data usage in real-time:', 50, yPos);
      yPos += 13;
      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#1a1f71')
        .text(`https://fluxyfi.com/pages/my-esim-usage?iccid=${esimPayload.iccid}`, 50, yPos, {
          link: `https://fluxyfi.com/pages/my-esim-usage?iccid=${esimPayload.iccid}`,
          underline: true,
        });
      yPos += 13;
      doc.fontSize(9).font('Helvetica').fillColor('#666666');
      doc.text('Check remaining data, usage history, and validity period', 50, yPos);
      yPos += 15;

      // Add new page if needed
      if (yPos > 650) {
        doc.addPage();
        yPos = 50;
      }

      // Footer
      doc
        .fontSize(8)
        .fillColor('#666666')
        .text(`Generated: ${new Date().toLocaleString()}`, 50, yPos, {
          align: 'center',
        });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Build HTML email content for eSIM delivery
 * Uses CID reference for QR code image (Gmail-compatible)
 */
function buildEmailHtml(data: DeliveryEmailData): string {
  const { orderNumber, productName, esimPayload, region, dataAmount, validity } = data;

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
              <td valign="top" style="padding: 8px 0;">Go to <strong>Settings → Network & Internet → SIMs</strong></td>
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
              <a href="https://fluxyfi.com/pages/my-esim-usage?iccid=${esimPayload.iccid}" target="_blank" style="color: #ffffff; text-decoration: none; font-weight: bold; font-size: 16px; display: inline-block;">
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
      <p>© ${new Date().getFullYear()} Fluxify. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Build plain text email content for eSIM delivery
 */
function buildEmailText(data: DeliveryEmailData): string {
  const { orderNumber, productName, esimPayload, region, dataAmount, validity } = data;
  const productTitle = productName || 'Your eSIM';
  const smdpAddress = parseSmdpFromLpa(esimPayload.lpa);

  return `
🎉 Your eSIM is Ready!
Order ${orderNumber}

Thank you for your purchase! Your ${productTitle} eSIM is ready to install.

📱 eSIM DETAILS
${region ? `Region: ${region}` : ''}
${dataAmount ? `Data: ${dataAmount}` : ''}
${validity ? `Validity: ${validity}` : ''}

� TRACK YOUR DATA USAGE
Monitor your eSIM data usage in real-time:
https://fluxyfi.com/pages/my-esim-usage?iccid=${esimPayload.iccid}

Check your remaining data, usage history, and validity period.

�📲 INSTALLATION
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

© ${new Date().getFullYear()} Fluxify
`;
}

/**
 * Send eSIM delivery email with QR code
 */
export async function sendDeliveryEmail(
  data: DeliveryEmailData,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const { to, orderNumber, esimPayload } = data;

  logger.info({ orderNumber, to }, 'Preparing delivery email');

  try {
    // Generate QR code as base64 string for CID attachment
    logger.debug({ lpa: esimPayload.lpa.substring(0, 20) }, 'Generating QR code');
    const qrCodeBase64 = await generateQRCodeBase64(esimPayload.lpa);
    logger.debug('QR code generated as base64');

    // Generate PDF with eSIM details
    logger.debug('Generating PDF document');
    const pdfBase64 = await generateEsimPDF(data);
    logger.debug('PDF generated successfully');

    // Build email content
    logger.debug('Building email HTML');
    const htmlBody = buildEmailHtml(data);
    logger.debug('Building email text');
    const textBody = buildEmailText(data);
    logger.debug('Email content built');

    const fromEmail = process.env.EMAIL_FROM || 'orders@fluxyfi.com';
    const bccEmail = process.env.EMAIL_BCC;
    const resendApiKey = process.env.RESEND_API_KEY;

    if (!resendApiKey) {
      throw new Error('RESEND_API_KEY is not configured');
    }

    logger.debug('Using Resend API for delivery');
    const resend = new Resend(resendApiKey);

    const result = await resend.emails.send({
      from: fromEmail,
      to: to,
      bcc: bccEmail,
      subject: `Your eSIM is Ready! - Order ${orderNumber}`,
      html: htmlBody,
      text: textBody,
      attachments: [
        {
          filename: 'qrcode.png',
          content: qrCodeBase64,
          contentId: 'qrcode',
        },
        {
          filename: `eSIM-${orderNumber}.pdf`,
          content: pdfBase64,
        },
      ],
    });

    if (result.error) {
      throw new Error(`Resend error: ${result.error.message}`);
    }

    logger.info({ messageId: result.data?.id }, 'Email sent via Resend');
    return {
      success: true,
      messageId: result.data?.id,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, errorMsg }, 'Failed to send email');

    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Record email delivery attempt in database
 */
export async function recordDeliveryAttempt(
  prisma: PrismaClient,
  deliveryId: string,
  channel: 'email',
  result: string,
): Promise<void> {
  await prisma.deliveryAttempt.create({
    data: {
      deliveryId,
      channel,
      result,
    },
  });
}
