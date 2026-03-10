/**
 * Email Service for eSIM Delivery
 * Uses Resend API for email delivery
 */
import { Resend } from 'resend';
import QRCode from 'qrcode';
import PDFDocument from 'pdfkit';
import type { PrismaClient } from '@prisma/client';
import { logger } from '~/utils/logger';
import {
  parseSmdpFromLpa,
  buildEmailHtml,
  buildEmailText,
  type EsimPayload,
  type DeliveryEmailData,
} from '~/services/emailTemplates';

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
