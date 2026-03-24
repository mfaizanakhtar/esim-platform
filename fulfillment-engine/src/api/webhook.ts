import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import prisma from '~/db/prisma';
import { verifyShopifyWebhook } from '~/shopify/webhooks';
import { getJobQueue } from '~/queue/jobQueue';

const ShopifyLineItemSchema = z.object({
  id: z.coerce.number(),
  variant_id: z.coerce.number().nullable().optional(),
  quantity: z.coerce.number().default(1),
  product_id: z.coerce.number().nullable().optional(),
  title: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
});

const ShopifyOrderPaidSchema = z.object({
  id: z.coerce.number(),
  name: z.string(),
  email: z.string().nullable().optional().default(''),
  contact_email: z.string().nullable().optional(),
  customer: z
    .object({
      id: z.coerce.number(),
      email: z.string().nullable().optional(),
      first_name: z.string().nullable().optional(),
      last_name: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  billing_address: z
    .object({
      email: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  line_items: z.array(ShopifyLineItemSchema),
});

type ShopifyOrderPaidWebhook = z.infer<typeof ShopifyOrderPaidSchema>;

const ShopifyOrderCancelledSchema = z.object({
  id: z.coerce.number(),
});

export default function webhookRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
  done: () => void,
) {
  /**
   * POST /webhook/orders/paid
   * Handle Shopify order payment webhook
   */
  app.post('/orders/paid', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Get raw body for HMAC verification
      const rawBody = (request as unknown as { rawBody?: string }).rawBody;
      const hmacHeader = request.headers['x-shopify-hmac-sha256'] as string;
      const shopDomain = request.headers['x-shopify-shop-domain'] as string;
      const topic = request.headers['x-shopify-topic'] as string | undefined;

      if (!rawBody) {
        app.log.error('No raw body available');
        return reply.code(400).send({ error: 'Missing request body' });
      }

      if (!hmacHeader) {
        app.log.error('Missing HMAC header');
        return reply.code(401).send({ error: 'Missing HMAC signature' });
      }

      // Verify HMAC signature
      const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET!;
      if (!webhookSecret) {
        app.log.error('SHOPIFY_WEBHOOK_SECRET not configured');
        return reply.code(500).send({ error: 'Server misconfiguration' });
      }

      const isValid = verifyShopifyWebhook(rawBody, hmacHeader, webhookSecret);
      if (!isValid) {
        app.log.error('Invalid HMAC signature');
        return reply.code(401).send({ error: 'Invalid signature' });
      }

      // Ignore unexpected topics if this URL is reused by other Shopify webhook subscriptions.
      // We only process orders/paid payloads in this handler.
      if (topic && topic !== 'orders/paid') {
        app.log.info({ topic }, 'Ignoring unsupported webhook topic for /orders/paid endpoint');
        return reply.code(200).send({ received: true, ignored: true });
      }

      // Parse and validate webhook payload shape
      const parseResult = ShopifyOrderPaidSchema.safeParse(JSON.parse(rawBody));
      if (!parseResult.success) {
        app.log.error({ issues: parseResult.error.issues }, 'Invalid webhook payload shape');
        return reply.code(400).send({ error: 'Invalid webhook payload' });
      }
      const webhook: ShopifyOrderPaidWebhook = parseResult.data;
      const orderId = webhook.id.toString();
      const orderName = webhook.name;

      // Log email fields for debugging
      app.log.info(
        { orderId, orderName, webhookEmail: webhook.email, customerEmail: webhook.customer?.email },
        'Email fields',
      );

      // Use customer email if available, fallback to order email
      const customerEmail =
        webhook.customer?.email ||
        webhook.contact_email ||
        webhook.email ||
        webhook.billing_address?.email;

      if (!customerEmail) {
        app.log.error(
          {
            orderId,
            orderName,
            webhookEmail: webhook.email,
            customerEmail: webhook.customer?.email,
            contactEmail: webhook.contact_email,
            billingEmail: webhook.billing_address?.email,
          },
          'No email found for order',
        );
        return reply.code(400).send({ error: 'No customer email' });
      }

      app.log.info({ orderId, orderName }, 'Received orders/paid');

      // Get job queue
      const queue = getJobQueue();

      // Process each line item
      for (const lineItem of webhook.line_items) {
        if (!lineItem.variant_id) {
          app.log.warn(
            { orderId, orderName, lineItemId: lineItem.id },
            'Skipping line item with null variant_id',
          );
          continue;
        }

        const lineItemId = lineItem.id.toString();
        const variantId = lineItem.variant_id.toString();

        // Check if already processed (idempotency)
        const existing = await prisma.esimDelivery.findFirst({
          where: {
            orderId,
            lineItemId,
          },
        });

        if (existing) {
          app.log.info({ orderId, orderName, lineItemId }, 'Line item already processed, skipping');
          continue;
        }

        // Create delivery record
        const delivery = await prisma.esimDelivery.create({
          data: {
            shop: shopDomain,
            orderId,
            orderName,
            lineItemId,
            variantId,
            customerEmail,
            status: 'pending',
          },
        });

        app.log.info({ deliveryId: delivery.id, orderId, orderName }, 'Created delivery record');

        // Enqueue provisioning job with retry policy
        await queue.send(
          'provision-esim',
          {
            deliveryId: delivery.id,
            requestId: request.id,
            orderId,
            orderName,
            lineItemId,
            variantId,
            customerEmail,
            sku: lineItem.sku || null,
          },
          {
            retryLimit: 3, // up to 3 retries
            retryDelay: 60, // wait 60s between retries
            expireInSeconds: 3600, // give up after 1 hour
          },
        );

        app.log.info({ deliveryId: delivery.id, orderId }, 'Enqueued provisioning job');
      }

      // Always return 200 quickly to avoid Shopify retries
      return reply.code(200).send({ received: true });
    } catch (error) {
      const err = error as Error;
      app.log.error({ err }, 'Error processing webhook');

      // Still return 200 to avoid retries - log error for investigation
      return reply.code(200).send({ received: true, error: 'Processing error' });
    }
  });

  /**
   * POST /webhook/orders/cancelled
   * Handle Shopify order cancellation — cancel vendor eSIM for each delivered line item.
   */
  app.post('/orders/cancelled', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const rawBody = (request as unknown as { rawBody?: string }).rawBody;
      const hmacHeader = request.headers['x-shopify-hmac-sha256'] as string;
      const topic = request.headers['x-shopify-topic'] as string | undefined;

      if (!rawBody) {
        app.log.error('cancelWebhook: No raw body');
        return reply.code(400).send({ error: 'Missing request body' });
      }

      if (!hmacHeader) {
        return reply.code(401).send({ error: 'Missing HMAC signature' });
      }

      const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET!;
      if (!webhookSecret) {
        return reply.code(500).send({ error: 'Server misconfiguration' });
      }

      if (!verifyShopifyWebhook(rawBody, hmacHeader, webhookSecret)) {
        return reply.code(401).send({ error: 'Invalid signature' });
      }

      if (topic && topic !== 'orders/cancelled') {
        app.log.info({ topic }, 'cancelWebhook: Ignoring unsupported topic');
        return reply.code(200).send({ received: true, ignored: true });
      }

      const parsed = ShopifyOrderCancelledSchema.safeParse(JSON.parse(rawBody));
      if (!parsed.success) {
        app.log.error({ issues: parsed.error.issues }, 'cancelWebhook: Invalid payload');
        return reply.code(400).send({ error: 'Invalid webhook payload' });
      }

      const orderId = parsed.data.id.toString();
      app.log.info({ orderId }, 'cancelWebhook: Received orders/cancelled');

      // Find all non-terminal deliveries for this order
      const deliveries = await prisma.esimDelivery.findMany({
        where: {
          orderId,
          status: { notIn: ['cancelled', 'failed'] },
        },
        select: { id: true },
      });

      if (deliveries.length === 0) {
        app.log.info({ orderId }, 'cancelWebhook: No active deliveries, skipping');
        return reply.code(200).send({ received: true });
      }

      const queue = getJobQueue();
      for (const delivery of deliveries) {
        await queue.send('cancel-esim', { deliveryId: delivery.id, orderId }, { retryLimit: 2 });
        app.log.info(
          { deliveryId: delivery.id, orderId },
          'cancelWebhook: Enqueued cancel-esim job',
        );
      }

      return reply.code(200).send({ received: true });
    } catch (error) {
      app.log.error({ err: error }, 'cancelWebhook: Unexpected error');
      return reply.code(200).send({ received: true, error: 'Processing error' });
    }
  });

  /**
   * GET /webhook/test
   * Test endpoint to verify webhook server is running
   */
  app.get('/test', async (request, reply) => {
    return reply.send({ status: 'ok', message: 'Webhook server is running' });
  });

  done();
}
