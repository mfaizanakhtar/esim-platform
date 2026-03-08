import prisma from '~/db/prisma';
import { decrypt, encrypt } from '~/utils/crypto';
import { sendDeliveryEmail, recordDeliveryAttempt, type EsimPayload } from '~/services/email';
import { getShopifyClient } from '~/shopify/client';
import { logger } from '~/utils/logger';

export interface DeliveryMetadata {
  productName?: string;
  region?: string;
  dataAmount?: string;
  validity?: string;
}

interface FinalizeArgs {
  deliveryId: string;
  vendorOrderId: string;
  lpa: string;
  activationCode: string;
  iccid: string;
  metadata?: DeliveryMetadata;
}

/**
 * Idempotent finalization path used by initial provision, poll retries and vendor callbacks.
 */
export async function finalizeDelivery(
  args: FinalizeArgs,
): Promise<{ ok: true; alreadyDone?: boolean }> {
  const payload: EsimPayload = {
    lpa: args.lpa,
    activationCode: args.activationCode,
    iccid: args.iccid,
  };

  const payloadEncrypted = await encrypt(
    JSON.stringify({
      vendorId: args.vendorOrderId,
      lpa: args.lpa,
      activationCode: args.activationCode,
      iccid: args.iccid,
    }),
  );

  // First-wins write: whoever flips to delivered runs side effects.
  const writeResult = await prisma.esimDelivery.updateMany({
    where: {
      id: args.deliveryId,
      status: {
        not: 'delivered',
      },
    },
    data: {
      vendorReferenceId: args.vendorOrderId,
      payloadEncrypted,
      status: 'delivered',
      lastError: null,
    },
  });

  if (writeResult.count === 0) {
    return { ok: true, alreadyDone: true };
  }

  const delivery = await prisma.esimDelivery.findUnique({ where: { id: args.deliveryId } });
  if (!delivery) {
    logger.warn({ deliveryId: args.deliveryId }, 'Delivery missing after finalize write');
    return { ok: true };
  }

  if (delivery.customerEmail) {
    const emailResult = await sendDeliveryEmail({
      to: delivery.customerEmail,
      orderNumber: delivery.orderName,
      productName: args.metadata?.productName,
      esimPayload: payload,
      region: args.metadata?.region,
      dataAmount: args.metadata?.dataAmount,
      validity: args.metadata?.validity,
    });

    await recordDeliveryAttempt(
      prisma,
      args.deliveryId,
      'email',
      emailResult.success ? `sent:${emailResult.messageId}` : `failed:${emailResult.error}`,
    );

    if (!emailResult.success) {
      logger.error(
        { deliveryId: args.deliveryId, error: emailResult.error },
        'Failed to send delivery email during finalize',
      );
    }
  }

  if (delivery.orderId) {
    try {
      const shopify = getShopifyClient();
      await shopify.createFulfillment(delivery.orderId);
    } catch (error) {
      logger.error(
        { deliveryId: args.deliveryId, err: error },
        'Failed to create Shopify fulfillment during finalize',
      );
    }
  }

  return { ok: true };
}

export async function getDecryptedEsimPayload(deliveryId: string): Promise<EsimPayload | null> {
  const delivery = await prisma.esimDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery?.payloadEncrypted) return null;

  try {
    const decrypted = await decrypt(delivery.payloadEncrypted);
    const parsed = JSON.parse(decrypted) as {
      lpa?: string;
      activationCode?: string;
      iccid?: string;
    };

    if (!parsed.lpa) return null;
    return {
      lpa: parsed.lpa,
      activationCode: parsed.activationCode || '',
      iccid: parsed.iccid || '',
    };
  } catch {
    return null;
  }
}
