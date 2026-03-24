import { z } from 'zod';
import prisma from '~/db/prisma';
import { decrypt } from '~/utils/crypto';
import { getShopifyClient } from '~/shopify/client';
import FiRoamClient from '~/vendor/firoamClient';
import TgtClient from '~/vendor/tgtClient';
import { logger } from '~/utils/logger';

const DecryptedPayloadSchema = z.object({
  iccid: z.string().optional(),
  vendorId: z.string().optional(),
});

interface CancelEsimJobData {
  deliveryId: string;
  orderId: string;
}

/**
 * Handles eSIM cancellation triggered by a Shopify admin order cancellation.
 *
 * For each delivery:
 *  - If already cancelled/failed → skip (idempotent)
 *  - If delivered → check vendor activation → cancel with vendor → update status
 *  - If not yet delivered (pending/provisioning) → mark cancelled, no vendor call needed
 *
 * Always writes a note + tag to the Shopify order so the merchant can see what happened.
 */
export async function handleCancelEsim(data: CancelEsimJobData): Promise<void> {
  const { deliveryId, orderId } = data;

  const delivery = await prisma.esimDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery) {
    logger.warn({ deliveryId }, 'cancelEsim: delivery not found, skipping');
    return;
  }

  // Idempotency — already handled
  if (delivery.status === 'cancelled' || delivery.status === 'failed') {
    logger.info({ deliveryId, status: delivery.status }, 'cancelEsim: already terminal, skipping');
    return;
  }

  const shopify = getShopifyClient();

  // ── Not yet delivered ─────────────────────────────────────────────────────
  // eSIM was never provisioned — just mark cancelled, no vendor call needed.
  if (delivery.status !== 'delivered') {
    await prisma.esimDelivery.update({
      where: { id: deliveryId },
      data: { status: 'cancelled' },
    });

    try {
      await shopify.writeDeliveryMetafield(orderId, delivery.lineItemId, { status: 'cancelled' });
      await shopify.appendOrderNote(
        orderId,
        `[eSIM] Line item ${delivery.lineItemId}: cancelled before provisioning completed (was in "${delivery.status}" state). No vendor action needed.`,
      );
      await shopify.addOrderTags(orderId, ['esim-cancelled']);
    } catch (err) {
      logger.warn({ deliveryId, err }, 'cancelEsim: failed to write note/tag (non-fatal)');
    }
    return;
  }

  // ── Delivered — must cancel with vendor ───────────────────────────────────

  if (!delivery.payloadEncrypted) {
    logger.error({ deliveryId }, 'cancelEsim: delivered but payload missing');
    await writeOutcome(
      shopify,
      orderId,
      delivery.lineItemId,
      'failed',
      'Payload missing in DB — manual action required.',
    );
    return;
  }

  let iccid: string | undefined;
  try {
    const parseResult = DecryptedPayloadSchema.safeParse(
      JSON.parse(decrypt(delivery.payloadEncrypted)),
    );
    if (!parseResult.success) {
      throw new Error(`Invalid payload shape: ${parseResult.error.message}`);
    }
    iccid = parseResult.data.iccid;
  } catch {
    logger.error({ deliveryId }, 'cancelEsim: failed to decrypt payload');
    await writeOutcome(
      shopify,
      orderId,
      delivery.lineItemId,
      'failed',
      'Failed to read credentials — manual action required.',
    );
    return;
  }
  const vendorOrderId = delivery.vendorReferenceId ?? undefined;

  if (!iccid || !vendorOrderId) {
    logger.error({ deliveryId }, 'cancelEsim: missing iccid or vendorOrderId');
    await writeOutcome(
      shopify,
      orderId,
      delivery.lineItemId,
      'failed',
      'Missing eSIM identifiers — manual action required.',
    );
    return;
  }

  const provider = delivery.provider;

  // ── FiRoam ────────────────────────────────────────────────────────────────
  if (provider === 'firoam') {
    const firoam = new FiRoamClient();

    // Check activation
    const queryResult = await firoam.queryEsimOrder({ iccid });
    const activated =
      queryResult.success &&
      queryResult.orders?.some((order) =>
        order.packages.some(
          (pkg) => pkg.iccid === iccid && (Number(pkg.usedMb) > 0 || pkg.beginDate),
        ),
      );

    if (activated) {
      await prisma.esimDelivery.update({
        where: { id: deliveryId },
        data: { status: 'delivered', lastError: 'cancel_blocked: already activated' },
      });
      await writeOutcome(
        shopify,
        orderId,
        delivery.lineItemId,
        'failed',
        `eSIM already activated by customer. ICCID: ${iccid}. Cannot auto-cancel — please review manually.`,
        ['esim-cancel-failed', 'esim-activated'],
      );
      logger.warn({ deliveryId, iccid }, 'cancelEsim: FiRoam eSIM already activated');
      return;
    }

    // Cancel with FiRoam
    const cancelResult = await firoam.cancelOrder({ orderNum: vendorOrderId, iccids: iccid });
    if (!cancelResult.success) {
      await writeOutcome(
        shopify,
        orderId,
        delivery.lineItemId,
        'failed',
        `FiRoam vendor cancel failed: ${cancelResult.message ?? 'unknown error'}. ICCID: ${iccid}. Please cancel manually.`,
        ['esim-cancel-failed'],
      );
      logger.error(
        { deliveryId, message: cancelResult.message },
        'cancelEsim: FiRoam cancel failed',
      );
      return;
    }

    // Success
    await prisma.esimDelivery.update({ where: { id: deliveryId }, data: { status: 'cancelled' } });
    await writeOutcome(
      shopify,
      orderId,
      delivery.lineItemId,
      'cancelled',
      `eSIM cancelled with FiRoam. ICCID: ${iccid}.`,
      ['esim-cancelled'],
    );
    logger.info({ deliveryId, iccid }, 'cancelEsim: FiRoam cancelled successfully');
    return;
  }

  // ── TGT ───────────────────────────────────────────────────────────────────
  if (provider === 'tgt') {
    const tgt = new TgtClient();
    const { orders } = await tgt.queryOrders({ iccid });

    if (orders.length > 0) {
      const activated = !!orders[0].profileStatus || !!orders[0].activatedStartTime;
      if (activated) {
        await writeOutcome(
          shopify,
          orderId,
          delivery.lineItemId,
          'failed',
          `TGT eSIM already activated by customer. ICCID: ${iccid}. Cannot auto-cancel — please review manually.`,
          ['esim-cancel-failed', 'esim-activated'],
        );
        logger.warn({ deliveryId, iccid }, 'cancelEsim: TGT eSIM already activated');
        return;
      }
    }

    // TGT has no cancel API — mark cancelled in DB but flag for manual vendor action
    await prisma.esimDelivery.update({ where: { id: deliveryId }, data: { status: 'cancelled' } });
    await writeOutcome(
      shopify,
      orderId,
      delivery.lineItemId,
      'cancelled',
      `TGT eSIM refund processed. ICCID: ${iccid}. Note: TGT vendor cancel is not automated — please cancel in TGT portal if not yet activated.`,
      ['esim-cancelled', 'esim-tgt-manual-cancel-needed'],
    );
    logger.info(
      { deliveryId, iccid },
      'cancelEsim: TGT marked cancelled (manual vendor step needed)',
    );
    return;
  }

  // Unknown provider
  await writeOutcome(
    shopify,
    orderId,
    delivery.lineItemId,
    'failed',
    `Unknown provider "${provider ?? 'none'}". ICCID: ${iccid}. Please cancel manually.`,
    ['esim-cancel-failed'],
  );
  logger.error({ deliveryId, provider }, 'cancelEsim: unsupported provider');
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function writeOutcome(
  shopify: ReturnType<typeof getShopifyClient>,
  orderId: string,
  lineItemId: string,
  metafieldStatus: 'cancelled' | 'failed',
  noteText: string,
  tags?: string[],
): Promise<void> {
  try {
    await shopify.writeDeliveryMetafield(orderId, lineItemId, { status: metafieldStatus });
  } catch (err) {
    logger.warn(
      { orderId, lineItemId, err },
      'cancelEsim: writeDeliveryMetafield failed (non-fatal)',
    );
  }
  try {
    await shopify.appendOrderNote(orderId, `[eSIM] ${noteText}`);
  } catch (err) {
    logger.warn({ orderId, err }, 'cancelEsim: appendOrderNote failed (non-fatal)');
  }
  if (tags?.length) {
    try {
      await shopify.addOrderTags(orderId, tags);
    } catch (err) {
      logger.warn({ orderId, tags, err }, 'cancelEsim: addOrderTags failed (non-fatal)');
    }
  }
}
