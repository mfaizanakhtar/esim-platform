import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import webhookRoutes from '~/api/webhook';
import tgtCallbackRoutes from '~/api/tgtCallback';
import usageRoutes from '~/api/usage';
import adminRoutes from '~/api/admin';
import esimRoutes from '~/api/esim';
import { getShopifyClient } from '~/shopify/client';

export default async function buildServer() {
  const app = Fastify({
    logger: true,
    // Enable raw body for webhook HMAC verification
    bodyLimit: 1048576, // 1MB
  });

  // Configure CORS for Shopify storefront
  await app.register(cors, {
    origin: (origin, callback) => {
      const shopifyDomain = process.env.SHOPIFY_SHOP_DOMAIN; // fluxyfi-com.myshopify.com
      const customDomain = process.env.SHOPIFY_CUSTOM_DOMAIN; // fluxyfi.com (optional)

      const allowedOrigins = [
        `https://${shopifyDomain}`,
        'http://localhost:3000', // Local development
        'http://127.0.0.1:3000',
        'http://localhost:5173', // Dashboard dev server (Vite)
        'http://127.0.0.1:5173',
        'https://extensions.shopifycdn.com', // Shopify Customer Account UI Extensions
      ];

      // Add custom domain if configured
      if (customDomain) {
        allowedOrigins.push(`https://${customDomain}`);
      }

      // Add deployed dashboard URL if configured (e.g. https://esim-dashboard.vercel.app)
      if (process.env.DASHBOARD_URL) {
        allowedOrigins.push(process.env.DASHBOARD_URL);
      }

      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.some((allowed) => origin.startsWith(allowed))) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'), false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-admin-key', 'Accept'],
  });

  // Configure rate limiting to prevent abuse
  await app.register(rateLimit, {
    max: 100, // Maximum 100 requests
    timeWindow: '15 minutes', // Per 15 minute window
    cache: 10000, // Cache size
    allowList: ['127.0.0.1'], // Whitelist localhost for testing
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please try again later.',
    }),
  });

  // Add raw body parser for webhooks
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    // Store raw body for HMAC verification
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      const json = JSON.parse(body as string);
      done(null, json);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Initialize Shopify client
  try {
    const shopify = getShopifyClient();
    await shopify.initialize();
    app.log.info('[Server] Shopify client initialized');
  } catch (error) {
    const err = error as Error;
    app.log.error({ err }, '[Server] Failed to initialize Shopify client');
  }

  app.get('/health', async () => ({ status: 'ok' }));

  app.register(webhookRoutes, { prefix: '/webhook' });
  app.register(tgtCallbackRoutes, { prefix: '/webhook/tgt' });
  app.register(usageRoutes);
  app.register(adminRoutes, { prefix: '/admin' });
  app.register(esimRoutes);

  return app;
}
