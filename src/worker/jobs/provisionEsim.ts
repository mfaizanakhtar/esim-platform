import prisma from '../../db/prisma';
import { sendDeliveryEmail, recordDeliveryAttempt, type EsimPayload } from '../../services/email';
import { getShopifyClient } from '../../shopify/client';
import { getProvider } from '../../vendor/registry';
import type { EsimProvisionResult } from '../../vendor/types';

interface ProvisionJobData {
  deliveryId: string;
  orderId?: string;
  orderName?: string;
  lineItemId?: string;
  variantId?: string;
  customerEmail?: string;
  sku?: string | null;
  productName?: string;
  /** @deprecated Use SKU mappings via the provider registry instead. */
  orderPayload?: Record<string, unknown>;
}

export async function handleProvision(jobData: Record<string, unknown>) {
  const data = jobData as unknown as ProvisionJobData;
  const deliveryId = String(data.deliveryId || '');
  if (!deliveryId) throw new Error('missing deliveryId');

  const delivery = await prisma.esimDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery) throw new Error(`EsimDelivery ${deliveryId} not found`);

  if (delivery.status === 'delivered') {
    return { ok: true, reason: 'already delivered' };
  }

  await prisma.esimDelivery.update({ where: { id: deliveryId }, data: { status: 'provisioning' } });

  console.log(`[ProvisionJob] Processing delivery ${deliveryId} for order ${delivery.orderName}`);

  try {
    let esimResult: EsimProvisionResult;
    let mappingInfo: {
      name?: string;
      region?: string;
      dataAmount?: string;
      validity?: string;
    } | null = null;

    if (data.orderPayload) {
      // Legacy path: raw vendor payload included directly in job data.
      // Deprecated — prefer SKU mappings with the provider registry.
      console.log('[ProvisionJob] Using legacy direct orderPayload path');
      esimResult = await provisionViaDirectPayload(data.orderPayload);
    } else {
      // Primary path: resolve SKU mapping → dispatch to the correct vendor provider.
      const sku = data.sku;
      if (!sku) throw new Error('Missing SKU in job data');

      const mapping = await prisma.providerSkuMapping.findUnique({ where: { shopifySku: sku } });
      if (!mapping) throw new Error(`No provider mapping found for SKU: ${sku}`);
      if (!mapping.isActive) throw new Error(`SKU mapping is inactive: ${sku}`);

      mappingInfo = {
        name: mapping.name || undefined,
        region: mapping.region || undefined,
        dataAmount: mapping.dataAmount || undefined,
        validity: mapping.validity || undefined,
      };

      console.log(`[ProvisionJob] Using provider: ${mapping.provider}, SKU: ${mapping.providerSku}`);

      const provider = getProvider(mapping.provider);
      esimResult = await provider.provision(
        {
          providerSku: mapping.providerSku,
          providerConfig: mapping.providerConfig as Record<string, unknown> | null,
          packageType: mapping.packageType,
          daysCount: mapping.daysCount,
        },
        {
          customerEmail: delivery.customerEmail ?? '',
          quantity: 1,
        },
      );
    }

    console.log(`[ProvisionJob] eSIM provisioned: ${esimResult.vendorOrderId}`);
    console.log(`[ProvisionJob] LPA: ${esimResult.lpa || 'N/A'}`);
    console.log(`[ProvisionJob] Activation Code: ${esimResult.activationCode || 'N/A'}`);
    console.log(`[ProvisionJob] ICCID: ${esimResult.iccid || 'N/A'}`);

    // Encrypt the canonical payload for at-rest storage
    const crypto = await import('../../utils/crypto');
    const payloadEncrypted = await crypto.encrypt(
      JSON.stringify({
        vendorId: esimResult.vendorOrderId,
        lpa: esimResult.lpa,
        activationCode: esimResult.activationCode,
        iccid: esimResult.iccid,
      }),
    );

    await prisma.esimDelivery.update({
      where: { id: deliveryId },
      data: {
        vendorReferenceId: esimResult.vendorOrderId,
        payloadEncrypted,
        status: 'delivered',
      },
    });

    console.log(`[ProvisionJob] eSIM provisioned successfully: ${esimResult.vendorOrderId}`);

    // Send delivery email with QR code
    if (delivery.customerEmail) {
      console.log(`[ProvisionJob] Sending delivery email to ${delivery.customerEmail}`);

      const esimPayload: EsimPayload = {
        lpa: esimResult.lpa,
        activationCode: esimResult.activationCode,
        iccid: esimResult.iccid,
      };

      const emailResult = await sendDeliveryEmail({
        to: delivery.customerEmail,
        orderNumber: delivery.orderName,
        productName: mappingInfo?.name || data.productName,
        esimPayload,
        region: mappingInfo?.region,
        dataAmount: mappingInfo?.dataAmount,
        validity: mappingInfo?.validity,
      });

      // Record the delivery attempt
      await recordDeliveryAttempt(
        prisma,
        deliveryId,
        'email',
        emailResult.success ? `sent:${emailResult.messageId}` : `failed:${emailResult.error}`,
      );

      if (emailResult.success) {
        console.log(`[ProvisionJob] Delivery email sent: ${emailResult.messageId}`);
      } else {
        console.error(`[ProvisionJob] Email delivery failed: ${emailResult.error}`);
        // Don't throw - eSIM is provisioned, email failure is recoverable
      }
    } else {
      console.warn(`[ProvisionJob] No customer email - skipping delivery email`);
    }

    // Create Shopify fulfillment
    if (data.orderId) {
      try {
        console.log(`[ProvisionJob] Creating Shopify fulfillment for order ${data.orderId}`);

        const shopify = getShopifyClient();
        await shopify.createFulfillment(data.orderId);

        console.log(`[ProvisionJob] Shopify fulfillment created successfully`);
      } catch (fulfillmentError) {
        const fulfillmentMsg =
          fulfillmentError instanceof Error ? fulfillmentError.message : String(fulfillmentError);
        console.error(`[ProvisionJob] Failed to create Shopify fulfillment: ${fulfillmentMsg}`);
        // Don't throw - eSIM is delivered, fulfillment failure is recoverable
      }
    } else {
      console.warn(`[ProvisionJob] Missing orderId - skipping Shopify fulfillment`);
    }

    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ProvisionJob] Failed:`, msg);
    await prisma.esimDelivery.update({
      where: { id: deliveryId },
      data: { lastError: msg, status: 'failed' },
    });
    throw err;
  }
}

/**
 * Legacy path: provision via a raw FiRoam order payload included directly in the job data.
 * @deprecated Use SKU mappings with the provider registry instead.
 */
async function provisionViaDirectPayload(
  orderPayload: Record<string, unknown>,
): Promise<EsimProvisionResult> {
  const { default: FiRoamClient } = await import('../../vendor/firoamClient');
  const fiRoam = new FiRoamClient();
  const result = await fiRoam.addEsimOrder(orderPayload);

  if (!result.canonical || !result.db) {
    const errorMsg = result.error
      ? `FiRoam error: ${String(result.error)}`
      : 'FiRoam returned unexpected response';
    throw new Error(errorMsg);
  }

  const rawData = result.raw.data;
  const vendorOrderId =
    typeof rawData === 'string'
      ? rawData
      : ((rawData as Record<string, unknown>)?.orderNum as string | undefined);

  if (!vendorOrderId) {
    throw new Error('No order number in FiRoam response');
  }

  return {
    vendorOrderId: String(vendorOrderId),
    lpa: result.canonical.lpa ?? '',
    activationCode: result.canonical.activationCode ?? '',
    iccid: result.canonical.iccid ?? '',
  };
}
