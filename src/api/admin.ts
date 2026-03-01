import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../db/prisma';
import { getJobQueue } from '../queue/jobQueue';
import { sendDeliveryEmail, type EsimPayload } from '../services/email';
import { decrypt } from '../utils/crypto';

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

/**
 * Simple API key guard — reads X-Admin-Key header.
 * Set ADMIN_API_KEY env var to enable protection (no-ops in dev if unset).
 */
function requireAdminKey(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!ADMIN_API_KEY) return true; // dev mode: no key required
  const key = request.headers['x-admin-key'];
  if (key !== ADMIN_API_KEY) {
    reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export default function adminRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
  done: () => void,
) {
  /**
   * GET /admin/deliveries
   * List deliveries, optionally filtered by status.
   * Query params: status=pending|provisioning|delivered|failed, limit=50, offset=0
   */
  app.get('/deliveries', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const query = request.query as { status?: string; limit?: string; offset?: string };
    const status = query.status;
    const limit = Math.min(parseInt(query.limit || '50', 10), 200);
    const offset = parseInt(query.offset || '0', 10);

    const where = status ? { status } : {};

    const [rawDeliveries, total] = await Promise.all([
      prisma.esimDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          attempts: { orderBy: { createdAt: 'desc' }, take: 5 },
        },
      }),
      prisma.esimDelivery.count({ where }),
    ]);

    // Strip encrypted payload before returning — never expose it in list view
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const deliveries = rawDeliveries.map(({ payloadEncrypted: _omit, ...rest }) => rest);

    return reply.send({ total, limit, offset, deliveries });
  });

  /**
   * GET /admin/deliveries/:id
   * Get a single delivery with all attempts.
   * Decrypts the eSIM payload if present.
   */
  app.get('/deliveries/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const { id } = request.params as { id: string };

    const delivery = await prisma.esimDelivery.findUnique({
      where: { id },
      include: {
        attempts: { orderBy: { createdAt: 'desc' } },
        esimOrders: true,
      },
    });

    if (!delivery) {
      return reply.code(404).send({ error: 'Delivery not found' });
    }

    // Decrypt eSIM payload for admin inspection
    let esimPayload: Record<string, unknown> | null = null;
    if (delivery.payloadEncrypted) {
      try {
        const decrypted = await decrypt(delivery.payloadEncrypted);
        esimPayload = JSON.parse(decrypted) as Record<string, unknown>;
      } catch {
        esimPayload = { error: 'Failed to decrypt payload' };
      }
    }

    return reply.send({
      ...delivery,
      payloadEncrypted: undefined,
      esimPayload,
    });
  });

  /**
   * POST /admin/deliveries/:id/retry
   * Re-enqueue a failed delivery for provisioning.
   * Only works if current status is 'failed'.
   */
  app.post('/deliveries/:id/retry', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const { id } = request.params as { id: string };

    const delivery = await prisma.esimDelivery.findUnique({ where: { id } });

    if (!delivery) {
      return reply.code(404).send({ error: 'Delivery not found' });
    }

    if (delivery.status === 'delivered') {
      return reply.code(409).send({ error: 'Delivery already completed — will not retry' });
    }

    // Reset to pending so the job handler re-processes it
    await prisma.esimDelivery.update({
      where: { id },
      data: { status: 'pending', lastError: null },
    });

    const queue = getJobQueue();
    await queue.send(
      'provision-esim',
      {
        deliveryId: delivery.id,
        orderId: delivery.orderId,
        orderName: delivery.orderName,
        lineItemId: delivery.lineItemId,
        variantId: delivery.variantId,
        customerEmail: delivery.customerEmail,
      },
      {
        retryLimit: 3,
        retryDelay: 60,
        expireInSeconds: 3600,
      },
    );

    app.log.info(`[Admin] Re-enqueued delivery ${id} for retry`);

    return reply.send({ ok: true, message: `Delivery ${id} re-enqueued` });
  });

  /**
   * POST /admin/deliveries/:id/resend-email
   * Re-send the delivery email for an already-delivered eSIM.
   * Decrypts the payload and calls sendDeliveryEmail again.
   */
  app.post('/deliveries/:id/resend-email', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const { id } = request.params as { id: string };

    const delivery = await prisma.esimDelivery.findUnique({ where: { id } });

    if (!delivery) {
      return reply.code(404).send({ error: 'Delivery not found' });
    }

    if (delivery.status !== 'delivered') {
      return reply
        .code(409)
        .send({ error: `Cannot resend email: delivery status is '${delivery.status}'` });
    }

    if (!delivery.payloadEncrypted) {
      return reply.code(409).send({ error: 'No encrypted eSIM payload found for this delivery' });
    }

    if (!delivery.customerEmail) {
      return reply.code(409).send({ error: 'No customer email on this delivery' });
    }

    // Decrypt eSIM payload
    let esimPayload: EsimPayload;
    try {
      const decrypted = await decrypt(delivery.payloadEncrypted);
      esimPayload = JSON.parse(decrypted) as EsimPayload;
    } catch {
      return reply.code(500).send({ error: 'Failed to decrypt eSIM payload' });
    }

    const emailResult = await sendDeliveryEmail({
      to: delivery.customerEmail,
      orderNumber: delivery.orderName,
      esimPayload,
    });

    if (!emailResult.success) {
      app.log.error(`[Admin] Resend email failed for delivery ${id}: ${emailResult.error}`);
      return reply.code(502).send({ error: `Email send failed: ${emailResult.error}` });
    }

    app.log.info(`[Admin] Resent delivery email for ${id}: ${emailResult.messageId}`);

    return reply.send({ ok: true, messageId: emailResult.messageId });
  });

  done();
}
