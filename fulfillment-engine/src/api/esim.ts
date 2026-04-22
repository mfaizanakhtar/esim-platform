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

const SHOPIFY_CUSTOM_DOMAIN = process.env.SHOPIFY_CUSTOM_DOMAIN ?? 'sailesim.com';

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
            message: 'Refund could not be processed automatically. Please contact support.',
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

  /**
   * GET /esim/topup-options/:token
   * Returns same-region active SKU mappings the customer can top-up with.
   * Only valid for delivered, non-top-up deliveries.
   */
  app.get(
    '/esim/topup-options/:token',
    async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
      const { token } = request.params;

      const delivery = await prisma.esimDelivery.findUnique({
        where: { accessToken: token },
      });

      if (!delivery) return reply.code(404).send({ error: 'Not found' });
      if (delivery.status !== 'delivered') return reply.code(400).send({ error: 'not_delivered' });
      if (delivery.topupIccid)
        return reply.code(400).send({ error: 'topup_not_allowed_on_topup_delivery' });

      // Find the mapping the original delivery was provisioned with (by stored SKU)
      if (!delivery.sku || !delivery.provider) {
        return reply.send({ options: [] });
      }

      const sourceMapping = await prisma.providerSkuMapping.findUnique({
        where: { shopifySku_provider: { shopifySku: delivery.sku, provider: delivery.provider } },
      });

      if (!sourceMapping?.region) {
        return reply.send({ options: [] });
      }

      // Return all active same-provider + same-region mappings as top-up options
      const options = await prisma.providerSkuMapping.findMany({
        where: {
          provider: delivery.provider,
          region: sourceMapping.region,
          isActive: true,
        },
        select: { id: true, name: true, dataAmount: true, validity: true, shopifySku: true },
      });

      return reply.send({ options });
    },
  );

  /**
   * POST /esim/topup-checkout/:token
   * Creates a Shopify draft order for the selected top-up package.
   * Returns { checkoutUrl } for the extension to redirect to.
   */
  app.post(
    '/esim/topup-checkout/:token',
    async (
      request: FastifyRequest<{ Params: { token: string }; Body: { mappingId: string } }>,
      reply: FastifyReply,
    ) => {
      const { token } = request.params;
      const body = request.body as Record<string, unknown>;
      const mappingId = typeof body?.mappingId === 'string' ? body.mappingId : undefined;

      if (!mappingId) return reply.code(400).send({ error: 'mappingId required' });

      const delivery = await prisma.esimDelivery.findUnique({
        where: { accessToken: token },
      });

      if (!delivery) return reply.code(404).send({ error: 'Not found' });
      if (delivery.status !== 'delivered') return reply.code(400).send({ error: 'not_delivered' });
      if (delivery.topupIccid)
        return reply.code(400).send({ error: 'topup_not_allowed_on_topup_delivery' });

      // Decrypt to get the ICCID
      if (!delivery.payloadEncrypted) {
        return reply.code(500).send({ error: 'Payload missing' });
      }

      let iccid: string;
      try {
        const decrypted = decrypt(delivery.payloadEncrypted);
        const parsed = StoredPayloadSchema.parse(JSON.parse(decrypted));
        if (!parsed.iccid) throw new Error('iccid missing from payload');
        iccid = parsed.iccid;
      } catch {
        return reply.code(500).send({ error: 'Failed to read eSIM credentials' });
      }

      // Validate the selected mapping
      const mapping = await prisma.providerSkuMapping.findUnique({ where: { id: mappingId } });
      if (!mapping || !mapping.isActive) {
        return reply.code(404).send({ error: 'mapping_not_found' });
      }
      if (mapping.provider !== delivery.provider) {
        return reply.code(400).send({ error: 'provider_mismatch' });
      }

      // Guard: verify the mapping belongs to the same region as the original delivery
      if (!delivery.sku) {
        return reply.code(400).send({ error: 'topup_source_mapping_missing' });
      }

      const sourceMapping = await prisma.providerSkuMapping.findUnique({
        where: { shopifySku_provider: { shopifySku: delivery.sku, provider: delivery.provider } },
      });
      if (!sourceMapping?.region) {
        return reply.code(400).send({ error: 'topup_source_mapping_missing' });
      }
      if (mapping.region !== sourceMapping.region) {
        return reply.code(400).send({ error: 'region_mismatch' });
      }

      const shopify = getShopifyClient();

      // Look up the Shopify variant GID by SKU
      let variantGid: string | null;
      try {
        variantGid = await shopify.getVariantGidBySku(mapping.shopifySku);
      } catch (error) {
        logger.error(
          { deliveryId: delivery.id, shopifySku: mapping.shopifySku, err: error },
          'Failed to look up Shopify variant for top-up',
        );
        return reply.code(502).send({ error: 'shopify_unavailable' });
      }

      if (!variantGid) {
        logger.error(
          { shopifySku: mapping.shopifySku },
          'Shopify variant not found for top-up SKU',
        );
        return reply.code(404).send({ error: 'shopify_variant_not_found' });
      }

      const customerEmail = delivery.customerEmail ?? '';
      let checkoutUrl: string;
      try {
        ({ checkoutUrl } = await shopify.createDraftOrder(variantGid, iccid, customerEmail));
      } catch (error) {
        logger.error(
          { deliveryId: delivery.id, err: error },
          'Failed to create Shopify draft order for top-up',
        );
        return reply.code(502).send({ error: 'shopify_unavailable' });
      }

      return reply.send({ checkoutUrl });
    },
  );

  /**
   * GET /esim/order-status/:orderId
   * Returns the eSIM provisioning status for the thank-you page extension.
   * Returns only status — no credentials or access tokens.
   * Used by the checkout UI extension which cannot receive metafield updates reactively.
   */
  /**
   * Returns all deliveries for an order, used by customer account extensions.
   */
  app.get(
    '/esim/order-deliveries/:orderId',
    async (request: FastifyRequest<{ Params: { orderId: string } }>, reply: FastifyReply) => {
      const { orderId } = request.params;

      const deliveries = await prisma.esimDelivery.findMany({
        where: { orderId },
        select: { lineItemId: true, status: true, accessToken: true },
        orderBy: { createdAt: 'desc' },
      });

      return reply.send({
        deliveries: deliveries.map((d) => ({
          lineItemId: d.lineItemId,
          status: d.status,
          ...(d.status === 'delivered' && d.accessToken ? { accessToken: d.accessToken } : {}),
        })),
      });
    },
  );

  app.get(
    '/esim/order-status/:orderId',
    async (request: FastifyRequest<{ Params: { orderId: string } }>, reply: FastifyReply) => {
      const { orderId } = request.params;

      const delivery = await prisma.esimDelivery.findFirst({
        where: { orderId },
        select: { status: true, accessToken: true },
        orderBy: { createdAt: 'desc' },
      });

      if (!delivery) {
        return reply.send({ status: null });
      }

      // Include the access token only when delivered so the extension can
      // fetch full credentials from /esim/delivery/:token for the modal.
      return reply.send({
        status: delivery.status,
        ...(delivery.status === 'delivered' && delivery.accessToken
          ? { accessToken: delivery.accessToken }
          : {}),
      });
    },
  );

  done();
}
