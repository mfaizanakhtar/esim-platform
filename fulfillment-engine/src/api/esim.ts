import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import prisma from '~/db/prisma';
import { decrypt } from '~/utils/crypto';
import { getShopifyClient } from '~/shopify/client';
import FiRoamClient from '~/vendor/firoamClient';
import TgtClient from '~/vendor/tgtClient';
import { logger } from '~/utils/logger';

const StoredPayloadSchema = z.object({
  vendorId: z.string().optional(),
  lpa: z.string().optional(),
  activationCode: z.string().optional(),
  iccid: z.string().optional(),
});

const SHOPIFY_CUSTOM_DOMAIN = process.env.SHOPIFY_CUSTOM_DOMAIN ?? 'fluxyfi.com';

/**
 * Public eSIM delivery routes — authenticated via UUID access token only.
 * No session/API key required; the token (2^122 entropy) is the credential.
 *
 * GET  /esim/delivery/:token        — return eSIM status + decrypted credentials
 * POST /esim/delivery/:token/cancel — vendor activation check → vendor cancel → Shopify cancel + refund
 */
export default function esimRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
  done: () => void,
) {
  /**
   * GET /esim/delivery/:token
   * Returns eSIM status and credentials for the Customer Account UI Extension.
   */
  app.get(
    '/esim/delivery/:token',
    async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
      const { token } = request.params;

      const delivery = await prisma.esimDelivery.findUnique({
        where: { accessToken: token },
      });

      if (!delivery) {
        return reply.code(404).send({ error: 'Not found' });
      }

      // For non-delivered statuses, return status only (no credentials yet)
      if (delivery.status !== 'delivered') {
        return reply.send({
          status: delivery.status,
          canCancel: false,
        });
      }

      if (!delivery.payloadEncrypted) {
        return reply.code(500).send({ error: 'Payload missing' });
      }

      let payload: z.infer<typeof StoredPayloadSchema>;
      try {
        const decrypted = decrypt(delivery.payloadEncrypted);
        payload = StoredPayloadSchema.parse(JSON.parse(decrypted));
      } catch {
        logger.error({ deliveryId: delivery.id }, 'Failed to decrypt esim payload');
        return reply.code(500).send({ error: 'Failed to read eSIM credentials' });
      }

      const usageUrl = `https://${SHOPIFY_CUSTOM_DOMAIN}/pages/my-esim-usage?iccid=${payload.iccid ?? ''}`;

      return reply.send({
        status: 'delivered',
        lpa: payload.lpa ?? '',
        activationCode: payload.activationCode ?? '',
        iccid: payload.iccid ?? '',
        usageUrl,
        canCancel: true,
      });
    },
  );

  /**
   * POST /esim/delivery/:token/cancel
   * Checks if the eSIM is already activated with the vendor.
   * If not activated: cancel with vendor, cancel Shopify order with refund, mark delivery cancelled.
   * If already activated: return 409.
   */
  app.post(
    '/esim/delivery/:token/cancel',
    async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
      const { token } = request.params;

      const delivery = await prisma.esimDelivery.findUnique({
        where: { accessToken: token },
      });

      if (!delivery) {
        return reply.code(404).send({ error: 'Not found' });
      }

      if (delivery.status === 'cancelled') {
        return reply.send({ ok: true, alreadyDone: true });
      }

      if (delivery.status !== 'delivered') {
        return reply.code(400).send({
          error: 'not_cancellable',
          message: 'eSIM can only be cancelled after it has been delivered.',
        });
      }

      if (!delivery.payloadEncrypted) {
        return reply.code(500).send({ error: 'Payload missing' });
      }

      let payload: z.infer<typeof StoredPayloadSchema>;
      try {
        const decrypted = decrypt(delivery.payloadEncrypted);
        payload = StoredPayloadSchema.parse(JSON.parse(decrypted));
      } catch {
        return reply.code(500).send({ error: 'Failed to read eSIM credentials' });
      }

      const iccid = payload.iccid;
      const vendorOrderId = delivery.vendorReferenceId;

      if (!iccid || !vendorOrderId) {
        return reply.code(500).send({ error: 'Missing eSIM identifiers' });
      }

      // ── Check activation status with vendor ───────────────────────────────

      const provider = delivery.provider;

      if (provider === 'firoam') {
        const firoam = new FiRoamClient();
        const result = await firoam.queryEsimOrder({ iccid });

        if (result.success && result.orders && result.orders.length > 0) {
          const activated = result.orders.some((order) =>
            order.packages.some(
              (pkg) => pkg.iccid === iccid && (Number(pkg.usedMb) > 0 || pkg.beginDate),
            ),
          );

          if (activated) {
            return reply.code(409).send({
              error: 'esim_already_activated',
              message: 'This eSIM has already been installed and cannot be cancelled.',
            });
          }
        }

        // Not activated — cancel with FiRoam
        const cancelResult = await firoam.cancelOrder({
          orderNum: vendorOrderId,
          iccids: iccid,
        });

        if (!cancelResult.success) {
          logger.error(
            { deliveryId: delivery.id, message: cancelResult.message },
            'FiRoam cancel failed',
          );
          return reply.code(502).send({
            error: 'vendor_cancel_failed',
            message: cancelResult.message,
          });
        }
      } else if (provider === 'tgt') {
        const tgt = new TgtClient();
        const { orders } = await tgt.queryOrders({ iccid });

        if (orders.length > 0) {
          const order = orders[0];
          const activated = !!order.profileStatus || !!order.activatedStartTime;

          if (activated) {
            return reply.code(409).send({
              error: 'esim_already_activated',
              message: 'This eSIM has already been installed and cannot be cancelled.',
            });
          }
        }

        // TGT cancel API not available — skip vendor cancel, proceed to Shopify cancel
        logger.warn(
          { deliveryId: delivery.id },
          'TGT cancel API not implemented — proceeding with Shopify cancel only',
        );
      } else {
        return reply.code(400).send({
          error: 'unsupported_provider',
          message: 'Cancel is not supported for this eSIM provider.',
        });
      }

      // ── Cancel Shopify order + refund ─────────────────────────────────────

      if (delivery.orderId) {
        try {
          const shopify = getShopifyClient();
          await shopify.cancelShopifyOrder(delivery.orderId);
        } catch (error) {
          logger.error({ deliveryId: delivery.id, err: error }, 'Failed to cancel Shopify order');
          return reply.code(502).send({
            error: 'shopify_cancel_failed',
            message:
              'eSIM was deactivated with vendor but Shopify order cancellation failed. Please contact support.',
          });
        }
      }

      // ── Mark delivery cancelled ───────────────────────────────────────────

      await prisma.esimDelivery.update({
        where: { id: delivery.id },
        data: { status: 'cancelled' },
      });

      if (delivery.orderId) {
        try {
          const shopify = getShopifyClient();
          await shopify.writeDeliveryMetafield(delivery.orderId, delivery.lineItemId, {
            status: 'cancelled',
          });
        } catch (error) {
          logger.warn(
            { deliveryId: delivery.id, err: error },
            'Failed to update cancelled metafield (non-fatal)',
          );
        }
      }

      return reply.send({ ok: true });
    },
  );

  done();
}
