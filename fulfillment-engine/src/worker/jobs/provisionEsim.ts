import prisma from '~/db/prisma';
import { sendDeliveryEmail, recordDeliveryAttempt, type EsimPayload } from '~/services/email';
import { getShopifyClient } from '~/shopify/client';
import { getProvider } from '~/vendor/registry';
import type { EsimProvisionResult } from '~/vendor/types';
import { logger } from '~/utils/logger';
import { JobDataError, MappingError, VendorError } from '~/utils/errors';
import {
  getTgtFulfillmentMode,
  getTgtPollIntervalSeconds,
  getTgtPollMaxAttempts,
} from '~/vendor/tgtConfig';
import { getJobQueue } from '~/queue/jobQueue';

interface ProvisionJobData {
  deliveryId: string;
  requestId?: string;
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

export async function handleProvision(data: ProvisionJobData) {
  const deliveryId = String(data.deliveryId || '');
  if (!deliveryId) throw new JobDataError('missing deliveryId');

  const delivery = await prisma.esimDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery) throw new JobDataError(`EsimDelivery ${deliveryId} not found`);

  if (delivery.status === 'delivered') {
    return { ok: true, reason: 'already delivered' };
  }

  await prisma.esimDelivery.update({ where: { id: deliveryId }, data: { status: 'provisioning' } });

  logger.info(
    { deliveryId, requestId: data.requestId, orderName: delivery.orderName },
    'Processing delivery',
  );

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
      logger.info('Using legacy direct orderPayload path');
      esimResult = await provisionViaDirectPayload(data.orderPayload);
    } else {
      // Primary path: resolve SKU mapping → dispatch to the correct vendor provider.
      const sku = data.sku;
      if (!sku) throw new JobDataError('Missing SKU in job data');

      const mapping = await prisma.providerSkuMapping.findUnique({ where: { shopifySku: sku } });
      if (!mapping) throw new MappingError(`No provider mapping found for SKU: ${sku}`);
      if (!mapping.isActive) throw new MappingError(`SKU mapping is inactive: ${sku}`);

      mappingInfo = {
        name: mapping.name || undefined,
        region: mapping.region || undefined,
        dataAmount: mapping.dataAmount || undefined,
        validity: mapping.validity || undefined,
      };

      logger.info({ provider: mapping.provider, sku: mapping.providerSku }, 'Using provider');

      const provider = getProvider(mapping.provider);
      esimResult = await provider.provision(
        {
          providerSku: mapping.providerSku,
          providerCatalogId: mapping.providerCatalogId,
          providerConfig: mapping.providerConfig as Record<string, unknown> | null,
          packageType: mapping.packageType,
          daysCount: mapping.daysCount,
        },
        {
          customerEmail: delivery.customerEmail ?? '',
          quantity: 1,
          deliveryId,
        },
      );
    }

    if (esimResult.pending) {
      const mode = getTgtFulfillmentMode();
      const status =
        mode === 'callback'
          ? 'awaiting_callback'
          : mode === 'polling'
            ? 'polling'
            : 'vendor_ordered';

      await prisma.esimDelivery.update({
        where: { id: deliveryId },
        data: {
          vendorReferenceId: esimResult.vendorOrderId,
          status,
          lastError: null,
        },
      });

      if (mode === 'hybrid') {
        const queue = getJobQueue();
        await queue.send(
          'tgt-poll-order',
          {
            deliveryId,
            orderNo: esimResult.vendorOrderId,
            attempt: 1,
            maxAttempts: getTgtPollMaxAttempts(),
            mode,
          },
          {
            startAfter: getTgtPollIntervalSeconds(),
          },
        );
      }

      logger.info(
        { deliveryId, vendorOrderId: esimResult.vendorOrderId, mode },
        'TGT order accepted and waiting for credentials',
      );
      return { ok: true, pending: true };
    }

    logger.info(
      {
        vendorOrderId: esimResult.vendorOrderId,
        lpa: esimResult.lpa,
        activationCode: esimResult.activationCode,
        iccid: esimResult.iccid,
      },
      'eSIM provisioned',
    );

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

    // Send delivery email with QR code
    if (delivery.customerEmail) {
      logger.info({ to: delivery.customerEmail }, 'Sending delivery email');

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

      await recordDeliveryAttempt(
        prisma,
        deliveryId,
        'email',
        emailResult.success ? `sent:${emailResult.messageId}` : `failed:${emailResult.error}`,
      );
    }

    // Create Shopify fulfillment
    if (data.orderId) {
      try {
        const shopify = getShopifyClient();
        await shopify.createFulfillment(data.orderId);
      } catch (fulfillmentError) {
        const fulfillmentMsg =
          fulfillmentError instanceof Error ? fulfillmentError.message : String(fulfillmentError);
        logger.error({ error: fulfillmentMsg }, 'Failed to create Shopify fulfillment');
      }
    }

    logger.info({ vendorOrderId: esimResult.vendorOrderId }, 'eSIM provisioned successfully');

    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'Provision failed');
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
    throw new VendorError(errorMsg);
  }

  const rawData = result.raw.data;
  const vendorOrderId =
    typeof rawData === 'string'
      ? rawData
      : ((rawData as Record<string, unknown>)?.orderNum as string | undefined);

  if (!vendorOrderId) {
    throw new VendorError('No order number in FiRoam response');
  }

  return {
    vendorOrderId: String(vendorOrderId),
    lpa: result.canonical.lpa ?? '',
    activationCode: result.canonical.activationCode ?? '',
    iccid: result.canonical.iccid ?? '',
  };
}
