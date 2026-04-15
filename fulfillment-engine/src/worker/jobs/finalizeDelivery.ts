import { randomUUID } from 'crypto';
import prisma from '~/db/prisma';
import { decrypt, encrypt, hashIccid } from '~/utils/crypto';
import {
  sendDeliveryEmail,
  sendTopupEmail,
  recordDeliveryAttempt,
  type EsimPayload,
} from '~/services/email';
import { getShopifyClient } from '~/shopify/client';
import { logger } from '~/utils/logger';

const SHOPIFY_CUSTOM_DOMAIN = process.env.SHOPIFY_CUSTOM_DOMAIN ?? 'sailesim.com';

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
  provider?: string;
  metadata?: DeliveryMetadata;
}

/**
 * Idempotent finalization path used by initial provision, poll retries and vendor callbacks.
 */
export async function finalizeDelivery(
  args: FinalizeArgs,
): Promise<{ ok: true; alreadyDone?: boolean }> {
  // Resolve the canonical ICCID: prefer args.iccid (from vendor), fall back to
  // the delivery's stored topupIccid (decrypted) so payloadEncrypted, iccidHash,
  // email, and metafield all use the same value.
  let resolvedIccid = args.iccid;
  if (!resolvedIccid) {
    const earlyDelivery = await prisma.esimDelivery.findUnique({
      where: { id: args.deliveryId },
      select: { topupIccid: true },
    });
    if (earlyDelivery?.topupIccid) {
      try {
        resolvedIccid = decrypt(earlyDelivery.topupIccid);
      } catch (error) {
        logger.error(
          { deliveryId: args.deliveryId, err: error },
          'Failed to resolve stored top-up ICCID during finalize',
        );
        throw error;
      }
      if (!resolvedIccid) {
        logger.error({ deliveryId: args.deliveryId }, 'Resolved top-up ICCID is empty');
        throw new Error('topup_iccid_missing');
      }
    }
  }

  const payload: EsimPayload = {
    lpa: args.lpa,
    activationCode: args.activationCode,
    iccid: resolvedIccid,
  };

  const payloadEncrypted = encrypt(
    JSON.stringify({
      vendorId: args.vendorOrderId,
      lpa: args.lpa,
      activationCode: args.activationCode,
      iccid: resolvedIccid,
    }),
  );

  // Reuse the access token pre-generated in the webhook so the extension
  // (which is already polling that token) stays consistent. Fall back to a
  // fresh UUID for legacy deliveries created before this logic was deployed.
  const preFetched = await prisma.esimDelivery.findUnique({
    where: { id: args.deliveryId },
    select: { accessToken: true },
  });
  const accessToken = preFetched?.accessToken ?? randomUUID();

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
      accessToken,
      status: 'delivered',
      lastError: null,
      iccidHash: hashIccid(resolvedIccid),
      ...(args.provider ? { provider: args.provider } : {}),
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

  const isTopup = Boolean(delivery.topupIccid);

  if (delivery.customerEmail) {
    const emailResult = isTopup
      ? await sendTopupEmail({
          to: delivery.customerEmail,
          orderName: delivery.orderName,
          iccid: resolvedIccid,
          productName: args.metadata?.productName,
          dataAmount: args.metadata?.dataAmount,
          validity: args.metadata?.validity,
        })
      : await sendDeliveryEmail({
          to: delivery.customerEmail,
          orderNumber: delivery.orderName,
          productName: args.metadata?.productName,
          esimPayload: payload,
          region: args.metadata?.region,
          dataAmount: args.metadata?.dataAmount,
          validity: args.metadata?.validity,
          usageUrl: `https://${SHOPIFY_CUSTOM_DOMAIN}/pages/my-esim-usage?iccid=${resolvedIccid}`,
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
    const shopify = getShopifyClient();

    try {
      await shopify.createFulfillment(delivery.orderId);
    } catch (error) {
      logger.error(
        { deliveryId: args.deliveryId, err: error },
        'Failed to create Shopify fulfillment during finalize',
      );
    }

    try {
      const metafieldEntry = isTopup
        ? { status: 'delivered' as const, accessToken, iccid: resolvedIccid, isTopup: true }
        : {
            status: 'delivered' as const,
            accessToken,
            lpa: args.lpa,
            activationCode: args.activationCode,
            iccid: resolvedIccid,
            usageUrl: `https://${SHOPIFY_CUSTOM_DOMAIN}/pages/my-esim-usage?iccid=${resolvedIccid}`,
          };
      await shopify.writeDeliveryMetafield(delivery.orderId, delivery.lineItemId, metafieldEntry);
    } catch (error) {
      // Non-fatal: email was sent, eSIM is delivered. Extension can show a fallback.
      logger.error(
        { deliveryId: args.deliveryId, err: error },
        'Failed to write delivery metafield to Shopify order',
      );
    }
  }

  return { ok: true };
}

export async function getDecryptedEsimPayload(deliveryId: string): Promise<EsimPayload | null> {
  const delivery = await prisma.esimDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery?.payloadEncrypted) return null;

  try {
    const decrypted = decrypt(delivery.payloadEncrypted);
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
