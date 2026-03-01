import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../db/prisma';
import { verifyShopifyWebhook } from '../shopify/webhooks';
import { getJobQueue } from '../queue/jobQueue';

interface ShopifyOrderPaidWebhook {
  id: number;
  name: string;
  email: string;
  contact_email?: string;
  customer?: {
    id: number;
    email: string;
    first_name: string;
    last_name: string;
    phone?: string;
  };
  billing_address?: {
    email?: string;
  };
  line_items: Array<{
    id: number;
    variant_id: number;
    quantity: number;
    product_id: number;
    title: string;
    name: string;
    sku?: string;
  }>;
}

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

      if (!rawBody) {
        app.log.error('[Webhook] No raw body available');
        return reply.code(400).send({ error: 'Missing request body' });
      }

      if (!hmacHeader) {
        app.log.error('[Webhook] Missing HMAC header');
        return reply.code(401).send({ error: 'Missing HMAC signature' });
      }

      // Verify HMAC signature
      const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET!;
      if (!webhookSecret) {
        app.log.error('[Webhook] SHOPIFY_WEBHOOK_SECRET not configured');
        return reply.code(500).send({ error: 'Server misconfiguration' });
      }

      const isValid = verifyShopifyWebhook(rawBody, hmacHeader, webhookSecret);
      if (!isValid) {
        app.log.error('[Webhook] Invalid HMAC signature');
        return reply.code(401).send({ error: 'Invalid signature' });
      }

      // Parse webhook payload
      const webhook: ShopifyOrderPaidWebhook = JSON.parse(rawBody);
      const orderId = webhook.id.toString();
      const orderName = webhook.name;

      // Debug: Log email fields
      app.log.info(
        `[Webhook] Order ${orderName} - webhook.email: ${webhook.email}, customer?.email: ${webhook.customer?.email}`,
      );

      // Use customer email if available, fallback to order email
      const customerEmail = webhook.customer?.email || webhook.email;

      if (!customerEmail) {
        app.log.error(
          `[Webhook] No email found for order ${orderName}. Webhook payload: ${JSON.stringify({
            email: webhook.email,
            customer: webhook.customer,
            contact_email: webhook.contact_email,
            billing_address: webhook.billing_address?.email,
          })}`,
        );
        return reply.code(400).send({ error: 'No customer email' });
      }

      app.log.info(`[Webhook] Received orders/paid for ${orderName} (${orderId})`);

      // Get job queue
      const queue = getJobQueue();

      // Process each line item
      for (const lineItem of webhook.line_items) {
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
          app.log.info(
            `[Webhook] Order ${orderName} line item ${lineItemId} already processed, skipping`,
          );
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

        app.log.info(`[Webhook] Created delivery record ${delivery.id} for ${orderName}`);

        // Enqueue provisioning job with retry policy
        await queue.send(
          'provision-esim',
          {
            deliveryId: delivery.id,
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

        app.log.info(`[Webhook] Enqueued provisioning job for delivery ${delivery.id}`);
      }

      // Always return 200 quickly to avoid Shopify retries
      return reply.code(200).send({ received: true });
    } catch (error) {
      const err = error as Error;
      app.log.error({ err }, '[Webhook] Error processing webhook');

      // Still return 200 to avoid retries - log error for investigation
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
