import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '~/db/prisma';
import { Prisma } from '@prisma/client';
import { getJobQueue } from '~/queue/jobQueue';
import { sendDeliveryEmail, type EsimPayload } from '~/services/email';
import { decrypt } from '~/utils/crypto';
import TgtClient from '~/vendor/tgtClient';
import FiRoamClient from '~/vendor/firoamClient';
import { getShopifyClient } from '~/shopify/client';
import { logger } from '~/utils/logger';
import OpenAI from 'openai';
import { getRegisteredProviders } from '~/vendor/registry';
import {
  buildCatalogText,
  embedBatch,
  storeEmbedding,
  findTopCandidates,
  isVectorAvailable,
  backfillMissingEmbeddings,
  parseCatalogEntry,
  type ParsedCatalogAttributes,
} from '~/services/embeddingService';
import { parseShopifySku } from '~/utils/parseShopifySku';
import { getCountryByCode, firoamNameToCode } from '~/utils/countryCodes';
import { buildRegionSuggestions } from '~/services/regionService';

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

/**
 * Simple API key guard — reads X-Admin-Key header or query.apiKey (SSE fallback).
 * Set ADMIN_API_KEY env var to enable protection (no-ops in dev if unset).
 */
function requireAdminKey(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!ADMIN_API_KEY) return true; // dev mode: no key required
  const headerKey = request.headers['x-admin-key'];
  if (headerKey !== ADMIN_API_KEY) {
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
  // NOTE:
  // `providerSkuCatalog` exists in generated Prisma client, but VS Code's TS server
  // can temporarily report stale diagnostics if Prisma types were generated in a
  // different workspace context. We bind the delegate through a narrow local type
  // so route logic remains strictly typed and resilient to stale editor state.
  type CatalogEntry = {
    id: string;
    provider: string;
    productCode: string;
    productType: string | null;
    skuId: string;
    skuName: string | null;
    productName: string;
    region: string | null;
    dataAmount: string | null;
    validity: string | null;
    rawPayload: unknown;
  };
  const providerSkuCatalog = (
    prisma as unknown as {
      providerSkuCatalog: {
        findMany: (args: unknown) => Promise<unknown[]>;
        count: (args: unknown) => Promise<number>;
        upsert: (args: unknown) => Promise<{ id: string }>;
        findUnique: (args: { where: { id: string } }) => Promise<CatalogEntry | null>;
      };
    }
  ).providerSkuCatalog;

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
   * POST /admin/deliveries/:id/cancel
   * Cancel a delivery from the admin dashboard.
   * Body: { refund?: boolean } — if true, also issues a full Shopify refund.
   *
   * Enqueues a cancel-esim job (vendor cancel + DB update + Shopify note/tag).
   * Passing refund=true also triggers cancelShopifyOrder inside the job (non-fatal).
   */
  app.post('/deliveries/:id/cancel', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { refund?: boolean };

    const delivery = await prisma.esimDelivery.findUnique({ where: { id } });
    if (!delivery) {
      return reply.code(404).send({ error: 'Delivery not found' });
    }
    if (delivery.status === 'cancelled') {
      return reply.code(409).send({ error: 'Delivery is already cancelled' });
    }

    const queue = getJobQueue();
    await queue.send(
      'cancel-esim',
      { deliveryId: id, orderId: delivery.orderId, refund: body.refund === true },
      { retryLimit: 2, expireInSeconds: 3600 },
    );

    app.log.info(`[Admin] Queued cancel-esim for delivery ${id} (refund=${body.refund === true})`);
    const message =
      body.refund === true
        ? `Cancellation + refund queued for delivery ${id}`
        : `Cancellation queued for delivery ${id}`;
    return reply.code(202).send({ ok: true, message });
  });

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

  // ---------------------------------------------------------------------------
  // Providers
  // ---------------------------------------------------------------------------

  /**
   * GET /admin/providers
   * Returns all registered vendor provider names from the registry.
   * Drives dynamic dropdowns in the dashboard — no code change needed when a new provider is added.
   */
  app.get('/providers', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;
    return reply.send({ providers: getRegisteredProviders() });
  });

  // ---------------------------------------------------------------------------
  // SKU Mapping CRUD
  // Manage Shopify SKU → vendor provider mappings at runtime (no deploy needed).
  // ---------------------------------------------------------------------------

  /**
   * GET /admin/sku-mappings
   * List all SKU mappings, optionally filtered.
   * Query params: provider=firoam, isActive=true|false, limit=50, offset=0
   */
  app.get('/sku-mappings', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const query = request.query as {
      provider?: string;
      isActive?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };
    const offset = parseInt(query.offset || '0', 10);
    const limitCapped = Math.min(parseInt(query.limit || '100', 10), 10000);
    const where: Record<string, unknown> = {};
    if (query.provider) where.provider = query.provider;
    if (query.isActive !== undefined) where.isActive = query.isActive === 'true';
    if (query.search) {
      where.OR = [
        { shopifySku: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
        { providerSku: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [mappings, total] = await Promise.all([
      prisma.providerSkuMapping.findMany({
        where,
        include: { catalogEntry: true },
        orderBy: [{ shopifySku: 'asc' }, { priority: 'asc' }],
        take: limitCapped,
        skip: offset,
      }),
      prisma.providerSkuMapping.count({ where }),
    ]);

    return reply.send({ total, limit: limitCapped, offset, mappings });
  });

  /**
   * DELETE /admin/sku-mappings
   * Delete ALL SKU mappings (optionally scoped to one provider).
   * Query: provider=firoam|tgt — delete only that provider's mappings
   * Response: { deleted: number }
   */
  app.delete('/sku-mappings', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const query = request.query as { provider?: string };
    const provider = typeof query.provider === 'string' ? query.provider.trim() : undefined;
    if (query.provider !== undefined && !provider) {
      return reply.code(400).send({ error: 'provider cannot be empty' });
    }
    const where = provider ? { provider } : {};

    try {
      const { count } = await prisma.providerSkuMapping.deleteMany({ where });
      logger.warn({ provider: provider ?? 'all', deleted: count }, 'Cleared SKU mappings');
      return reply.send({ deleted: count });
    } catch (err) {
      logger.error({ err, provider: provider ?? 'all' }, 'Failed to clear SKU mappings');
      return reply.code(500).send({ error: 'Failed to clear SKU mappings' });
    }
  });

  /**
   * GET /admin/sku-mappings/:id
   * Get a single SKU mapping by ID.
   */
  app.get('/sku-mappings/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const { id } = request.params as { id: string };
    const mapping = await prisma.providerSkuMapping.findUnique({ where: { id } });

    if (!mapping) {
      return reply.code(404).send({ error: 'SKU mapping not found' });
    }

    return reply.send(mapping);
  });

  /**
   * POST /admin/sku-mappings
   * Create a new Shopify SKU → vendor provider mapping.
   *
   * Body (JSON):
   *   shopifySku        string  required  — Shopify variant SKU (must be unique)
   *   provider          string  required  — e.g. 'firoam', 'tgt'
   *   providerCatalogId string  optional  — ID from ProviderSkuCatalog; auto-derives providerSku + metadata
   *   providerSku       string  required if no providerCatalogId  — vendor-specific identifier
   *   name              string  optional  — auto-populated from catalog if omitted
   *   region            string  optional  — auto-populated from catalog if omitted
   *   dataAmount        string  optional  — auto-populated from catalog if omitted
   *   validity          string  optional  — auto-populated from catalog if omitted
   *   packageType       string  optional  — 'fixed' | 'daypass' (default: 'fixed')
   *   daysCount         number  optional  — required when packageType='daypass'
   *   providerConfig    object  optional  — vendor-specific extras (stored as JSON)
   *   isActive          boolean optional  — defaults to true
   */
  app.post('/sku-mappings', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const body = request.body as Record<string, unknown>;
    const { shopifySku } = body;
    const providerCatalogId =
      typeof body.providerCatalogId === 'string' ? body.providerCatalogId.trim() : null;
    if (providerCatalogId === '') {
      return reply.code(400).send({ error: 'providerCatalogId cannot be empty' });
    }

    if (!shopifySku || typeof shopifySku !== 'string') {
      return reply.code(400).send({ error: 'shopifySku is required' });
    }
    if (!body.provider || typeof body.provider !== 'string') {
      return reply.code(400).send({ error: 'provider is required' });
    }
    if (!providerCatalogId && (!body.providerSku || typeof body.providerSku !== 'string')) {
      return reply.code(400).send({ error: 'either providerCatalogId or providerSku is required' });
    }

    // Auto-derive fields from catalog entry when providerCatalogId is supplied
    const provider = body.provider;
    let providerSku = typeof body.providerSku === 'string' ? body.providerSku : '';
    let name = typeof body.name === 'string' ? body.name : null;
    let region = typeof body.region === 'string' ? body.region : null;
    let dataAmount = typeof body.dataAmount === 'string' ? body.dataAmount : null;
    let validity = typeof body.validity === 'string' ? body.validity : null;

    if (providerCatalogId) {
      const entry = await providerSkuCatalog.findUnique({ where: { id: providerCatalogId } });
      if (!entry) return reply.code(400).send({ error: 'Catalog entry not found' });
      if (entry.provider !== provider) {
        return reply.code(400).send({
          error: `Catalog entry provider '${entry.provider}' does not match request provider '${provider}'`,
        });
      }
      if (!name) name = entry.productName;
      if (!region) region = entry.region;
      if (!dataAmount) dataAmount = entry.dataAmount;
      if (!validity) validity = entry.validity;
      // Derive providerSku from catalog rawPayload
      if (entry.provider === 'firoam') {
        const raw = (entry.rawPayload ?? {}) as { skuId?: unknown; priceid?: unknown };
        if (raw.skuId === undefined || raw.priceid === undefined) {
          return reply.code(400).send({
            error: 'Catalog entry rawPayload is missing required firoam fields (skuId, priceid)',
          });
        }
        providerSku = `${String(raw.skuId)}:${entry.productCode}:${String(raw.priceid)}`;
      } else {
        providerSku = entry.productCode;
      }
    }

    if (!providerSku) {
      return reply.code(400).send({ error: 'Could not determine providerSku' });
    }

    // Check for duplicate (shopifySku, provider) combination
    const existing = await prisma.providerSkuMapping.findUnique({
      where: { shopifySku_provider: { shopifySku, provider } },
    });
    if (existing) {
      return reply.code(409).send({
        error: `SKU mapping already exists for: ${shopifySku} (provider: ${provider})`,
      });
    }

    // Default priority to max existing priority for this shopifySku + 1
    let priority: number;
    if (typeof body.priority === 'number') {
      priority = body.priority;
    } else {
      const maxRow = await prisma.providerSkuMapping.findFirst({
        where: { shopifySku },
        orderBy: { priority: 'desc' },
        select: { priority: true },
      });
      priority = (maxRow?.priority ?? 0) + 1;
    }

    const mapping = await prisma.providerSkuMapping.create({
      data: {
        shopifySku,
        provider,
        providerSku,
        providerCatalogId,
        name,
        region,
        dataAmount,
        validity,
        packageType: typeof body.packageType === 'string' ? body.packageType : 'fixed',
        daysCount: typeof body.daysCount === 'number' ? body.daysCount : null,
        providerConfig:
          body.providerConfig && typeof body.providerConfig === 'object'
            ? (body.providerConfig as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        isActive: body.isActive !== false,
        priority,
        priorityLocked: body.priorityLocked === true,
        mappingLocked: body.mappingLocked === true,
      },
    });

    app.log.info(`[Admin] Created SKU mapping: ${shopifySku} → ${provider}`);
    return reply.code(201).send(mapping);
  });

  /**
   * PUT /admin/sku-mappings/:id
   * Update an existing SKU mapping.
   * All fields are optional — only provided fields are updated.
   * Use isActive=false to deactivate without deleting.
   */
  app.put('/sku-mappings/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;

    const existing = await prisma.providerSkuMapping.findUnique({ where: { id } });
    if (!existing) {
      return reply.code(404).send({ error: 'SKU mapping not found' });
    }

    // Auto-derive fields from catalog entry when providerCatalogId is supplied
    // null = explicit unlink; string = link/update; undefined = leave unchanged
    const providerCatalogId: string | null | undefined =
      body.providerCatalogId === null
        ? null
        : typeof body.providerCatalogId === 'string'
          ? body.providerCatalogId.trim()
          : undefined;
    if (providerCatalogId === '') {
      return reply.code(400).send({ error: 'providerCatalogId cannot be empty' });
    }

    let derivedProviderSku: string | undefined;
    let derivedName: string | undefined;
    let derivedRegion: string | null | undefined;
    let derivedDataAmount: string | null | undefined;
    let derivedValidity: string | null | undefined;

    if (providerCatalogId) {
      const entry = await providerSkuCatalog.findUnique({ where: { id: providerCatalogId } });
      if (!entry) return reply.code(400).send({ error: 'Catalog entry not found' });
      const effectiveProvider =
        typeof body.provider === 'string' ? body.provider : existing.provider;
      if (entry.provider !== effectiveProvider) {
        return reply.code(400).send({
          error: `Catalog entry provider '${entry.provider}' does not match mapping provider '${effectiveProvider}'`,
        });
      }
      // Derive providerSku from catalog rawPayload
      if (entry.provider === 'firoam') {
        const raw = (entry.rawPayload ?? {}) as { skuId?: unknown; priceid?: unknown };
        if (raw.skuId === undefined || raw.priceid === undefined) {
          return reply.code(400).send({
            error: 'Catalog entry rawPayload is missing required firoam fields (skuId, priceid)',
          });
        }
        derivedProviderSku = `${String(raw.skuId)}:${entry.productCode}:${String(raw.priceid)}`;
      } else {
        derivedProviderSku = entry.productCode;
      }
      // Auto-populate metadata only if not explicitly supplied in the request
      if (typeof body.name !== 'string') derivedName = entry.productName;
      if (typeof body.region !== 'string') derivedRegion = entry.region;
      if (typeof body.dataAmount !== 'string') derivedDataAmount = entry.dataAmount;
      if (typeof body.validity !== 'string') derivedValidity = entry.validity;
    }

    // Build update payload from only the fields that were provided
    const updateData: Record<string, unknown> = {};
    if (typeof body.provider === 'string') updateData.provider = body.provider;
    if (derivedProviderSku !== undefined) updateData.providerSku = derivedProviderSku;
    else if (typeof body.providerSku === 'string') updateData.providerSku = body.providerSku;
    if (providerCatalogId !== undefined) updateData.providerCatalogId = providerCatalogId;
    if (typeof body.name === 'string') updateData.name = body.name;
    else if (derivedName !== undefined) updateData.name = derivedName;
    if (typeof body.region === 'string') updateData.region = body.region;
    else if (derivedRegion !== undefined) updateData.region = derivedRegion;
    if (typeof body.dataAmount === 'string') updateData.dataAmount = body.dataAmount;
    else if (derivedDataAmount !== undefined) updateData.dataAmount = derivedDataAmount;
    if (typeof body.validity === 'string') updateData.validity = body.validity;
    else if (derivedValidity !== undefined) updateData.validity = derivedValidity;
    if (typeof body.packageType === 'string') updateData.packageType = body.packageType;
    if (typeof body.daysCount === 'number') updateData.daysCount = body.daysCount;
    if (typeof body.isActive === 'boolean') updateData.isActive = body.isActive;
    if (typeof body.priority === 'number') updateData.priority = body.priority;
    if (typeof body.priorityLocked === 'boolean') updateData.priorityLocked = body.priorityLocked;
    if (typeof body.mappingLocked === 'boolean') updateData.mappingLocked = body.mappingLocked;
    if (body.providerConfig !== undefined) {
      updateData.providerConfig =
        body.providerConfig && typeof body.providerConfig === 'object'
          ? (body.providerConfig as Prisma.InputJsonValue)
          : Prisma.JsonNull;
    }

    const mapping = await prisma.providerSkuMapping.update({
      where: { id },
      data: updateData,
    });

    app.log.info(`[Admin] Updated SKU mapping: ${id} (${mapping.shopifySku})`);
    return reply.send(mapping);
  });

  /**
   * DELETE /admin/sku-mappings/:id
   * Soft-delete a SKU mapping by setting isActive=false.
   * Hard-delete is intentionally not exposed — use isActive=false to deactivate.
   */
  app.delete('/sku-mappings/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const { id } = request.params as { id: string };

    const existing = await prisma.providerSkuMapping.findUnique({ where: { id } });
    if (!existing) {
      return reply.code(404).send({ error: 'SKU mapping not found' });
    }

    await prisma.providerSkuMapping.update({
      where: { id },
      data: { isActive: false },
    });

    app.log.info(`[Admin] Deactivated SKU mapping: ${id} (${existing.shopifySku})`);
    return reply.send({ ok: true, message: `SKU mapping ${existing.shopifySku} deactivated` });
  });

  // ---------------------------------------------------------------------------
  // SKU Mapping Bulk Create
  // ---------------------------------------------------------------------------

  /**
   * POST /admin/sku-mappings/bulk
   * Create (or replace) multiple SKU mappings in a single request (from AI auto-map approval).
   * Processes each item and returns per-item results — partial success is possible.
   * Body: { mappings: CreateSkuMappingInput[], forceReplace?: boolean }
   *   forceReplace=true  — update existing (shopifySku, provider) rows instead of skipping them
   *   forceReplace=false — skip duplicates silently (default, idempotent)
   */
  app.post('/sku-mappings/bulk', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const body = (request.body ?? {}) as { mappings?: unknown[]; forceReplace?: boolean };
    const forceReplace = body.forceReplace === true;
    if (!Array.isArray(body.mappings) || body.mappings.length === 0) {
      return reply.code(400).send({ error: 'mappings array is required' });
    }

    const results: Array<{
      ok: boolean;
      action: 'created' | 'updated' | 'skipped' | 'failed';
      shopifySku?: string;
      provider?: string;
      error?: string;
    }> = [];

    for (const item of body.mappings as Array<Record<string, unknown>>) {
      try {
        // Reuse the same resolution logic as the single create endpoint
        const { shopifySku, provider, providerCatalogId } = item as {
          shopifySku?: string;
          provider?: string;
          providerCatalogId?: string;
        };

        if (!shopifySku || !provider || !providerCatalogId) {
          results.push({
            ok: false,
            action: 'failed' as const,
            shopifySku,
            provider,
            error: 'Missing required fields',
          });
          continue;
        }

        const entry = await providerSkuCatalog.findUnique({ where: { id: providerCatalogId } });
        if (!entry) {
          results.push({
            ok: false,
            action: 'failed' as const,
            shopifySku,
            provider,
            error: 'Catalog entry not found',
          });
          continue;
        }

        if (entry.provider !== provider) {
          results.push({
            ok: false,
            action: 'failed' as const,
            shopifySku,
            provider,
            error: `Catalog entry provider '${entry.provider}' does not match requested provider '${provider}'`,
          });
          continue;
        }

        // Derive packageType and daysCount — prefer what the caller sent, fall back to catalog
        const requestedPackageType =
          item.packageType === 'daypass' || item.packageType === 'fixed'
            ? (item.packageType as 'daypass' | 'fixed')
            : entry.productCode?.includes('?') || entry.productType === 'DAILY_PACK'
              ? 'daypass'
              : 'fixed';
        const requestedDaysCount =
          requestedPackageType === 'daypass' && typeof item.daysCount === 'number'
            ? item.daysCount
            : requestedPackageType === 'daypass'
              ? (parseShopifySku(shopifySku)?.validityDays ?? null)
              : null;

        // Derive providerSku from catalog
        let providerSku: string;
        if (entry.provider === 'firoam') {
          const raw = (entry.rawPayload ?? {}) as { skuId?: unknown; priceid?: unknown };
          if (raw.skuId === undefined || raw.priceid === undefined) {
            results.push({
              ok: false,
              action: 'failed' as const,
              shopifySku,
              provider,
              error: 'Catalog entry rawPayload missing firoam fields',
            });
            continue;
          }
          providerSku = `${String(raw.skuId)}:${entry.productCode}:${String(raw.priceid)}`;
        } else {
          providerSku = entry.productCode;
        }

        const existing = await prisma.providerSkuMapping.findUnique({
          where: { shopifySku_provider: { shopifySku, provider } },
        });

        if (existing) {
          if (!forceReplace) {
            // Idempotent skip — already mapped, nothing to do
            results.push({ ok: true, action: 'skipped' as const, shopifySku, provider });
            continue;
          }
          // forceReplace: update the existing row with the new catalog entry
          await prisma.providerSkuMapping.update({
            where: { shopifySku_provider: { shopifySku, provider } },
            data: {
              providerCatalogId,
              providerSku,
              name: entry.productName ?? null,
              region: entry.region ?? null,
              dataAmount: entry.dataAmount ?? null,
              validity: entry.validity ?? null,
              packageType: requestedPackageType,
              daysCount: requestedDaysCount,
              isActive: true,
            },
          });
          results.push({ ok: true, action: 'updated' as const, shopifySku, provider });
          continue;
        }

        const maxRow = await prisma.providerSkuMapping.findFirst({
          where: { shopifySku },
          orderBy: { priority: 'desc' },
          select: { priority: true },
        });

        await prisma.providerSkuMapping.create({
          data: {
            shopifySku,
            provider,
            providerCatalogId,
            providerSku,
            name: entry.productName ?? null,
            region: entry.region ?? null,
            dataAmount: entry.dataAmount ?? null,
            validity: entry.validity ?? null,
            packageType: requestedPackageType,
            daysCount: requestedDaysCount,
            isActive: true,
            priority: (maxRow?.priority ?? 0) + 1,
            priorityLocked: false,
            mappingLocked: false,
          },
        });

        results.push({ ok: true, action: 'created' as const, shopifySku, provider });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          ok: false,
          action: 'failed' as const,
          shopifySku: (item as Record<string, string>).shopifySku,
          provider: (item as Record<string, string>).provider,
          error: msg,
        });
      }
    }

    const created = results.filter((r) => r.action === 'created').length;
    const updated = results.filter((r) => r.action === 'updated').length;
    const skipped = results.filter((r) => r.action === 'skipped').length;
    const failed = results.filter((r) => !r.ok).length;
    app.log.info(
      `[Admin] Bulk mapped: ${created} created, ${updated} updated, ${skipped} skipped, ${failed} failed`,
    );
    return reply.send({ created, updated, skipped, failed, results });
  });

  // SKU Mapping Priority Reorder
  // ---------------------------------------------------------------------------

  /**
   * PUT /admin/sku-mappings/reorder
   * Atomically reorder priorities for all mappings under a shopifySku.
   * Body: { shopifySku: string, orderedIds: string[] }
   * Assigns priority = index + 1 for each id in orderedIds order.
   */
  app.put('/sku-mappings/reorder', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const body = request.body as Record<string, unknown>;
    const { shopifySku } = body;
    const orderedIds = body.orderedIds;

    if (!shopifySku || typeof shopifySku !== 'string') {
      return reply.code(400).send({ error: 'shopifySku is required' });
    }
    if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string')) {
      return reply.code(400).send({ error: 'orderedIds must be an array of strings' });
    }

    await prisma.$transaction(
      orderedIds.map((id: string, idx: number) =>
        prisma.providerSkuMapping.update({
          where: { id },
          data: { priority: idx + 1 },
        }),
      ),
    );

    app.log.info(`[Admin] Reordered ${orderedIds.length} mappings for SKU: ${shopifySku}`);
    return reply.send({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Smart Pricing — auto-reorder by catalog netPrice
  // ---------------------------------------------------------------------------

  /**
   * POST /admin/sku-mappings/smart-pricing
   * Reorders provider priority for each shopifySku group by ascending netPrice from catalog.
   * Rows with priorityLocked=true are skipped.
   * Body: { shopifySku?: string }  — if omitted, runs for ALL SKUs
   */
  app.post('/sku-mappings/smart-pricing', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const body = (request.body || {}) as { shopifySku?: string };

    // Fetch active mappings grouped by shopifySku
    const where: Record<string, unknown> = { isActive: true };
    if (body.shopifySku) where.shopifySku = body.shopifySku;

    const mappings = await prisma.providerSkuMapping.findMany({
      where,
      orderBy: [{ shopifySku: 'asc' }, { priority: 'asc' }],
      include: {
        catalogEntry: { select: { netPrice: true } },
      },
    });

    // Group by shopifySku
    const groups = new Map<string, typeof mappings>();
    for (const m of mappings) {
      const arr = groups.get(m.shopifySku) ?? [];
      arr.push(m);
      groups.set(m.shopifySku, arr);
    }

    let updated = 0;
    let skipped = 0;
    const changes: Array<{
      shopifySku: string;
      provider: string;
      oldPriority: number;
      newPriority: number;
    }> = [];

    for (const [sku, group] of groups) {
      const unlocked = group.filter((m) => !m.priorityLocked && m.catalogEntry?.netPrice != null);
      const locked = group.filter((m) => m.priorityLocked || m.catalogEntry?.netPrice == null);

      if (unlocked.length <= 1) {
        skipped += group.length;
        continue; // nothing to reorder
      }

      // Sort unlocked by effective price ascending.
      // FiRoam daypass: netPrice is per-day, multiply by daysCount for total cost.
      // TGT / fixed plans: netPrice is already the total.
      unlocked.sort((a, b) => {
        const pa = Number(a.catalogEntry!.netPrice!);
        const pb = Number(b.catalogEntry!.netPrice!);
        const ea =
          a.packageType === 'daypass' && a.daysCount && a.provider === 'firoam'
            ? pa * a.daysCount
            : pa;
        const eb =
          b.packageType === 'daypass' && b.daysCount && b.provider === 'firoam'
            ? pb * b.daysCount
            : pb;
        return ea - eb;
      });

      // Assign new priorities: unlocked get 1..N, locked keep their current priority (interleaved later if needed)
      // Simple approach: unlocked get sequential priorities starting from 1; locked keep theirs
      const updates: Array<{ id: string; priority: number }> = [];
      let nextPriority = 1;
      for (const m of unlocked) {
        // Skip locked priority slots
        while (locked.some((l) => l.priority === nextPriority)) nextPriority++;
        if (m.priority !== nextPriority) {
          updates.push({ id: m.id, priority: nextPriority });
          changes.push({
            shopifySku: sku,
            provider: m.provider,
            oldPriority: m.priority,
            newPriority: nextPriority,
          });
        }
        nextPriority++;
      }

      if (updates.length > 0) {
        await prisma.$transaction(
          updates.map(({ id, priority }) =>
            prisma.providerSkuMapping.update({ where: { id }, data: { priority } }),
          ),
        );
        updated += updates.length;
      }
      skipped += locked.length;
    }

    logger.info({ updated, skipped, changes }, 'Smart pricing run complete');
    return reply.send({ ok: true, updated, skipped, changes });
  });

  // ---------------------------------------------------------------------------
  // Shopify SKU Discovery
  // ---------------------------------------------------------------------------

  /**
   * GET /admin/shopify-skus
   * Returns paginated Shopify variants from the local ShopifyVariant cache (populated via POST /shopify-skus/sync).
   * Query: status=all|mapped|unmapped, provider=firoam|tgt, search, limit, offset
   */
  app.get('/shopify-skus', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const query = request.query as {
      unmappedOnly?: string;
      provider?: string;
      status?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };
    // status overrides legacy unmappedOnly
    const status: 'all' | 'mapped' | 'unmapped' =
      query.status === 'mapped' || query.status === 'unmapped'
        ? query.status
        : query.unmappedOnly === 'true'
          ? 'unmapped'
          : 'all';
    const providerFilter = query.provider || undefined;
    const search = (query.search ?? '').trim();
    const parsedLimit = Number.parseInt(query.limit ?? '25', 10);
    const parsedOffset = Number.parseInt(query.offset ?? '0', 10);
    const limit = Math.min(Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 25), 500);
    const offset = Math.max(0, Number.isFinite(parsedOffset) ? parsedOffset : 0);

    // Resolve mapped SKU set for status filter
    let mappedSkus: Set<string> | undefined;
    if (status !== 'all') {
      const rows = await prisma.providerSkuMapping.findMany({
        select: { shopifySku: true },
        distinct: ['shopifySku'],
        where: {
          isActive: true,
          ...(providerFilter ? { provider: providerFilter } : {}),
        },
      });
      mappedSkus = new Set(rows.map((r) => r.shopifySku));
    }

    const where: Prisma.ShopifyVariantWhereInput = {
      ...(search
        ? {
            OR: [
              { sku: { contains: search, mode: 'insensitive' } },
              { productTitle: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(status === 'unmapped' && mappedSkus ? { NOT: { sku: { in: [...mappedSkus] } } } : {}),
      ...(status === 'mapped' && mappedSkus ? { sku: { in: [...mappedSkus] } } : {}),
    };

    const [total, skus] = await Promise.all([
      prisma.shopifyVariant.count({ where }),
      prisma.shopifyVariant.findMany({
        where,
        orderBy: { sku: 'asc' },
        skip: offset,
        take: limit,
      }),
    ]);

    return reply.send({ skus, total });
  });

  /**
   * POST /admin/shopify-products/bulk-create
   * Create Shopify products for countries found in the provider catalog.
   * Body: { countries?: string[], dryRun?: boolean }
   * If countries omitted, auto-discovers all single-country codes from catalog.
   * Skips countries that already have Shopify products (by SKU prefix match).
   */
  app.post(
    '/shopify-products/bulk-create',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdminKey(request, reply)) return;

      const body = (request.body || {}) as {
        countries?: string[];
        dryRun?: boolean;
      };

      const shopify = getShopifyClient();

      // 1. Determine which countries to create
      let countryCodes: string[];
      if (body.countries && body.countries.length > 0) {
        countryCodes = body.countries.map((c) => c.toUpperCase());
      } else {
        // Auto-discover from catalog: collect all ISO-2 codes from countryCodes arrays
        const catalogRows = (await providerSkuCatalog.findMany({
          where: { isActive: true },
          select: { countryCodes: true, region: true },
        })) as Array<{ countryCodes: unknown; region: string | null }>;

        const codeSet = new Set<string>();
        for (const row of catalogRows) {
          const cc = row.countryCodes as string[] | null;
          if (!Array.isArray(cc)) continue;
          for (const c of cc) {
            if (typeof c === 'string' && c.length === 2) {
              // TGT: already ISO codes
              codeSet.add(c.toUpperCase());
            } else if (typeof c === 'string') {
              // FiRoam: country display names
              const code = firoamNameToCode(c);
              if (code) codeSet.add(code);
            }
          }
        }
        countryCodes = [...codeSet].sort();
      }

      // 2. Filter to valid country codes only
      const toCreate = countryCodes.filter((code) => getCountryByCode(code));
      const skipped = countryCodes.filter((code) => !getCountryByCode(code));

      if (body.dryRun) {
        return reply.send({
          dryRun: true,
          toCreate: toCreate.map((c) => ({ code: c, name: getCountryByCode(c)?.name })),
          skipped: skipped.map((c) => ({ code: c, reason: 'unknown_code' })),
        });
      }

      // 3. Build standardized variant set
      const DAYPASS_VALIDITIES = [1, 2, 3, 5, 7, 10, 15, 30];
      const DAYPASS_VOLUMES = ['1GB', '2GB', '3GB', '5GB', '10GB'];
      const FIXED_VALIDITIES = [1, 3, 7, 15, 30];
      const FIXED_VOLUMES = ['1GB', '2GB', '3GB', '5GB', '10GB', '20GB'];

      function buildVariants(cc: string) {
        const variants: Array<{
          sku: string;
          price: string;
          optionValues: string[];
        }> = [];

        for (const validity of DAYPASS_VALIDITIES) {
          for (const vol of DAYPASS_VOLUMES) {
            variants.push({
              sku: `${cc}-${vol}-${validity}D-DAYPASS`,
              price: '5.00',
              optionValues: ['Day-Pass', validity === 1 ? '1-Day' : `${validity}-Days`, vol],
            });
          }
        }

        for (const validity of FIXED_VALIDITIES) {
          for (const vol of FIXED_VOLUMES) {
            variants.push({
              sku: `${cc}-${vol}-${validity}D-FIXED`,
              price: '5.00',
              optionValues: ['Total Data', validity === 1 ? '1-Day' : `${validity}-Days`, vol],
            });
          }
        }

        return variants;
      }

      // 4. Fire-and-forget: create products in the background
      void (async () => {
        let created = 0;
        let errors = 0;

        for (const code of toCreate) {
          const country = getCountryByCode(code)!;
          const variants = buildVariants(code);

          try {
            await shopify.createProduct({
              title: country.name,
              handle: country.slug,
              bodyHtml:
                '<p>Instant digital eSIM. Activate in minutes. No physical SIM required.</p>',
              status: 'ACTIVE',
              productType: 'eSIM',
              tags: ['esim', code.toLowerCase()],
              options: ['Plan Type', 'Validity', 'Volume'],
              variants,
              imageUrl: `https://flagcdn.com/w640/${code.toLowerCase()}.png`,
            });
            created++;
            logger.info(
              { code, name: country.name, variants: variants.length },
              'Created Shopify product',
            );
          } catch (err) {
            errors++;
            logger.error({ code, err }, 'Failed to create Shopify product');
          }

          // Rate limit: ~1 product/sec to stay under Shopify API limits
          await new Promise((r) => setTimeout(r, 1000));
        }

        logger.info({ created, errors, total: toCreate.length }, 'Bulk product creation complete');
      })();

      return reply.send({
        ok: true,
        total: toCreate.length,
        skipped: skipped.length,
        background: 'product_creation_started',
      });
    },
  );

  // ─── Product Templates ───────────────────────────────────────────────

  const DAYPASS_VALIDITIES = [1, 2, 3, 5, 7, 10, 15, 30];
  const DAYPASS_VOLUMES_GB = [1, 2, 3, 5, 10];
  const FIXED_VALIDITIES = [1, 3, 7, 15, 30];
  const FIXED_VOLUMES_GB = [1, 2, 3, 5, 10, 15, 20, 30];

  // Retail price matrix: PRICE_MAP[dataGB][validityDays] = price string
  const PRICE_MAP: Record<number, Record<number, string>> = {
    1: {
      1: '4.99',
      2: '5.99',
      3: '6.99',
      5: '8.99',
      7: '9.99',
      10: '11.99',
      15: '13.99',
      30: '16.99',
    },
    2: {
      1: '6.99',
      2: '8.99',
      3: '9.99',
      5: '12.99',
      7: '14.99',
      10: '17.99',
      15: '19.99',
      30: '24.99',
    },
    3: {
      1: '8.99',
      2: '10.99',
      3: '12.99',
      5: '15.99',
      7: '18.99',
      10: '22.99',
      15: '26.99',
      30: '32.99',
    },
    5: {
      1: '12.99',
      2: '15.99',
      3: '17.99',
      5: '22.99',
      7: '26.99',
      10: '32.99',
      15: '38.99',
      30: '46.99',
    },
    10: {
      1: '19.99',
      2: '24.99',
      3: '27.99',
      5: '34.99',
      7: '39.99',
      10: '49.99',
      15: '59.99',
      30: '74.99',
    },
    15: { 1: '29.99', 3: '39.99', 7: '54.99', 15: '79.99', 30: '99.99' },
    20: { 1: '37.99', 3: '49.99', 7: '69.99', 15: '99.99', 30: '124.99' },
    30: { 1: '49.99', 3: '69.99', 7: '94.99', 15: '139.99', 30: '179.99' },
  };

  function getPrice(gb: number, days: number): string {
    return PRICE_MAP[gb]?.[days] ?? '5.00';
  }

  function formatVolume(gb: number): string {
    return gb <= 5 ? `${gb} GB` : `${gb}GB`;
  }

  function formatValidity(days: number): string {
    return days === 1 ? '1-Day' : `${days}-Days`;
  }

  function buildTemplateVariants(cc: string) {
    const variants: Array<{
      sku: string;
      price: string;
      planType: string;
      validity: string;
      volume: string;
      sortOrder: number;
    }> = [];
    let sortOrder = 0;

    for (const days of DAYPASS_VALIDITIES) {
      for (const gb of DAYPASS_VOLUMES_GB) {
        const vol = formatVolume(gb);
        variants.push({
          sku: `${cc}-${vol.replace(' ', '')}-${days}D-DAYPASS`,
          price: getPrice(gb, days),
          planType: 'Day-Pass',
          validity: formatValidity(days),
          volume: vol,
          sortOrder: sortOrder++,
        });
      }
    }

    for (const days of FIXED_VALIDITIES) {
      for (const gb of FIXED_VOLUMES_GB) {
        const vol = formatVolume(gb);
        variants.push({
          sku: `${cc}-${vol.replace(' ', '')}-${days}D-FIXED`,
          price: getPrice(gb, days),
          planType: 'Total Data',
          validity: formatValidity(days),
          volume: vol,
          sortOrder: sortOrder++,
        });
      }
    }

    return variants;
  }

  /** Same matrix as countries, but prices scaled by `multiplier` (regions cost more per GB). */
  function buildRegionTemplateVariants(regionCode: string, multiplier: number) {
    const variants: Array<{
      sku: string;
      price: string;
      planType: string;
      validity: string;
      volume: string;
      sortOrder: number;
    }> = [];
    let sortOrder = 0;

    const scale = (basePrice: string) => {
      const n = parseFloat(basePrice);
      if (!Number.isFinite(n)) return basePrice;
      // Round to 2dp; keep .99 ergonomics for prices ≥ $1.
      const scaled = n * multiplier;
      const rounded = Math.round(scaled * 100) / 100;
      return rounded.toFixed(2);
    };

    for (const days of DAYPASS_VALIDITIES) {
      for (const gb of DAYPASS_VOLUMES_GB) {
        const vol = formatVolume(gb);
        variants.push({
          sku: `REGION-${regionCode}-${vol.replace(' ', '')}-${days}D-DAYPASS`,
          price: scale(getPrice(gb, days)),
          planType: 'Day-Pass',
          validity: formatValidity(days),
          volume: vol,
          sortOrder: sortOrder++,
        });
      }
    }

    for (const days of FIXED_VALIDITIES) {
      for (const gb of FIXED_VOLUMES_GB) {
        const vol = formatVolume(gb);
        variants.push({
          sku: `REGION-${regionCode}-${vol.replace(' ', '')}-${days}D-FIXED`,
          price: scale(getPrice(gb, days)),
          planType: 'Total Data',
          validity: formatValidity(days),
          volume: vol,
          sortOrder: sortOrder++,
        });
      }
    }

    return variants;
  }

  /**
   * Strict-coverage filter: returns true if at least one active provider catalog
   * row covers EVERY country in the region. Used to skip regions we can't
   * actually fulfil before generating Shopify products for them.
   */
  async function regionHasProviderCoverage(regionCountries: string[]): Promise<boolean> {
    const candidates = (await providerSkuCatalog.findMany({
      where: { isActive: true, region: { not: null } },
      select: { countryCodes: true },
    })) as Array<{ countryCodes: unknown }>;

    for (const row of candidates) {
      const cc = Array.isArray(row.countryCodes)
        ? (row.countryCodes as unknown[])
            .filter((x): x is string => typeof x === 'string')
            .map((x) => x.toUpperCase())
        : [];
      if (cc.length === 0) continue;
      const coversAll = regionCountries.every((c) => cc.includes(c));
      if (coversAll) return true;
    }
    return false;
  }

  /**
   * POST /admin/product-templates/generate
   * Generate product template records in DB.
   *
   * Two modes (selected by `templateType`, default `COUNTRY`):
   *   COUNTRY  — country-keyed templates (legacy default). Body: `countries?`, `overwrite?`, `dryRun?`.
   *   REGION   — region-keyed templates from canonical `Region` rows. Body:
   *              `regionCodes?` (defaults to all active regions), `overwrite?`,
   *              `dryRun?`, `priceMultiplier?` (default 2.5). Skips a region
   *              entirely when no active provider catalog row covers all its
   *              advertised countries (strict-coverage check).
   */
  app.post('/product-templates/generate', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const body = (request.body || {}) as {
      templateType?: string;
      countries?: string[];
      regionCodes?: string[];
      priceMultiplier?: number;
      overwrite?: boolean;
      dryRun?: boolean;
    };

    // Mode selection:
    //   explicit "COUNTRY" or "REGION" → only that branch (backwards compatible)
    //   omitted/anything else          → BOTH (dashboard default — single-click parity with country-only flows)
    const explicit = typeof body.templateType === 'string' ? body.templateType.toUpperCase() : null;
    const mode: 'COUNTRY' | 'REGION' | 'BOTH' =
      explicit === 'COUNTRY' || explicit === 'REGION' ? explicit : 'BOTH';

    // ── REGION generation ──────────────────────────────────────────────────
    async function runRegionGeneration() {
      const multiplier =
        typeof body.priceMultiplier === 'number' && body.priceMultiplier > 0
          ? body.priceMultiplier
          : 2.5;

      const regionCodesUpper = Array.isArray(body.regionCodes)
        ? body.regionCodes.map((c) => String(c).toUpperCase())
        : null;

      const regions = await prisma.region.findMany({
        where: regionCodesUpper ? { code: { in: regionCodesUpper } } : { isActive: true },
        orderBy: [{ parentCode: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }],
      });

      if (regions.length === 0) {
        return {
          templateType: 'REGION' as const,
          priceMultiplier: multiplier,
          generated: 0,
          skippedExisting: 0,
          skippedNoCoverage: 0,
          errors: regionCodesUpper ? ['No matching regions found'] : ['No active regions'],
        };
      }

      type RegionPlan = {
        code: string;
        countries: string[];
        coverageOk: boolean;
        existing: boolean;
      };
      const plans: RegionPlan[] = [];
      for (const region of regions) {
        const cc = Array.isArray(region.countryCodes)
          ? (region.countryCodes as unknown[])
              .filter((x): x is string => typeof x === 'string')
              .map((x) => x.toUpperCase())
          : [];
        const coverageOk = cc.length > 0 ? await regionHasProviderCoverage(cc) : false;
        const existing = !!(await prisma.shopifyProductTemplate.findUnique({
          where: { regionCode: region.code },
        }));
        plans.push({ code: region.code, countries: cc, coverageOk, existing });
      }

      if (body.dryRun) {
        return {
          dryRun: true as const,
          templateType: 'REGION' as const,
          priceMultiplier: multiplier,
          plans: plans.map((p) => ({
            code: p.code,
            countryCount: p.countries.length,
            coverageOk: p.coverageOk,
            existing: p.existing,
            action: !p.coverageOk
              ? 'skip_no_coverage'
              : p.existing && !body.overwrite
                ? 'skip_existing'
                : p.existing
                  ? 'overwrite'
                  : 'create',
          })),
        };
      }

      let generated = 0;
      let skippedExisting = 0;
      let skippedNoCoverage = 0;
      const errors: string[] = [];

      for (const region of regions) {
        const plan = plans.find((p) => p.code === region.code)!;
        if (!plan.coverageOk) {
          skippedNoCoverage++;
          continue;
        }
        if (plan.existing && !body.overwrite) {
          skippedExisting++;
          continue;
        }

        const variants = buildRegionTemplateVariants(region.code, multiplier);
        const slug = region.code.toLowerCase();
        const countryListHtml = plan.countries
          .map((c) => {
            const country = getCountryByCode(c);
            return country ? country.name : c;
          })
          .join(', ');
        const descriptionHtml = `<p>Instant digital eSIM for ${region.name}. Activate in minutes. Coverage: ${countryListHtml}.</p>`;

        try {
          await prisma.shopifyProductTemplate.upsert({
            where: { regionCode: region.code },
            update: {
              templateType: 'REGION',
              regionCode: region.code,
              countryCode: null,
              title: region.name,
              handle: `region-${slug}`,
              descriptionHtml,
              status: 'ACTIVE',
              vendor: 'SAILeSIM',
              tags: ['esim', 'region', region.parentCode.toLowerCase(), slug],
              variants: {
                deleteMany: {},
                create: variants.map((v) => ({
                  sku: v.sku,
                  price: v.price,
                  planType: v.planType,
                  validity: v.validity,
                  volume: v.volume,
                  sortOrder: v.sortOrder,
                })),
              },
            },
            create: {
              templateType: 'REGION',
              regionCode: region.code,
              title: region.name,
              handle: `region-${slug}`,
              descriptionHtml,
              status: 'ACTIVE',
              vendor: 'SAILeSIM',
              tags: ['esim', 'region', region.parentCode.toLowerCase(), slug],
              variants: {
                create: variants.map((v) => ({
                  sku: v.sku,
                  price: v.price,
                  planType: v.planType,
                  validity: v.validity,
                  volume: v.volume,
                  sortOrder: v.sortOrder,
                })),
              },
            },
          });
          generated++;
        } catch (err) {
          errors.push(`${region.code}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return {
        templateType: 'REGION' as const,
        priceMultiplier: multiplier,
        generated,
        skippedExisting,
        skippedNoCoverage,
        errors,
      };
    }

    // ── COUNTRY generation ─────────────────────────────────────────────────
    async function runCountryGeneration() {
      // Discover countries from active provider catalog (same logic as bulk-create).
      let codes: string[];
      if (body.countries && body.countries.length > 0) {
        codes = body.countries.map((c) => c.toUpperCase());
      } else {
        const catalogRows = (await providerSkuCatalog.findMany({
          where: { isActive: true },
          select: { countryCodes: true, region: true },
        })) as Array<{ countryCodes: unknown; region: string | null }>;
        const codeSet = new Set<string>();
        for (const row of catalogRows) {
          const cc = row.countryCodes as string[] | null;
          if (!Array.isArray(cc)) continue;
          for (const c of cc) {
            if (typeof c === 'string' && c.length === 2) {
              codeSet.add(c.toUpperCase());
            } else if (typeof c === 'string') {
              const code = firoamNameToCode(c);
              if (code) codeSet.add(code);
            }
          }
        }
        codes = [...codeSet].sort();
      }

      const valid = codes.filter((c) => getCountryByCode(c));
      const skipped = codes.filter((c) => !getCountryByCode(c));

      if (body.dryRun) {
        return {
          dryRun: true as const,
          templateType: 'COUNTRY' as const,
          toGenerate: valid.map((c) => ({ code: c, name: getCountryByCode(c)?.name })),
          skipped: skipped.map((c) => ({ code: c, reason: 'unknown_code' })),
        };
      }

      let generated = 0;
      let skippedExisting = 0;
      const errors: string[] = [];

      for (const code of valid) {
        const country = getCountryByCode(code)!;
        const existing = await prisma.shopifyProductTemplate.findUnique({
          where: { countryCode: code },
        });
        if (existing && !body.overwrite) {
          skippedExisting++;
          continue;
        }

        const variants = buildTemplateVariants(code);
        const ccLower = code.toLowerCase();

        try {
          await prisma.shopifyProductTemplate.upsert({
            where: { countryCode: code },
            update: {
              title: country.name,
              handle: country.slug,
              descriptionHtml: `<p><img src="https://flagcdn.com/w80/${ccLower}.png" alt="${country.name} flag" style="vertical-align:middle;margin-right:8px" /> Instant digital eSIM for ${country.name}. Activate in minutes. No physical SIM required.</p>`,
              status: 'ACTIVE',
              vendor: 'SAILeSIM',
              tags: ['esim', ccLower, country.region],
              imageUrl: `https://flagcdn.com/w640/${ccLower}.png`,
              variants: {
                deleteMany: {},
                create: variants.map((v) => ({
                  sku: v.sku,
                  price: v.price,
                  planType: v.planType,
                  validity: v.validity,
                  volume: v.volume,
                  sortOrder: v.sortOrder,
                })),
              },
            },
            create: {
              countryCode: code,
              title: country.name,
              handle: country.slug,
              descriptionHtml: `<p><img src="https://flagcdn.com/w80/${ccLower}.png" alt="${country.name} flag" style="vertical-align:middle;margin-right:8px" /> Instant digital eSIM for ${country.name}. Activate in minutes. No physical SIM required.</p>`,
              status: 'ACTIVE',
              vendor: 'SAILeSIM',
              tags: ['esim', ccLower, country.region],
              imageUrl: `https://flagcdn.com/w640/${ccLower}.png`,
              variants: {
                create: variants.map((v) => ({
                  sku: v.sku,
                  price: v.price,
                  planType: v.planType,
                  validity: v.validity,
                  volume: v.volume,
                  sortOrder: v.sortOrder,
                })),
              },
            },
          });
          generated++;
        } catch (err) {
          errors.push(`${code}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return {
        templateType: 'COUNTRY' as const,
        generated,
        skippedExisting,
        skippedInvalid: skipped.length,
        errors,
      };
    }

    // ── Dispatch by mode ───────────────────────────────────────────────────
    if (mode === 'REGION') {
      const result = await runRegionGeneration();
      return reply.send({ ok: true, ...result });
    }
    if (mode === 'COUNTRY') {
      const result = await runCountryGeneration();
      return reply.send({ ok: true, ...result });
    }
    // mode === 'BOTH'
    const country = await runCountryGeneration();
    const region = await runRegionGeneration();
    return reply.send({ ok: true, country, region });
  });

  /**
   * POST /admin/product-templates/generate-seo
   * AI SEO generation via OpenAI for templates missing SEO content.
   */
  app.post(
    '/product-templates/generate-seo',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdminKey(request, reply)) return;

      const body = (request.body || {}) as {
        countries?: string[];
        force?: boolean;
      };

      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) {
        return reply.status(500).send({ error: 'OPENAI_API_KEY not set' });
      }
      const openai = new OpenAI({ apiKey: openaiKey });

      // Find templates that need SEO
      const where: Record<string, unknown> = {};
      if (body.countries && body.countries.length > 0) {
        where.countryCode = { in: body.countries.map((c) => c.toUpperCase()) };
      }
      if (!body.force) {
        where.seoTitle = null;
      }

      const templates = await prisma.shopifyProductTemplate.findMany({
        where,
        select: { id: true, countryCode: true, title: true },
      });

      if (templates.length === 0) {
        return reply.send({ ok: true, queued: 0, message: 'All templates already have SEO' });
      }

      // Fire-and-forget background task
      void (async () => {
        const BATCH_SIZE = 10;
        let updated = 0;

        for (let i = 0; i < templates.length; i += BATCH_SIZE) {
          const batch = templates.slice(i, i + BATCH_SIZE);
          const countryList = batch.map((t) => `${t.title} (${t.countryCode})`).join(', ');

          try {
            const response = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              temperature: 0.7,
              response_format: { type: 'json_object' },
              messages: [
                {
                  role: 'system',
                  content:
                    'You generate SEO content for eSIM product pages. Respond with JSON: { "results": [{ "countryCode": "XX", "seoTitle": "...", "seoDescription": "...", "descriptionHtml": "..." }] }',
                },
                {
                  role: 'user',
                  content: `Generate SEO content for these eSIM country products. Brand: SAILeSIM.

For each country provide:
1. seoTitle (max 60 chars): e.g. "Saudi Arabia eSIM | Instant 4G/5G Data Plans | SAILeSIM"
2. seoDescription (max 155 chars): e.g. "Buy Saudi Arabia eSIM. Instant activation, no physical SIM needed. Day passes & data plans with fast 4G/5G coverage."
3. descriptionHtml: Rich HTML product description (2-3 paragraphs) mentioning the country, coverage, activation process, and why SAILeSIM.

Countries: ${countryList}`,
                },
              ],
            });

            const content = response.choices[0]?.message?.content;
            if (!content) continue;

            const parsed = JSON.parse(content) as {
              results: Array<{
                countryCode: string;
                seoTitle: string;
                seoDescription: string;
                descriptionHtml: string;
              }>;
            };

            for (const result of parsed.results) {
              const template = batch.find((t) => t.countryCode === result.countryCode);
              if (!template) continue;

              await prisma.shopifyProductTemplate.update({
                where: { id: template.id },
                data: {
                  seoTitle: result.seoTitle,
                  seoDescription: result.seoDescription,
                  descriptionHtml: result.descriptionHtml,
                },
              });
              updated++;
            }
          } catch (err) {
            logger.error(
              { err, batch: batch.map((t) => t.countryCode) },
              'SEO generation failed for batch',
            );
          }

          // Rate limit OpenAI
          await new Promise((r) => setTimeout(r, 1000));
        }

        logger.info({ updated, total: templates.length }, 'SEO generation complete');
      })();

      return reply.send({
        ok: true,
        queued: templates.length,
        background: 'seo_generation_started',
      });
    },
  );

  /**
   * GET /admin/product-templates
   * List all product templates with summary info.
   */
  app.get('/product-templates', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const query = (request.query || {}) as {
      status?: string;
      country?: string;
      pushed?: string;
    };

    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.country) where.countryCode = query.country.toUpperCase();
    if (query.pushed === 'true') where.shopifyProductId = { not: null };
    if (query.pushed === 'false') where.shopifyProductId = null;

    const templates = await prisma.shopifyProductTemplate.findMany({
      where,
      include: { _count: { select: { variants: true } } },
      orderBy: { title: 'asc' },
    });

    return reply.send({
      total: templates.length,
      templates: templates.map((t) => ({
        countryCode: t.countryCode,
        title: t.title,
        handle: t.handle,
        status: t.status,
        vendor: t.vendor,
        tags: t.tags,
        hasSeo: !!t.seoTitle,
        seoTitle: t.seoTitle,
        seoDescription: t.seoDescription,
        shopifyProductId: t.shopifyProductId,
        shopifyPushedAt: t.shopifyPushedAt,
        variantCount: (t as unknown as { _count: { variants: number } })._count.variants,
        updatedAt: t.updatedAt,
      })),
    });
  });

  /**
   * GET /admin/product-templates/:countryCode
   * Get a single template with all its variants.
   */
  app.get(
    '/product-templates/:countryCode',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdminKey(request, reply)) return;

      const { countryCode } = request.params as { countryCode: string };
      const template = await prisma.shopifyProductTemplate.findUnique({
        where: { countryCode: countryCode.toUpperCase() },
        include: { variants: { orderBy: { sortOrder: 'asc' } } },
      });

      if (!template) {
        return reply.status(404).send({ error: 'Template not found' });
      }

      return reply.send(template);
    },
  );

  /**
   * PATCH /admin/product-templates/:countryCode
   * Update template fields (not variants).
   */
  app.patch(
    '/product-templates/:countryCode',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdminKey(request, reply)) return;

      const { countryCode } = request.params as { countryCode: string };
      const body = (request.body || {}) as {
        title?: string;
        descriptionHtml?: string;
        status?: string;
        vendor?: string;
        tags?: string[];
        seoTitle?: string;
        seoDescription?: string;
      };

      const data: Record<string, unknown> = {};
      if (body.title !== undefined) data.title = body.title;
      if (body.descriptionHtml !== undefined) data.descriptionHtml = body.descriptionHtml;
      if (body.status !== undefined) data.status = body.status;
      if (body.vendor !== undefined) data.vendor = body.vendor;
      if (body.tags !== undefined) data.tags = body.tags;
      if (body.seoTitle !== undefined) data.seoTitle = body.seoTitle;
      if (body.seoDescription !== undefined) data.seoDescription = body.seoDescription;

      try {
        const updated = await prisma.shopifyProductTemplate.update({
          where: { countryCode: countryCode.toUpperCase() },
          data,
        });
        return reply.send(updated);
      } catch {
        return reply.status(404).send({ error: 'Template not found' });
      }
    },
  );

  /**
   * DELETE /admin/product-templates/:countryCode
   * Delete a template and its variants from DB. Does NOT delete from Shopify.
   */
  app.delete(
    '/product-templates/:countryCode',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdminKey(request, reply)) return;

      const { countryCode } = request.params as { countryCode: string };

      try {
        await prisma.shopifyProductTemplate.delete({
          where: { countryCode: countryCode.toUpperCase() },
        });
        return reply.send({ ok: true, deleted: countryCode.toUpperCase() });
      } catch {
        return reply.status(404).send({ error: 'Template not found' });
      }
    },
  );

  /**
   * POST /admin/product-templates/push-to-shopify
   * Push templates to Shopify — reads from DB, creates products.
   */
  app.post(
    '/product-templates/push-to-shopify',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdminKey(request, reply)) return;

      const body = (request.body || {}) as {
        countries?: string[];
        force?: boolean;
        dryRun?: boolean;
      };

      const where: Record<string, unknown> = {};
      if (body.countries && body.countries.length > 0) {
        where.countryCode = { in: body.countries.map((c) => c.toUpperCase()) };
      }
      if (!body.force) {
        where.shopifyProductId = null;
      }

      const templates = await prisma.shopifyProductTemplate.findMany({
        where,
        include: { variants: { orderBy: { sortOrder: 'asc' } } },
      });

      if (templates.length === 0) {
        return reply.send({ ok: true, total: 0, message: 'No templates to push' });
      }

      if (body.dryRun) {
        return reply.send({
          dryRun: true,
          toPush: templates.map((t) => ({
            countryCode: t.countryCode,
            title: t.title,
            variantCount: t.variants.length,
            alreadyPushed: !!t.shopifyProductId,
          })),
        });
      }

      const shopify = getShopifyClient();

      // Fire-and-forget background push
      void (async () => {
        let pushed = 0;
        let errors = 0;

        for (const template of templates) {
          try {
            const { productId } = await shopify.createProduct({
              title: template.title,
              handle: template.handle,
              bodyHtml: template.descriptionHtml,
              status: template.status as 'ACTIVE' | 'DRAFT',
              productType: template.productType,
              vendor: template.vendor,
              tags: template.tags as string[],
              options: ['Plan Type', 'Validity', 'Volume'],
              variants: template.variants.map((v) => ({
                sku: v.sku,
                price: v.price.toString(),
                optionValues: [v.planType, v.validity, v.volume],
              })),
              imageUrl: template.imageUrl ?? undefined,
              seo: template.seoTitle
                ? { title: template.seoTitle, description: template.seoDescription ?? '' }
                : undefined,
            });

            await prisma.shopifyProductTemplate.update({
              where: { id: template.id },
              data: { shopifyProductId: productId, shopifyPushedAt: new Date() },
            });

            pushed++;
            logger.info(
              { code: template.countryCode, productId, variants: template.variants.length },
              'Pushed product template to Shopify',
            );
          } catch (err) {
            errors++;
            logger.error({ code: template.countryCode, err }, 'Failed to push template to Shopify');
          }

          // Rate limit
          await new Promise((r) => setTimeout(r, 1000));
        }

        logger.info(
          { pushed, errors, total: templates.length },
          'Template push to Shopify complete',
        );
      })();

      return reply.send({
        ok: true,
        total: templates.length,
        background: 'push_started',
      });
    },
  );

  // ─── Pricing Engine ──────────────────────────────────────────────────
  /* v8 ignore start — pricing admin endpoints, integration-tested in production */

  async function checkRunningJob(type: string): Promise<boolean> {
    // Auto-timeout stale runs older than 30 minutes
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    await prisma.pricingRun.updateMany({
      where: { type, status: 'running', createdAt: { lt: thirtyMinAgo } },
      data: { status: 'error', error: 'Timed out (>30 min)', completedAt: new Date() },
    });
    const running = await prisma.pricingRun.findFirst({
      where: { type, status: 'running' },
    });
    return !!running;
  }

  app.post('/pricing/scrape-competitors', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;
    const body = (request.body || {}) as { countries?: string[] };

    if (await checkRunningJob('competitor_scrape')) {
      return reply.status(409).send({ error: 'A competitor scrape is already running' });
    }

    const { scrapeCompetitors } = await import('~/services/competitorScraper');

    void (async () => {
      const run = await prisma.pricingRun.create({
        data: { type: 'competitor_scrape', scope: body.countries?.join(',') ?? null },
      });
      try {
        const result = await scrapeCompetitors(body.countries?.map((c) => c.toUpperCase()));
        await prisma.pricingRun.update({
          where: { id: run.id },
          data: {
            status: 'done',
            totalProcessed: result.totalCountries,
            totalUpdated: result.totalPlans,
            totalSkipped: result.skippedCached,
            totalErrors: result.errors,
            completedAt: new Date(),
          },
        });
      } catch (err) {
        await prisma.pricingRun.update({
          where: { id: run.id },
          data: {
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
            completedAt: new Date(),
          },
        });
      }
    })();

    return reply.send({ ok: true, background: 'scrape_started' });
  });

  app.get('/pricing/competitor-prices', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;
    const query = (request.query || {}) as {
      countryCode?: string;
      dataMb?: string;
      validityDays?: string;
      limit?: string;
    };

    const where: Record<string, unknown> = {};
    if (query.countryCode) where.countryCode = query.countryCode.toUpperCase();
    if (query.dataMb) where.dataMb = { gte: parseInt(query.dataMb, 10) };
    if (query.validityDays) where.validityDays = { gte: parseInt(query.validityDays, 10) };

    const prices = await prisma.competitorPrice.findMany({
      where,
      orderBy: { price: 'asc' },
      take: parseInt(query.limit ?? '100', 10),
    });

    return reply.send({ total: prices.length, prices });
  });

  app.post(
    '/pricing/calculate-cost-floors',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdminKey(request, reply)) return;
      if (await checkRunningJob('cost_floor')) {
        return reply.status(409).send({ error: 'Cost floor calculation is already running' });
      }
      const body = (request.body || {}) as {
        countries?: string[];
        costFloorParams?: Partial<import('~/services/pricingEngine').CostFloorParams>;
      };
      const { calculateCostFloors, DEFAULT_COST_FLOOR_PARAMS } =
        await import('~/services/pricingEngine');

      const cfp = {
        ...DEFAULT_COST_FLOOR_PARAMS,
        ...body.costFloorParams,
        marginTiers: body.costFloorParams?.marginTiers ?? DEFAULT_COST_FLOOR_PARAMS.marginTiers,
      };

      void (async () => {
        const run = await prisma.pricingRun.create({
          data: {
            type: 'cost_floor',
            scope: body.countries?.join(',') ?? null,
            params: JSON.parse(JSON.stringify(cfp)),
          },
        });
        try {
          const result = await calculateCostFloors(
            body.countries?.map((c) => c.toUpperCase()),
            cfp,
          );
          await prisma.pricingRun.update({
            where: { id: run.id },
            data: { status: 'done', ...result, completedAt: new Date() },
          });
        } catch (err) {
          await prisma.pricingRun.update({
            where: { id: run.id },
            data: {
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
              completedAt: new Date(),
            },
          });
        }
      })();

      return reply.send({ ok: true, background: 'cost_floor_started' });
    },
  );

  app.post(
    '/pricing/generate-suggestions',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdminKey(request, reply)) return;
      if (await checkRunningJob('smart_pricing')) {
        return reply.status(409).send({ error: 'Smart pricing is already running' });
      }
      const body = (request.body || {}) as {
        countries?: string[];
        params?: Partial<import('~/services/pricingEngine').PricingParams>;
      };
      const { generateSuggestions, DEFAULT_PRICING_PARAMS } =
        await import('~/services/pricingEngine');

      const params = { ...DEFAULT_PRICING_PARAMS, ...body.params };

      void (async () => {
        const run = await prisma.pricingRun.create({
          data: {
            type: 'smart_pricing',
            scope: body.countries?.join(',') ?? null,
            params: JSON.parse(JSON.stringify(params)),
          },
        });
        try {
          const result = await generateSuggestions(
            params,
            body.countries?.map((c) => c.toUpperCase()),
          );
          await prisma.pricingRun.update({
            where: { id: run.id },
            data: { status: 'done', ...result, completedAt: new Date() },
          });
        } catch (err) {
          await prisma.pricingRun.update({
            where: { id: run.id },
            data: {
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
              completedAt: new Date(),
            },
          });
        }
      })();

      return reply.send({ ok: true, background: 'suggestions_started', params });
    },
  );

  app.post('/pricing/approve', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;
    const body = (request.body || {}) as { countryCodes: string[] };

    if (!body.countryCodes?.length) {
      return reply.status(400).send({ error: 'countryCodes required' });
    }

    // Use raw SQL to set price = proposedPrice (Prisma updateMany can't reference another field)
    const updated = await prisma.$executeRaw`
      UPDATE "ShopifyProductTemplateVariant" v
      SET "price" = v."proposedPrice", "updatedAt" = NOW()
      FROM "ShopifyProductTemplate" t
      WHERE v."templateId" = t."id"
        AND t."countryCode" = ANY(${body.countryCodes.map((c) => c.toUpperCase())}::text[])
        AND v."proposedPrice" IS NOT NULL
        AND v."priceLocked" = false
    `;

    return reply.send({ ok: true, updated });
  });

  app.post('/pricing/approve-and-push', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;
    const body = (request.body || {}) as { countryCodes: string[] };

    if (!body.countryCodes?.length) {
      return reply.status(400).send({ error: 'countryCodes required' });
    }

    const codes = body.countryCodes.map((c) => c.toUpperCase());

    // Approve prices
    const updated = await prisma.$executeRaw`
      UPDATE "ShopifyProductTemplateVariant" v
      SET "price" = v."proposedPrice", "updatedAt" = NOW()
      FROM "ShopifyProductTemplate" t
      WHERE v."templateId" = t."id"
        AND t."countryCode" = ANY(${codes}::text[])
        AND v."proposedPrice" IS NOT NULL
        AND v."priceLocked" = false
    `;

    // Push price-only updates to Shopify (no product recreation)
    const shopify = getShopifyClient();
    void (async () => {
      const templates = await prisma.shopifyProductTemplate.findMany({
        where: { countryCode: { in: codes }, shopifyProductId: { not: null } },
        include: { variants: true },
      });

      for (const template of templates) {
        try {
          // Look up Shopify variant GIDs by SKU from the ShopifyVariant table
          const skus = template.variants.map((v) => v.sku);
          const shopifyVariants = await prisma.shopifyVariant.findMany({
            where: { sku: { in: skus } },
          });
          const skuToGid = new Map(shopifyVariants.map((sv) => [sv.sku, sv.variantId]));

          const priceUpdates: Array<{ variantId: string; price: string }> = [];
          for (const v of template.variants) {
            const gid = skuToGid.get(v.sku);
            if (gid) {
              priceUpdates.push({ variantId: gid, price: v.price.toString() });
            }
          }

          if (priceUpdates.length > 0) {
            await shopify.updateVariantPrices(template.shopifyProductId!, priceUpdates);
            logger.info(
              { code: template.countryCode, updated: priceUpdates.length },
              'Pushed price updates to Shopify',
            );
          }
        } catch (err) {
          logger.error({ code: template.countryCode, err }, 'Failed to push prices to Shopify');
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();

    return reply.send({ ok: true, updated, background: 'push_started' });
  });

  app.patch('/pricing/variants/bulk-lock', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;
    const body = (request.body || {}) as { variantIds: string[]; priceLocked: boolean };

    const result = await prisma.shopifyProductTemplateVariant.updateMany({
      where: { id: { in: body.variantIds } },
      data: {
        priceLocked: body.priceLocked,
        priceSource: body.priceLocked ? 'manual' : undefined,
      },
    });

    return reply.send({ ok: true, updated: result.count });
  });

  app.get('/pricing/overview', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;
    const query = (request.query || {}) as { countryCode?: string };

    const where: Record<string, unknown> = {};
    if (query.countryCode) where.countryCode = query.countryCode.toUpperCase();

    const templates = await prisma.shopifyProductTemplate.findMany({
      where,
      include: {
        variants: {
          select: {
            id: true,
            price: true,
            proposedPrice: true,
            costFloor: true,
            providerCost: true,
            competitorPrice: true,
            priceLocked: true,
            marketPosition: true,
            lastPricedAt: true,
          },
        },
      },
      orderBy: { title: 'asc' },
    });

    // Get latest scrape time per country
    const lastScrapes = await prisma.competitorPrice.groupBy({
      by: ['countryCode'],
      _max: { scrapedAt: true },
    });
    const scrapeMap = new Map(lastScrapes.map((s) => [s.countryCode, s._max.scrapedAt]));

    const countries = templates.map((t) => {
      const variants = t.variants;
      const pending = variants.filter((v) => v.proposedPrice != null && !v.priceLocked).length;
      const locked = variants.filter((v) => v.priceLocked).length;
      const withCost = variants.filter((v) => v.providerCost != null);
      const avgCost =
        withCost.length > 0
          ? withCost.reduce((sum, v) => sum + Number(v.providerCost), 0) / withCost.length
          : null;
      const withProposed = variants.filter((v) => v.proposedPrice != null);
      const avgProposed =
        withProposed.length > 0
          ? withProposed.reduce((sum, v) => sum + Number(v.proposedPrice), 0) / withProposed.length
          : null;

      // Market position summary
      const positions = variants.map((v) => v.marketPosition).filter(Boolean);
      const aboveMarket = positions.filter((p) => p === 'above_market').length;
      const competitive = positions.filter((p) => p === 'competitive').length;
      let overallPosition = 'no_data';
      if (competitive > aboveMarket) overallPosition = 'competitive';
      else if (aboveMarket > 0) overallPosition = 'above_market';

      return {
        countryCode: t.countryCode,
        title: t.title,
        variantCount: variants.length,
        pendingChanges: pending,
        lockedCount: locked,
        avgCost: avgCost ? parseFloat(avgCost.toFixed(2)) : null,
        avgProposed: avgProposed ? parseFloat(avgProposed.toFixed(2)) : null,
        marketPosition: overallPosition,
        lastPricedAt: variants.reduce((latest: Date | null, v) => {
          if (!v.lastPricedAt) return latest;
          return !latest || v.lastPricedAt > latest ? v.lastPricedAt : latest;
        }, null),
        lastScrapedAt: t.countryCode ? (scrapeMap.get(t.countryCode) ?? null) : null,
      };
    });

    const totalPending = countries.reduce((sum, c) => sum + c.pendingChanges, 0);
    const totalLocked = countries.reduce((sum, c) => sum + c.lockedCount, 0);

    return reply.send({ totalCountries: countries.length, totalPending, totalLocked, countries });
  });

  app.get('/pricing/country/:code', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;
    const { code } = request.params as { code: string };

    const template = await prisma.shopifyProductTemplate.findUnique({
      where: { countryCode: code.toUpperCase() },
      include: { variants: { orderBy: { sortOrder: 'asc' } } },
    });

    if (!template) return reply.status(404).send({ error: 'Template not found' });

    return reply.send({
      countryCode: template.countryCode,
      title: template.title,
      variants: template.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        planType: v.planType,
        validity: v.validity,
        volume: v.volume,
        price: v.price,
        priceLocked: v.priceLocked,
        providerCost: v.providerCost,
        costFloor: v.costFloor,
        competitorPrice: v.competitorPrice,
        competitorBrand: v.competitorBrand,
        proposedPrice: v.proposedPrice,
        priceSource: v.priceSource,
        marketPosition: v.marketPosition,
        lastPricedAt: v.lastPricedAt,
      })),
    });
  });

  app.get('/pricing/runs', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;
    const query = (request.query || {}) as { type?: string; limit?: string };

    const where: Record<string, unknown> = {};
    if (query.type) where.type = query.type;

    const runs = await prisma.pricingRun.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(query.limit ?? '20', 10),
    });

    return reply.send({ runs });
  });

  /* v8 ignore stop */

  /**
   * POST /admin/shopify-skus/sync
   * Fetch all Shopify variants and upsert into ShopifyVariant table.
   * Response: { synced: number }
   */
  app.post('/shopify-skus/sync', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    let allVariants: Array<{
      sku: string;
      variantId: string;
      productTitle: string;
      variantTitle: string;
    }>;
    try {
      const shopify = getShopifyClient();
      allVariants = await shopify.getAllVariants();
    } catch (error) {
      logger.error({ err: error }, 'Failed to fetch Shopify variants for sync');
      return reply.code(502).send({ error: 'shopify_unavailable' });
    }

    const CHUNK = 100;
    for (let i = 0; i < allVariants.length; i += CHUNK) {
      const chunk = allVariants.slice(i, i + CHUNK);
      await Promise.all(
        chunk.map((v) =>
          prisma.shopifyVariant.upsert({
            where: { variantId: v.variantId },
            create: {
              variantId: v.variantId,
              sku: v.sku,
              productTitle: v.productTitle,
              variantTitle: v.variantTitle,
            },
            update: {
              sku: v.sku,
              productTitle: v.productTitle,
              variantTitle: v.variantTitle,
            },
          }),
        ),
      );
    }

    logger.info({ count: allVariants.length }, 'Shopify variants synced to DB');
    return reply.send({ synced: allVariants.length });
  });

  /**
   * POST /admin/shopify-skus/bulk-delete
   * Delete Shopify product variants (and their parent products when all variants are removed).
   * Body: { skus: string[] }
   * Response: { deleted: number; skipped: number; deletedVariantIds: string[]; errors: string[] }
   */
  app.post('/shopify-skus/bulk-delete', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const body = (request.body ?? {}) as { skus?: string[]; variantIds?: string[] };
    const isNonEmptyStringArray = (arr: unknown): arr is string[] =>
      Array.isArray(arr) &&
      arr.length > 0 &&
      arr.every((s) => typeof s === 'string' && s.trim().length > 0);
    const hasSkus = isNonEmptyStringArray(body.skus);
    const hasVariantIds = isNonEmptyStringArray(body.variantIds);
    if (!hasSkus && !hasVariantIds) {
      return reply.code(400).send({
        error: 'skus or variantIds array is required and must contain only non-empty strings',
      });
    }

    let shopify: ReturnType<typeof getShopifyClient>;
    try {
      shopify = getShopifyClient();
    } catch {
      return reply.code(502).send({ error: 'shopify_unavailable' });
    }

    // Prefer variantIds (direct GID lookup — reliable) over skus (search query — may miss variants)
    let lookupMap: Awaited<ReturnType<typeof shopify.getVariantGidsBySkus>>;
    try {
      if (hasVariantIds) {
        lookupMap = await shopify.getVariantInfoByGids(body.variantIds!);
      } else {
        lookupMap = await shopify.getVariantGidsBySkus(body.skus!);
      }
    } catch (err) {
      logger.error({ err }, 'Shopify variant lookup failed');
      return reply.code(502).send({ error: 'shopify_unavailable' });
    }

    const inputCount = hasVariantIds ? body.variantIds!.length : body.skus!.length;
    const skipped = inputCount - lookupMap.size;

    // Group variants by product so we can decide: delete whole product vs. just variants
    const productMap = new Map<string, { variantGids: string[]; totalVariantCount: number }>();
    for (const { variantGid, productGid, productVariantCount } of lookupMap.values()) {
      const existing = productMap.get(productGid);
      if (existing) {
        existing.variantGids.push(variantGid);
      } else {
        productMap.set(productGid, {
          variantGids: [variantGid],
          totalVariantCount: productVariantCount,
        });
      }
    }

    let deleted = 0;
    const errors: string[] = [];
    const successfulProductGids = new Set<string>();

    for (const [productGid, { variantGids, totalVariantCount }] of productMap) {
      try {
        if (variantGids.length >= totalVariantCount) {
          // All variants being removed — delete the product entirely
          await shopify.deleteProduct(productGid);
        } else {
          await shopify.deleteVariants(productGid, variantGids);
        }
        deleted += variantGids.length;
        successfulProductGids.add(productGid);
      } catch (err) {
        logger.error({ err, productGid }, 'Shopify bulk-delete failed for product');
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    // Return stable variantIds of confirmed-deleted rows so the frontend can
    // filter by identity rather than pruning all selected SKUs
    const deletedVariantIds: string[] = [];
    for (const { variantGid, productGid } of lookupMap.values()) {
      if (successfulProductGids.has(productGid)) deletedVariantIds.push(variantGid);
    }

    // Clean up local cache — remove deleted variants from ShopifyVariant table
    if (deletedVariantIds.length > 0) {
      await prisma.shopifyVariant.deleteMany({
        where: { variantId: { in: deletedVariantIds } },
      });
    }

    return reply.send({ deleted, skipped, deletedVariantIds, errors });
  });

  // ---------------------------------------------------------------------------
  // AI Bulk Mapping — shared generator + POST (sync) + GET (SSE stream)
  // ---------------------------------------------------------------------------

  type AiMappingDraftInternal = {
    shopifySku: string;
    catalogId: string;
    productName: string;
    region: string | null;
    dataAmount: string | null;
    validity: string | null;
    netPrice: unknown;
    provider: string;
    confidence: number;
    reason: string;
    packageType: 'fixed' | 'daypass';
    daysCount: number | null;
  };

  type AiMapInputSku = {
    sku: string;
    variantId: string;
    productTitle: string;
    variantTitle: string;
  };

  type AiMapProgressEvent = {
    batch: number;
    totalBatches: number;
    foundSoFar: number;
    partialDrafts: AiMappingDraftInternal[];
    warning?: string;
    /** Union of all SKUs submitted to AI across all providers. Only present on the first yield (batch === 1). */
    allInputSkus?: AiMapInputSku[];
  };

  type AiRelaxOptions = {
    requireData?: boolean;
    requireValidity?: boolean;
  };

  type AiMapGenParams = {
    shopifySkus?: string[];
    provider?: string;
    unmappedOnly?: boolean;
    openaiApiKey: string;
    relaxOptions?: AiRelaxOptions;
  };

  /**
   * Core AI-map generator — yields per-batch progress events.
   *
   * When `provider` is specified: single-provider mode (one match per Shopify SKU).
   * When `provider` is omitted: multi-provider mode — iterates every active provider
   * and produces one draft per (SKU, provider) pair so the user sees FiRoam and TGT
   * matches side by side. The `unmappedOnly` filter is applied per-provider so a SKU
   * already mapped to FiRoam is still processed for TGT.
   *
   * Vector pre-filtering (top-10 candidates per provider via pgvector cosine search)
   * with automatic fallback to full catalog when pgvector is unavailable.
   */
  async function* aiMapBatchGenerator(params: AiMapGenParams): AsyncGenerator<AiMapProgressEvent> {
    const {
      shopifySkus: providedSkus,
      provider,
      unmappedOnly,
      openaiApiKey,
      relaxOptions,
    } = params;
    const fromShopify = !Array.isArray(providedSkus) || providedSkus.length === 0;

    // 1. Resolve Shopify SKUs
    let shopifySkuList: AiMapInputSku[];

    if (!fromShopify) {
      shopifySkuList = providedSkus!.map((sku) => ({
        sku,
        variantId: '',
        productTitle: '',
        variantTitle: '',
      }));
    } else {
      try {
        const shopify = getShopifyClient();
        shopifySkuList = await shopify.getAllVariants();
      } catch (error) {
        logger.error({ err: error }, 'Failed to fetch Shopify variants for AI mapping');
        throw new Error('shopify_unavailable');
      }
    }

    if (shopifySkuList.length === 0) return;

    const openai = new OpenAI({ apiKey: openaiApiKey });
    const BATCH_SIZE = 50;

    // Pre-fetch active regions once. Used by the post-filter to apply strict
    // coverage matching for REGION SKUs without an async lookup per draft.
    const allRegions = await prisma.region.findMany({
      where: { isActive: true },
      select: { code: true, countryCodes: true },
    });
    const regionCountriesByCode = new Map<string, string[]>();
    for (const r of allRegions) {
      const cc = Array.isArray(r.countryCodes)
        ? (r.countryCodes as unknown[])
            .filter((c): c is string => typeof c === 'string')
            .map((c) => c.toUpperCase())
        : [];
      regionCountriesByCode.set(r.code, cc);
    }

    // 2. Build per-provider run list
    //    Single-provider mode: one entry using the given provider filter.
    //    Multi-provider mode: one entry per active provider, each with its own
    //    unmapped-filtered SKU list so we don't skip a SKU just because it's
    //    already mapped to a different provider.
    type ProviderRun = { prov: string; skus: typeof shopifySkuList };
    let providerRuns: ProviderRun[];

    if (provider) {
      // Single-provider: apply unmapped filter against this provider only
      let skus = shopifySkuList;
      if (fromShopify && unmappedOnly !== false) {
        const mappedSkus = await prisma.providerSkuMapping.findMany({
          select: { shopifySku: true },
          distinct: ['shopifySku'],
          where: { provider },
        });
        const mappedSet = new Set(mappedSkus.map((m) => m.shopifySku));
        skus = shopifySkuList.filter((v) => !mappedSet.has(v.sku));
      }
      providerRuns = [{ prov: provider, skus }];
    } else {
      // Multi-provider: discover active providers then filter per provider
      const activeProviders = await prisma.$queryRaw<{ provider: string }[]>`
        SELECT DISTINCT provider FROM "ProviderSkuCatalog" WHERE "isActive" = true ORDER BY provider
      `;
      const providers = activeProviders.map((r) => r.provider);

      providerRuns = await Promise.all(
        providers.map(async (prov) => {
          let skus = shopifySkuList;
          if (fromShopify && unmappedOnly !== false) {
            const mappedSkus = await prisma.providerSkuMapping.findMany({
              select: { shopifySku: true },
              distinct: ['shopifySku'],
              where: { provider: prov },
            });
            const mappedSet = new Set(mappedSkus.map((m) => m.shopifySku));
            skus = shopifySkuList.filter((v) => !mappedSet.has(v.sku));
          }
          return { prov, skus };
        }),
      );

      // Drop providers with nothing to process
      providerRuns = providerRuns.filter((r) => r.skus.length > 0);
    }

    if (providerRuns.length === 0) return;

    // Compute the union of all SKUs actually submitted across all provider runs.
    // Stored in the job record so completed/errored jobs can surface unmatched SKUs.
    const allInputSkuSet = new Set<string>();
    for (const { skus } of providerRuns) for (const v of skus) allInputSkuSet.add(v.sku);
    const allInputSkus: AiMapInputSku[] = shopifySkuList.filter((v) => allInputSkuSet.has(v.sku));

    // 3. Total batches spans all providers
    const totalBatches = providerRuns.reduce(
      (sum, { skus }) => sum + Math.ceil(skus.length / BATCH_SIZE),
      0,
    );

    // 4. Embed all SKU display names once — reused across providers via index lookup
    const useVectorSearch = await isVectorAvailable();
    const skuToIndex = new Map(shopifySkuList.map((v, i) => [v.sku, i]));
    let skuEmbeddings: number[][] | null = null;
    if (useVectorSearch) {
      try {
        const displayNames = shopifySkuList.map(
          (v) => [v.productTitle, v.variantTitle].filter(Boolean).join(' - ') || v.sku,
        );
        skuEmbeddings = await embedBatch(displayNames, openai);
      } catch (err) {
        logger.warn(
          { err },
          'Failed to embed SKU names for vector search — falling back to full catalog',
        );
        skuEmbeddings = null;
      }
    }

    let foundSoFar = 0;
    let batchNum = 0;

    // 5. Main loop: one pass per provider
    for (const { prov, skus: provSkuList } of providerRuns) {
      // Fetch catalog for this provider
      const catalogEntries = (await providerSkuCatalog.findMany({
        where: { isActive: true, provider: prov },
        orderBy: { productName: 'asc' },
      })) as Array<{
        id: string;
        provider: string;
        productCode: string;
        productType: string | null;
        productName: string;
        region: string | null;
        dataAmount: string | null;
        validity: string | null;
        netPrice: unknown;
        parsedJson: ParsedCatalogAttributes | null;
        countryCodes: unknown;
      }>;

      if (catalogEntries.length === 0) continue;

      const catalogCompact = catalogEntries.map((e) => ({
        id: e.id,
        provider: e.provider,
        productName: e.productName,
        region: e.region,
        dataAmount: e.dataAmount,
        validity: e.validity,
        netPrice: e.netPrice,
        dataMb: e.parsedJson?.dataMb ?? null,
        validityDays: e.parsedJson?.validityDays ?? null,
      }));

      for (let i = 0; i < provSkuList.length; i += BATCH_SIZE) {
        batchNum += 1;
        const batch = provSkuList.slice(i, i + BATCH_SIZE);
        const partialDrafts: AiMappingDraftInternal[] = [];
        let batchWarning: string | undefined;

        if (useVectorSearch && skuEmbeddings) {
          // Vector path: split batch into groups of 10, run ALL groups in parallel.
          // Each group: parallel top-10 candidate fetches (scoped to this provider) + 1 GPT call.
          const VECTOR_GROUP = 10;

          type GroupDraft = AiMappingDraftInternal[];
          const groupResults = await Promise.all(
            Array.from({ length: Math.ceil(batch.length / VECTOR_GROUP) }, (_, gi) => {
              const group = batch.slice(gi * VECTOR_GROUP, (gi + 1) * VECTOR_GROUP);
              return (async (): Promise<{
                drafts: GroupDraft;
                warning?: string;
                fatal?: unknown;
              }> => {
                // Fetch top-10 candidates for each SKU, scoped to this provider
                const groupCandidates = await Promise.all(
                  group.map(async (variant) => {
                    const idx = skuToIndex.get(variant.sku) ?? -1;
                    if (idx === -1) return catalogCompact;
                    try {
                      const topRows = await findTopCandidates(skuEmbeddings![idx], prov, 10);
                      if (topRows.length === 0) return catalogCompact;
                      return topRows.map((c) => ({
                        id: (c as { id: string }).id,
                        provider: (c as { provider: string }).provider,
                        productName: (c as { productName: string }).productName,
                        region: (c as { region: string | null }).region,
                        dataAmount: (c as { dataAmount: string | null }).dataAmount,
                        validity: (c as { validity: string | null }).validity,
                        netPrice: (c as { netPrice: unknown }).netPrice,
                      }));
                    } catch {
                      return catalogCompact;
                    }
                  }),
                );

                const skuInputs = group.map((variant, j) => {
                  const parsedSku = parseShopifySku(variant.sku);
                  return {
                    sku: variant.sku,
                    displayName:
                      [variant.productTitle, variant.variantTitle].filter(Boolean).join(' - ') ||
                      variant.sku,
                    dataMb: parsedSku?.dataMb ?? null,
                    validityDays: parsedSku?.validityDays ?? null,
                    skuType: parsedSku?.skuType ?? 'FIXED',
                    candidates: groupCandidates[j].map((c) => {
                      const full = catalogEntries.find((e) => e.id === c.id);
                      return {
                        ...c,
                        dataMb: full?.parsedJson?.dataMb ?? null,
                        validityDays: full?.parsedJson?.validityDays ?? null,
                      };
                    }),
                  };
                });

                const requireDataNote =
                  relaxOptions?.requireData !== false
                    ? 'Data amount IS required to match: REJECT any catalog entry where dataMb ≠ SKU dataMb (e.g. do NOT match a 2048MB SKU to a 5120MB entry).'
                    : 'Data amount is NOT required to match — allow data mismatches.';
                const requireValidityNote =
                  relaxOptions?.requireValidity !== false
                    ? 'Validity IS required to match: REJECT any catalog entry where validityDays ≠ SKU validityDays. EXCEPTION: if skuType is DAYPASS, skip this check — daypass catalog entries are always daily plans and the SKU validity represents subscription length, not plan period.'
                    : 'Validity is NOT required to match — allow validity mismatches.';
                const systemPrompt = `You are an eSIM product matcher. ${requireDataNote} ${requireValidityNote} Region match is ALWAYS required. Parsed numeric fields (dataMb, validityDays) are provided directly — use them for exact comparison. For each Shopify SKU you are given its top-10 most semantically similar catalog candidates. Pick the best match per SKU or omit if none are suitable. Confidence reflects structural match quality. For DAYPASS SKUs, require exact DATA and exact REGION only — ignore validityDays. Return only JSON.`;
                const userPrompt = `Match each Shopify SKU to its best catalog entry:
${JSON.stringify(skuInputs)}

Return JSON: { "mappings": [{ "shopifySku": string, "catalogId": string, "confidence": number (0-1), "reason": string }] }
Only include mappings with confidence >= 0.3. If no good match for a SKU, omit it.`;

                try {
                  const completion = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: [
                      { role: 'system', content: systemPrompt },
                      { role: 'user', content: userPrompt },
                    ],
                    response_format: { type: 'json_object' },
                    temperature: 0.1,
                  });
                  const raw = completion.choices[0]?.message?.content;
                  if (!raw) return { drafts: [] };
                  const parsed = JSON.parse(raw) as {
                    mappings?: Array<{
                      shopifySku: string;
                      catalogId: string;
                      confidence: number;
                      reason: string;
                    }>;
                  };
                  const drafts: GroupDraft = [];
                  for (const match of parsed.mappings ?? []) {
                    const entry = catalogEntries.find((e) => e.id === match.catalogId);
                    if (!entry) continue;
                    const parsedSku = parseShopifySku(match.shopifySku);
                    const pkgType =
                      entry.productCode?.includes('?') || entry.productType === 'DAILY_PACK'
                        ? 'daypass'
                        : 'fixed';
                    drafts.push({
                      shopifySku: match.shopifySku,
                      catalogId: match.catalogId,
                      productName: entry.productName,
                      region: entry.region,
                      dataAmount: entry.dataAmount,
                      validity: entry.validity,
                      netPrice: entry.netPrice,
                      provider: entry.provider,
                      confidence: match.confidence,
                      reason: match.reason,
                      packageType: pkgType,
                      daysCount: pkgType === 'daypass' ? (parsedSku?.validityDays ?? null) : null,
                    });
                  }
                  // Hard post-filter: enforce relaxOptions deterministically regardless of GPT output
                  const filteredDrafts = drafts.filter((draft) => {
                    const parsedSku = parseShopifySku(draft.shopifySku);
                    if (!parsedSku) return true;
                    const entry = catalogEntries.find((e) => e.id === draft.catalogId);
                    // Reject type mismatches: DAYPASS SKU must map to daypass catalog and vice versa
                    const isCatalogDaypass =
                      Boolean(entry?.productCode?.includes('?')) ||
                      entry?.productType === 'DAILY_PACK';
                    if ((parsedSku.skuType === 'DAYPASS') !== isCatalogDaypass) return false;
                    if (!entry?.parsedJson) {
                      // Unverifiable — only pass through if both constraints are relaxed
                      return (
                        relaxOptions?.requireData === false &&
                        relaxOptions?.requireValidity === false
                      );
                    }
                    // Region check: COUNTRY SKUs match by parsedJson.regionCodes; REGION SKUs
                    // require the catalog to cover ALL of the canonical region's countries.
                    if (parsedSku.kind === 'REGION') {
                      const required = regionCountriesByCode.get(parsedSku.regionCode);
                      if (!required || required.length === 0) return false;
                      const catalogCountries = Array.isArray(entry.countryCodes)
                        ? (entry.countryCodes as unknown[])
                            .filter((c): c is string => typeof c === 'string')
                            .map((c) => c.toUpperCase())
                        : [];
                      if (!required.every((c) => catalogCountries.includes(c))) return false;
                    } else if (!entry.parsedJson.regionCodes.includes(parsedSku.regionCode)) {
                      return false;
                    }
                    if (
                      relaxOptions?.requireData !== false &&
                      entry.parsedJson.dataMb !== parsedSku.dataMb
                    )
                      return false;
                    if (
                      parsedSku.skuType !== 'DAYPASS' &&
                      relaxOptions?.requireValidity !== false &&
                      entry.parsedJson.validityDays !== parsedSku.validityDays
                    )
                      return false;
                    return true;
                  });
                  return { drafts: filteredDrafts };
                } catch (err) {
                  logger.error({ err, skus: group.map((v) => v.sku) }, 'OpenAI group match failed');
                  const msg = err instanceof Error ? err.message : String(err);
                  const isFatal =
                    err instanceof OpenAI.APIError &&
                    (err.status === 401 || err.status === 429 || err.code === 'insufficient_quota');
                  return { drafts: [], warning: msg, fatal: isFatal ? err : undefined };
                }
              })();
            }),
          );

          for (const result of groupResults) {
            partialDrafts.push(...result.drafts);
            if (result.warning) batchWarning = result.warning;
            if (result.fatal) {
              foundSoFar += partialDrafts.length;
              yield {
                batch: batchNum,
                totalBatches,
                foundSoFar,
                partialDrafts,
                warning: batchWarning,
                ...(batchNum === 1 ? { allInputSkus } : {}),
              };
              throw result.fatal;
            }
          }
        } else {
          // Fallback path: one GPT call per batch of 50 SKUs with full catalog
          const skuList = batch.map((v) => {
            const parsedSku = parseShopifySku(v.sku);
            return {
              sku: v.sku,
              displayName: [v.productTitle, v.variantTitle].filter(Boolean).join(' - ') || v.sku,
              dataMb: parsedSku?.dataMb ?? null,
              validityDays: parsedSku?.validityDays ?? null,
              skuType: parsedSku?.skuType ?? 'FIXED',
            };
          });

          const fallbackRequireDataNote =
            relaxOptions?.requireData !== false
              ? 'Data amount IS required to match: REJECT any catalog entry where dataMb ≠ SKU dataMb (e.g. do NOT match a 2048MB SKU to a 5120MB entry).'
              : 'Data amount is NOT required to match — allow data mismatches.';
          const fallbackRequireValidityNote =
            relaxOptions?.requireValidity !== false
              ? 'Validity IS required to match: REJECT any catalog entry where validityDays ≠ SKU validityDays. EXCEPTION: if skuType is DAYPASS, skip this check — daypass catalog entries are always daily plans and the SKU validity represents subscription length, not plan period.'
              : 'Validity is NOT required to match — allow validity mismatches.';
          const systemPrompt = `You are an eSIM product matcher. ${fallbackRequireDataNote} ${fallbackRequireValidityNote} Region match is ALWAYS required. Parsed numeric fields (dataMb, validityDays) are provided directly — use them for exact comparison. Match each Shopify SKU to the best provider catalog entry. Confidence reflects structural match quality. Return only JSON.`;
          const userPrompt = `Match these Shopify SKUs to catalog entries:
SKUs: ${JSON.stringify(skuList)}

Catalog: ${JSON.stringify(catalogCompact)}

Return JSON: { "mappings": [{ "shopifySku": string, "catalogId": string, "confidence": number (0-1), "reason": string }] }
Only include mappings with confidence >= 0.3. If no good match, omit the SKU.`;

          try {
            const completion = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
              response_format: { type: 'json_object' },
              temperature: 0.1,
            });
            const raw = completion.choices[0]?.message?.content;
            if (raw) {
              const parsed = JSON.parse(raw) as {
                mappings?: Array<{
                  shopifySku: string;
                  catalogId: string;
                  confidence: number;
                  reason: string;
                }>;
              };
              for (const match of parsed.mappings ?? []) {
                const entry = catalogEntries.find((e) => e.id === match.catalogId);
                if (!entry) continue;
                // Hard post-filter: enforce relaxOptions deterministically regardless of GPT output
                const parsedSku = parseShopifySku(match.shopifySku);
                if (parsedSku) {
                  if (!entry.parsedJson) {
                    // Unverifiable — only pass through if both constraints are relaxed
                    if (
                      !(
                        relaxOptions?.requireData === false &&
                        relaxOptions?.requireValidity === false
                      )
                    )
                      continue;
                  } else {
                    // Region check: COUNTRY SKUs match by parsedJson.regionCodes; REGION
                    // SKUs require the catalog to cover ALL of the canonical region's
                    // countries (strict superset).
                    if (parsedSku.kind === 'REGION') {
                      const required = regionCountriesByCode.get(parsedSku.regionCode);
                      if (!required || required.length === 0) continue;
                      const catalogCountries = Array.isArray(entry.countryCodes)
                        ? (entry.countryCodes as unknown[])
                            .filter((c): c is string => typeof c === 'string')
                            .map((c) => c.toUpperCase())
                        : [];
                      if (!required.every((c) => catalogCountries.includes(c))) continue;
                    } else if (!entry.parsedJson.regionCodes.includes(parsedSku.regionCode)) {
                      continue;
                    }
                    if (
                      relaxOptions?.requireData !== false &&
                      entry.parsedJson.dataMb !== parsedSku.dataMb
                    )
                      continue;
                    if (
                      parsedSku.skuType !== 'DAYPASS' &&
                      relaxOptions?.requireValidity !== false &&
                      entry.parsedJson.validityDays !== parsedSku.validityDays
                    )
                      continue;
                  }
                }
                const pkgType2 =
                  entry.productCode?.includes('?') || entry.productType === 'DAILY_PACK'
                    ? 'daypass'
                    : 'fixed';
                // Reject type mismatches: DAYPASS SKU must map to daypass catalog and vice versa
                if (parsedSku && (parsedSku.skuType === 'DAYPASS') !== (pkgType2 === 'daypass')) {
                  continue;
                }
                partialDrafts.push({
                  shopifySku: match.shopifySku,
                  catalogId: match.catalogId,
                  productName: entry.productName,
                  region: entry.region,
                  dataAmount: entry.dataAmount,
                  validity: entry.validity,
                  netPrice: entry.netPrice,
                  provider: entry.provider,
                  confidence: match.confidence,
                  reason: match.reason,
                  packageType: pkgType2,
                  daysCount: pkgType2 === 'daypass' ? (parsedSku?.validityDays ?? null) : null,
                });
              }
            }
          } catch (err) {
            logger.error({ err, batch: skuList }, 'OpenAI batch failed');
            const msg = err instanceof Error ? err.message : String(err);
            const isFatal =
              err instanceof OpenAI.APIError &&
              (err.status === 401 || err.status === 429 || err.code === 'insufficient_quota');
            batchWarning = msg;
            if (isFatal) {
              foundSoFar += partialDrafts.length;
              yield {
                batch: batchNum,
                totalBatches,
                foundSoFar,
                partialDrafts,
                warning: msg,
                ...(batchNum === 1 ? { allInputSkus } : {}),
              };
              throw err;
            }
          }
        }

        foundSoFar += partialDrafts.length;
        yield {
          batch: batchNum,
          totalBatches,
          foundSoFar,
          partialDrafts,
          warning: batchWarning,
          ...(batchNum === 1 ? { allInputSkus } : {}),
        };
      }
    }
  }

  /**
   * POST /admin/sku-mappings/ai-map
   * Bulk AI mapping: uses OpenAI to suggest catalog matches for Shopify SKUs.
   * Returns draft mappings — does NOT save to DB. Admin reviews and approves.
   * Non-streaming fallback — collects all generator yields and returns final JSON.
   *
   * Body: { shopifySkus?: string[], provider?: string, unmappedOnly?: boolean }
   */
  app.post('/sku-mappings/ai-map', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return reply.code(500).send({ error: 'OPENAI_API_KEY not configured' });
    }

    const body = (request.body || {}) as {
      shopifySkus?: string[];
      provider?: string;
      unmappedOnly?: boolean;
      relaxOptions?: AiRelaxOptions;
    };

    const allDrafts: AiMappingDraftInternal[] = [];
    let openAiError: string | null = null;

    try {
      for await (const evt of aiMapBatchGenerator({
        shopifySkus: body.shopifySkus,
        provider: body.provider,
        unmappedOnly: body.unmappedOnly,
        openaiApiKey: OPENAI_API_KEY,
        relaxOptions: body.relaxOptions,
      })) {
        allDrafts.push(...evt.partialDrafts);
        if (evt.warning) openAiError = evt.warning;
      }
    } catch (err) {
      logger.error({ err }, 'AI map generator failed');
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'shopify_unavailable') {
        return reply.code(502).send({ error: 'shopify_unavailable' });
      }
      if (allDrafts.length === 0) {
        return reply.code(502).send({ error: `OpenAI error: ${msg}` });
      }
      openAiError = msg;
    }

    if (openAiError && allDrafts.length === 0) {
      return reply.code(502).send({ error: `OpenAI error: ${openAiError}` });
    }

    return reply.send({
      drafts: allDrafts,
      ...(openAiError ? { warning: `Some batches failed: ${openAiError}` } : {}),
    });
  });

  /**
   * GET /admin/sku-mappings/ai-map/stream
   * SSE-streaming version of ai-map. EventSource can't set headers, so the admin
   * key is accepted via query.apiKey as a fallback to x-admin-key.
   *
   * Query: provider, unmappedOnly, apiKey
   */
  app.get('/sku-mappings/ai-map/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const query = request.query as {
      provider?: string;
      unmappedOnly?: string;
    };

    // The CORS plugin doesn't run after reply.hijack(), so we must set CORS headers manually.
    const requestOrigin = request.headers.origin;
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy/CDN buffering so events reach the browser immediately
      ...(requestOrigin
        ? {
            'Access-Control-Allow-Origin': requestOrigin,
            'Access-Control-Allow-Credentials': 'true',
            Vary: 'Origin',
          }
        : {}),
    });
    reply.raw.flushHeaders();

    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
    }, 15_000);

    request.raw.on('close', () => clearInterval(heartbeat));

    if (!OPENAI_API_KEY) {
      reply.raw.write(
        `event: error\ndata: ${JSON.stringify({ message: 'OPENAI_API_KEY not configured' })}\n\n`,
      );
      clearInterval(heartbeat);
      reply.raw.end();
      return;
    }

    try {
      for await (const evt of aiMapBatchGenerator({
        provider: query.provider,
        unmappedOnly: query.unmappedOnly !== 'false',
        openaiApiKey: OPENAI_API_KEY,
      })) {
        if (reply.raw.destroyed) break;
        reply.raw.write(`event: progress\ndata: ${JSON.stringify(evt)}\n\n`);
      }
      if (!reply.raw.destroyed) {
        reply.raw.write(`event: done\ndata: {}\n\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!reply.raw.destroyed) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
      }
    } finally {
      clearInterval(heartbeat);
      reply.raw.end();
    }
  });

  // ---------------------------------------------------------------------------
  // AI Map Jobs — persistent background job variant
  // ---------------------------------------------------------------------------

  /**
   * Background runner: consumes aiMapBatchGenerator and persists progress to DB.
   * Called fire-and-forget (no await) so the HTTP handler returns immediately.
   */
  async function runAiMapJobAsync(jobId: string, params: AiMapGenParams): Promise<void> {
    const allDrafts: AiMappingDraftInternal[] = [];
    let totalBatchesSet = false;
    let capturedInputSkus: AiMapInputSku[] | null = null;
    // If any batch emits a warning the run is incomplete — don't populate unmatched
    // because unevaluated SKUs would be falsely listed as having no catalog match.
    let hasWarning = false;

    const computeUnmatched = (): AiMapInputSku[] => {
      if (!capturedInputSkus || hasWarning) return [];
      const matchedSet = new Set(allDrafts.map((d) => d.shopifySku));
      return capturedInputSkus.filter((v) => !matchedSet.has(v.sku));
    };

    try {
      for await (const evt of aiMapBatchGenerator(params)) {
        if (evt.allInputSkus && capturedInputSkus === null) {
          capturedInputSkus = evt.allInputSkus;
        }
        if (evt.warning) hasWarning = true;
        if (!totalBatchesSet) {
          await prisma.aiMapJob.update({
            where: { id: jobId },
            data: { totalBatches: evt.totalBatches },
          });
          totalBatchesSet = true;
        }
        allDrafts.push(...evt.partialDrafts);
        await prisma.aiMapJob.update({
          where: { id: jobId },
          data: {
            completedBatches: evt.batch,
            foundSoFar: evt.foundSoFar,
            draftsJson: allDrafts as unknown as Prisma.JsonArray,
            ...(evt.warning ? { warning: evt.warning } : {}),
          },
        });
      }
      await prisma.aiMapJob.update({
        where: { id: jobId },
        data: {
          status: 'done',
          completedAt: new Date(),
          unmatchedSkusJson: computeUnmatched() as unknown as Prisma.JsonArray,
        },
      });
    } catch (err) {
      logger.error({ err, jobId }, 'AI map job failed');
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await prisma.aiMapJob.update({
          where: { id: jobId },
          data: {
            status: 'error',
            error: msg,
            completedAt: new Date(),
            // Don't persist unmatched on error — run was incomplete
            unmatchedSkusJson: [] as unknown as Prisma.JsonArray,
          },
        });
      } catch (updateErr) {
        logger.error({ err: updateErr, jobId }, 'Failed to persist AI map job failure state');
      }
    }
  }

  /**
   * POST /admin/sku-mappings/ai-map/jobs
   * Creates a persistent job and starts the AI mapping in the background.
   * Returns { jobId } immediately — client polls /jobs/:id/stream for progress.
   */
  app.post('/sku-mappings/ai-map/jobs', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return reply.code(500).send({ error: 'OPENAI_API_KEY not configured' });
    }

    const body = (request.body || {}) as {
      provider?: string;
      unmappedOnly?: boolean;
      shopifySkus?: string[];
      relaxOptions?: AiRelaxOptions;
    };

    const job = await prisma.aiMapJob.create({
      data: {
        status: 'running',
        provider: body.provider ?? null,
        unmappedOnly: body.unmappedOnly !== false,
      },
    });

    // Fire and forget — do not await
    void runAiMapJobAsync(job.id, {
      shopifySkus: body.shopifySkus,
      provider: body.provider,
      unmappedOnly: body.unmappedOnly,
      openaiApiKey: OPENAI_API_KEY,
      relaxOptions: body.relaxOptions,
    });

    return reply.code(201).send({ jobId: job.id });
  });

  /**
   * GET /admin/sku-mappings/ai-map/jobs
   * List last 20 jobs newest-first, without the heavy draftsJson field.
   */
  app.get('/sku-mappings/ai-map/jobs', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const jobs = await prisma.aiMapJob.findMany({
      select: {
        id: true,
        status: true,
        provider: true,
        unmappedOnly: true,
        totalBatches: true,
        completedBatches: true,
        foundSoFar: true,
        warning: true,
        error: true,
        createdAt: true,
        completedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return reply.send({ jobs });
  });

  /**
   * GET /admin/sku-mappings/ai-map/jobs/:id
   * Full job record including draftsJson — used after completion to load drafts for review.
   */
  app.get('/sku-mappings/ai-map/jobs/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const { id } = request.params as { id: string };
    const job = await prisma.aiMapJob.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: 'Job not found' });

    return reply.send({ job });
  });

  /**
   * DELETE /admin/sku-mappings/ai-map/jobs/:id
   * Hard-delete a job record (dismiss error/interrupted jobs from the list).
   */
  app.delete(
    '/sku-mappings/ai-map/jobs/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdminKey(request, reply)) return;

      const { id } = request.params as { id: string };

      // Fetch first to guard against deleting a still-running job
      const existing = await prisma.aiMapJob.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!existing) return reply.code(404).send({ error: 'Job not found' });
      if (existing.status === 'running') {
        return reply.code(409).send({ error: 'Cannot delete a running job' });
      }

      try {
        await prisma.aiMapJob.delete({ where: { id } });
      } catch (err) {
        // P2025 = "Record to delete does not exist" (race condition)
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
          return reply.code(404).send({ error: 'Job not found' });
        }
        logger.error({ err }, 'Failed to delete AI map job');
        return reply.code(500).send({ error: 'Failed to delete job' });
      }

      return reply.send({ ok: true });
    },
  );

  /**
   * GET /admin/sku-mappings/ai-map/jobs/:id/stream
   * SSE stream that polls the AiMapJob DB record every 2s and emits progress events.
   * Clients can disconnect and reconnect — they'll pick up from the saved state.
   */
  app.get(
    '/sku-mappings/ai-map/jobs/:id/stream',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdminKey(request, reply)) return;

      const { id } = request.params as { id: string };

      const requestOrigin = request.headers.origin;
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(requestOrigin
          ? {
              'Access-Control-Allow-Origin': requestOrigin,
              'Access-Control-Allow-Credentials': 'true',
              Vary: 'Origin',
            }
          : {}),
      });
      reply.raw.flushHeaders();

      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
      }, 15_000);

      let closed = false;
      /* v8 ignore start */
      request.raw.on('close', () => {
        closed = true;
        clearInterval(heartbeat);
      });
      /* v8 ignore stop */

      const send = (event: string, data: unknown) => {
        if (!reply.raw.destroyed) {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      // Poll loop
      const poll = async () => {
        while (!closed && !reply.raw.destroyed) {
          let job: {
            status: string;
            totalBatches: number | null;
            completedBatches: number;
            foundSoFar: number;
            error: string | null;
          } | null;

          try {
            job = await prisma.aiMapJob.findUnique({
              where: { id },
              select: {
                status: true,
                totalBatches: true,
                completedBatches: true,
                foundSoFar: true,
                error: true,
              },
            });
          } catch {
            send('error', { message: 'Failed to read job state' });
            break;
          }

          if (!job) {
            send('error', { message: 'Job not found' });
            break;
          }

          if (job.status === 'running') {
            // Only emit progress once totalBatches is known (set after the first batch completes).
            // Before that the job is still initializing (fetching Shopify SKUs / embeddings).
            if (job.totalBatches !== null) {
              send('progress', {
                batch: job.completedBatches,
                totalBatches: job.totalBatches,
                foundSoFar: job.foundSoFar,
              });
            }
          } else if (job.status === 'done') {
            if ((job.totalBatches ?? 0) > 0) {
              send('progress', {
                batch: job.completedBatches,
                totalBatches: job.totalBatches,
                foundSoFar: job.foundSoFar,
              });
            }
            send('done', {});
            break;
          } else {
            // error or interrupted
            send('error', { message: job.error ?? job.status });
            break;
          }

          // Wait 2s before next poll — clean up the close listener whether the
          // timer or the close event fires first to avoid MaxListenersExceeded.
          await new Promise<void>((resolve) => {
            /* v8 ignore start */
            const onClose = () => {
              clearTimeout(t);
              resolve();
            };
            /* v8 ignore stop */
            const t = setTimeout(() => {
              request.raw.removeListener('close', onClose);
              resolve();
            }, 2000);
            request.raw.once('close', onClose);
          });
        }

        clearInterval(heartbeat);
        if (!reply.raw.destroyed) reply.raw.end();
      };

      void poll();
    },
  );

  // ---------------------------------------------------------------------------
  // Structured Matcher — deterministic JSONB-based SKU matching
  // ---------------------------------------------------------------------------

  type StructuredRelaxOptions = {
    relaxValidity?: boolean;
    relaxData?: boolean;
    relaxRegion?: boolean; // if true, allow regional/global catalog entries (not just exact country match)
  };

  type ParsedCatalogRow = {
    id: string;
    provider: string;
    productName: string;
    region: string | null;
    dataAmount: string | null;
    validity: string | null;
    netPrice: unknown;
    productCode: string;
    productType: string | null;
    parsedJson: ParsedCatalogAttributes | null;
  };

  /** TGT uses productType='DAILY_PACK'; FiRoam uses '?' in productCode. */
  function isCatalogDailyPack(row: ParsedCatalogRow): boolean {
    return row.productCode.includes('?') || row.productType === 'DAILY_PACK';
  }

  async function findStructuredMatches(
    sku: string,
    provider: string | undefined,
    relaxOptions: StructuredRelaxOptions,
  ): Promise<AiMappingDraftInternal[]> {
    const parsed = parseShopifySku(sku);
    if (!parsed) return [];

    const { regionCode, dataMb, validityDays, skuType, kind } = parsed;
    const isDaypass = skuType === 'DAYPASS';

    let rows: ParsedCatalogRow[];
    /**
     * For REGION SKUs (e.g. REGION-EU30-...), specificity is the size of the
     * provider's `countryCodes` array — smaller catalogs that still cover the
     * region are tighter, more cost-efficient fits. Tracked here so we don't
     * recompute downstream.
     */
    const regionCoverageSizeById = new Map<string, number>();

    if (kind === 'REGION') {
      // Look up canonical region; without a Region row we cannot enforce strict coverage.
      const region = await prisma.region.findUnique({ where: { code: regionCode } });
      if (!region) return [];
      const requiredCountries = Array.isArray(region.countryCodes)
        ? (region.countryCodes as unknown[]).filter((c): c is string => typeof c === 'string')
        : [];
      if (requiredCountries.length === 0) return [];
      const requiredJson = JSON.stringify(requiredCountries);

      // JSONB `@>` returns true iff the left array contains every element on the right.
      // That's exactly the strict-superset check: catalog covers all advertised countries.
      rows = provider
        ? await prisma.$queryRaw<ParsedCatalogRow[]>`
            SELECT id, provider, "productName", region, "dataAmount", validity, "netPrice",
                   "productCode", "productType", "parsedJson", "countryCodes"
            FROM "ProviderSkuCatalog"
            WHERE "isActive" = true
              AND "parsedJson" IS NOT NULL
              AND provider = ${provider}
              AND "countryCodes" @> ${requiredJson}::jsonb
          `
        : await prisma.$queryRaw<ParsedCatalogRow[]>`
            SELECT id, provider, "productName", region, "dataAmount", validity, "netPrice",
                   "productCode", "productType", "parsedJson", "countryCodes"
            FROM "ProviderSkuCatalog"
            WHERE "isActive" = true
              AND "parsedJson" IS NOT NULL
              AND "countryCodes" @> ${requiredJson}::jsonb
          `;

      for (const row of rows) {
        const cc = (row as ParsedCatalogRow & { countryCodes?: unknown }).countryCodes;
        const size = Array.isArray(cc)
          ? (cc as unknown[]).filter((c) => typeof c === 'string').length
          : Number.MAX_SAFE_INTEGER;
        regionCoverageSizeById.set(row.id, size);
      }
    } else {
      // JSONB containment query: regionCodes array must contain this regionCode.
      // Strict mode (default): also requires regionCodes = [regionCode] exactly — rejects regional/global plans.
      // relaxRegion=true: allows any catalog entry that covers this region (may include global/regional plans).
      const strictRegion = !relaxOptions.relaxRegion;
      if (provider) {
        rows = strictRegion
          ? await prisma.$queryRaw<ParsedCatalogRow[]>`
              SELECT id, provider, "productName", region, "dataAmount", validity, "netPrice",
                     "productCode", "productType", "parsedJson"
              FROM "ProviderSkuCatalog"
              WHERE "isActive" = true
                AND "parsedJson" IS NOT NULL
                AND jsonb_typeof("parsedJson"->'regionCodes') = 'array'
                AND provider = ${provider}
                AND "parsedJson"->'regionCodes' ? ${regionCode}
                AND jsonb_array_length("parsedJson"->'regionCodes') = 1
            `
          : await prisma.$queryRaw<ParsedCatalogRow[]>`
              SELECT id, provider, "productName", region, "dataAmount", validity, "netPrice",
                     "productCode", "productType", "parsedJson"
              FROM "ProviderSkuCatalog"
              WHERE "isActive" = true
                AND "parsedJson" IS NOT NULL
                AND provider = ${provider}
                AND "parsedJson"->'regionCodes' ? ${regionCode}
            `;
      } else {
        rows = strictRegion
          ? await prisma.$queryRaw<ParsedCatalogRow[]>`
              SELECT id, provider, "productName", region, "dataAmount", validity, "netPrice",
                     "productCode", "productType", "parsedJson"
              FROM "ProviderSkuCatalog"
              WHERE "isActive" = true
                AND "parsedJson" IS NOT NULL
                AND jsonb_typeof("parsedJson"->'regionCodes') = 'array'
                AND "parsedJson"->'regionCodes' ? ${regionCode}
                AND jsonb_array_length("parsedJson"->'regionCodes') = 1
            `
          : await prisma.$queryRaw<ParsedCatalogRow[]>`
              SELECT id, provider, "productName", region, "dataAmount", validity, "netPrice",
                     "productCode", "productType", "parsedJson"
              FROM "ProviderSkuCatalog"
              WHERE "isActive" = true
                AND "parsedJson" IS NOT NULL
                AND "parsedJson"->'regionCodes' ? ${regionCode}
            `;
      }
    }

    const candidates: { draft: AiMappingDraftInternal; specificity: number }[] = [];
    for (const row of rows) {
      const p = row.parsedJson;
      if (!p) continue;

      // Require package type to match: DAYPASS SKU → daily-pack catalog entry, FIXED → non-daily.
      const catalogIsDailyPack = isCatalogDailyPack(row);
      if (isDaypass !== catalogIsDailyPack) continue;

      const dataMatch = p.dataMb === dataMb;

      let confidence: number;
      const reasons: string[] = ['region'];

      if (isDaypass) {
        // FiRoam daypass: productCode contains '?' — these are single-day plans where
        // SKU validity (e.g. 3D) is the subscription length, not the plan period.
        // Skip validity check for FiRoam; enforce it for TGT daily packs.
        const isFiroamDaypass = row.productCode.includes('?');
        const validityMatch = isFiroamDaypass || p.validityDays === validityDays;
        if (!relaxOptions.relaxData && !dataMatch) continue;
        if (!isFiroamDaypass && !relaxOptions.relaxValidity && !validityMatch) continue;
        const matchCount = 1 + (dataMatch ? 1 : 0) + (validityMatch ? 1 : 0);
        confidence = matchCount === 3 ? 1.0 : matchCount === 2 ? 0.8 : 0.6;
        if (dataMatch) reasons.push('data');
        if (validityMatch) reasons.push('validity');
      } else {
        const validityMatch = p.validityDays === validityDays;
        // Apply relaxation: if not relaxed, field must match
        if (!relaxOptions.relaxData && !dataMatch) continue;
        if (!relaxOptions.relaxValidity && !validityMatch) continue;
        // Deterministic confidence: 3/3 = 1.0, 2/3 = 0.8, region only = 0.6
        const matchCount = 1 + (dataMatch ? 1 : 0) + (validityMatch ? 1 : 0);
        confidence = matchCount === 3 ? 1.0 : matchCount === 2 ? 0.8 : 0.6;
        if (dataMatch) reasons.push('data');
        if (validityMatch) reasons.push('validity');
      }

      // Specificity for tie-breaking when picking best per provider:
      //   COUNTRY SKU → fewer parsedJson.regionCodes = more targeted catalog entry.
      //   REGION SKU  → fewer countryCodes (still ⊇ region.countryCodes) = tighter coverage.
      const specificity =
        kind === 'REGION'
          ? (regionCoverageSizeById.get(row.id) ?? Number.MAX_SAFE_INTEGER)
          : p.regionCodes.length;

      candidates.push({
        draft: {
          shopifySku: sku,
          catalogId: row.id,
          productName: row.productName,
          region: row.region,
          dataAmount: row.dataAmount,
          validity: row.validity,
          netPrice: row.netPrice,
          provider: row.provider,
          confidence,
          reason: `Structured match on: ${reasons.join(', ')}`,
          packageType: isDaypass ? 'daypass' : 'fixed',
          daysCount: isDaypass ? validityDays : null,
        },
        specificity,
      });
    }

    // Best-match-per-provider: keep the most specific catalog entry (smallest regionCodes array).
    // Use confidence as tiebreaker when specificity is equal.
    const bestByProvider = new Map<
      string,
      { draft: AiMappingDraftInternal; specificity: number }
    >();
    for (const { draft, specificity } of candidates) {
      const existing = bestByProvider.get(draft.provider);
      if (
        !existing ||
        specificity < existing.specificity ||
        (specificity === existing.specificity && draft.confidence > existing.draft.confidence)
      ) {
        bestByProvider.set(draft.provider, { draft, specificity });
      }
    }

    const drafts = [...bestByProvider.values()]
      .map(({ draft }) => draft)
      .sort((a, b) => b.confidence - a.confidence);
    return drafts;
  }

  /**
   * Background runner for structured map jobs — same DB persistence as runAiMapJobAsync.
   */
  async function runStructuredMapJobAsync(
    jobId: string,
    params: {
      provider?: string;
      unmappedOnly?: boolean;
      inactiveOnly?: boolean;
      relaxOptions?: StructuredRelaxOptions;
    },
  ): Promise<void> {
    const allDrafts: AiMappingDraftInternal[] = [];
    const capturedInputSkus: AiMapInputSku[] = [];

    try {
      // Fetch Shopify SKUs
      let shopifySkuList: AiMapInputSku[];
      try {
        const shopify = getShopifyClient();
        shopifySkuList = await shopify.getAllVariants();
      } catch (error) {
        logger.error({ err: error }, 'Failed to fetch Shopify variants for structured mapping');
        throw new Error('shopify_unavailable');
      }

      // Build the list of (variant, matchProvider) tasks to process.
      // inactiveOnly: one task per stale (shopifySku, provider) pair so matching
      // stays scoped to the provider that owns the stale mapping.
      interface MatchTask {
        variant: AiMapInputSku;
        matchProvider: string | undefined;
      }
      let tasks: MatchTask[];
      let skus: AiMapInputSku[];

      if (params.inactiveOnly) {
        const where = params.provider ? { provider: params.provider } : {};
        const inactiveMapped = await prisma.providerSkuMapping.findMany({
          select: { shopifySku: true, provider: true },
          where: { ...where, catalogEntry: { isActive: false } },
        });
        // Dedupe (shopifySku, provider) pairs then build tasks
        const seen = new Set<string>();
        tasks = [];
        for (const { shopifySku, provider: staleProvider } of inactiveMapped) {
          const key = `${shopifySku}::${staleProvider}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const variant = shopifySkuList.find((v) => v.sku === shopifySku);
          if (variant) tasks.push({ variant, matchProvider: staleProvider });
        }
        // Unique variants for capturedInputSkus
        const variantSeen = new Set<string>();
        skus = [];
        for (const { variant } of tasks) {
          if (!variantSeen.has(variant.sku)) {
            variantSeen.add(variant.sku);
            skus.push(variant);
          }
        }
      } else {
        if (params.unmappedOnly !== false) {
          const where = params.provider ? { provider: params.provider } : {};
          const mappedSkus = await prisma.providerSkuMapping.findMany({
            select: { shopifySku: true },
            distinct: ['shopifySku'],
            where,
          });
          const mappedSet = new Set(mappedSkus.map((m) => m.shopifySku));
          skus = shopifySkuList.filter((v) => !mappedSet.has(v.sku));
        } else {
          skus = shopifySkuList;
        }
        tasks = skus.map((variant) => ({ variant, matchProvider: params.provider }));
      }

      capturedInputSkus.push(...skus);

      const totalBatches = tasks.length; // one "batch" per task for progress granularity
      await prisma.aiMapJob.update({
        where: { id: jobId },
        data: { totalBatches },
      });

      for (let i = 0; i < tasks.length; i++) {
        const { variant, matchProvider } = tasks[i];
        const drafts = await findStructuredMatches(
          variant.sku,
          matchProvider,
          params.relaxOptions ?? {},
        );
        allDrafts.push(...drafts);

        await prisma.aiMapJob.update({
          where: { id: jobId },
          data: {
            completedBatches: i + 1,
            foundSoFar: allDrafts.length,
            draftsJson: allDrafts as unknown as Prisma.JsonArray,
          },
        });
      }

      const matchedSet = new Set(allDrafts.map((d) => d.shopifySku));
      const unmatched = capturedInputSkus.filter((v) => !matchedSet.has(v.sku));

      await prisma.aiMapJob.update({
        where: { id: jobId },
        data: {
          status: 'done',
          completedAt: new Date(),
          unmatchedSkusJson: unmatched as unknown as Prisma.JsonArray,
        },
      });
    } catch (err) {
      logger.error({ err, jobId }, 'Structured map job failed');
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await prisma.aiMapJob.update({
          where: { id: jobId },
          data: {
            status: 'error',
            error: msg,
            completedAt: new Date(),
            unmatchedSkusJson: [] as unknown as Prisma.JsonArray,
          },
        });
      } catch (updateErr) {
        logger.error({ err: updateErr, jobId }, 'Failed to persist structured map job failure');
      }
    }
  }

  /**
   * POST /admin/sku-mappings/structured-map/jobs
   * Creates a persistent job and runs structured matching in the background.
   * Body: { provider?: string; unmappedOnly?: boolean; relaxOptions?: { relaxValidity?: boolean; relaxData?: boolean } }
   */
  app.post(
    '/sku-mappings/structured-map/jobs',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdminKey(request, reply)) return;

      const body = (request.body || {}) as {
        provider?: string;
        unmappedOnly?: boolean;
        inactiveOnly?: boolean;
        relaxOptions?: StructuredRelaxOptions;
      };

      const job = await prisma.aiMapJob.create({
        data: {
          status: 'running',
          provider: body.provider ?? null,
          unmappedOnly: body.unmappedOnly !== false,
        },
      });

      void runStructuredMapJobAsync(job.id, {
        provider: body.provider,
        unmappedOnly: body.unmappedOnly,
        inactiveOnly: body.inactiveOnly,
        relaxOptions: body.relaxOptions,
      });

      return reply.code(201).send({ jobId: job.id });
    },
  );

  /**
   * POST /admin/sku-mappings/structured-match
   * Synchronous single-SKU structured match — no job overhead.
   * Body: { sku: string; relaxOptions?: { relaxValidity?: boolean; relaxData?: boolean } }
   * Response: { drafts: AiMappingDraft[], parsed: ParsedShopifySku | null }
   */
  app.post(
    '/sku-mappings/structured-match',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdminKey(request, reply)) return;

      const body = (request.body || {}) as {
        sku?: string;
        provider?: string;
        relaxOptions?: StructuredRelaxOptions;
      };

      if (!body.sku || typeof body.sku !== 'string') {
        return reply.code(400).send({ error: 'sku is required' });
      }

      const parsed = parseShopifySku(body.sku);
      const drafts = await findStructuredMatches(body.sku, body.provider, body.relaxOptions ?? {});

      return reply.send({ drafts, parsed });
    },
  );

  // ---------------------------------------------------------------------------
  // Provider SKU Catalog
  // ---------------------------------------------------------------------------

  /**
   * GET /admin/provider-catalog
   * List synced provider catalog products for frontend mapping UI.
   * Query: provider, isActive, search, limit, offset
   */
  app.get('/provider-catalog', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const query = request.query as {
      provider?: string;
      isActive?: string;
      search?: string;
      id?: string;
      limit?: string;
      offset?: string;
    };

    const limit = Math.min(parseInt(query.limit || '100', 10), 500);
    const offset = parseInt(query.offset || '0', 10);

    const where: Record<string, unknown> = {};
    if (query.id) where.id = query.id;
    if (query.provider) where.provider = query.provider;
    if (query.isActive !== undefined) where.isActive = query.isActive === 'true';
    if (query.search) {
      where.OR = [
        { productCode: { contains: query.search, mode: 'insensitive' } },
        { productName: { contains: query.search, mode: 'insensitive' } },
        { region: { contains: query.search, mode: 'insensitive' } },
        { skuId: { contains: query.search, mode: 'insensitive' } },
        { skuName: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [items, total, parsedCount] = await Promise.all([
      providerSkuCatalog.findMany({
        where,
        orderBy: { productName: 'asc' },
        skip: offset,
        take: limit,
      }),
      providerSkuCatalog.count({ where }),
      providerSkuCatalog.count({ where: { ...where, parsedJson: { not: Prisma.JsonNull } } }),
    ]);

    return reply.send({ total, parsedCount, limit, offset, items });
  });

  /**
   * POST /admin/provider-catalog/sync
   * Sync provider catalog products into DB.
   * Body: { provider: 'tgt' | 'firoam', pageSize?: number, maxPages?: number, maxSkus?: number }
   *
   * FiRoam: fetches all SKUs then calls getPackages() for each, upserting every
   * plan into ProviderSkuCatalog with productCode = package.apiCode.
   */
  app.post('/provider-catalog/sync', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const body = (request.body || {}) as {
      provider?: string;
      pageSize?: number;
      maxPages?: number;
      lang?: string;
      maxSkus?: number;
    };

    const provider = (body.provider || '').toLowerCase();
    if (provider !== 'tgt' && provider !== 'firoam') {
      return reply.code(400).send({ error: "provider must be 'tgt' or 'firoam'" });
    }

    // ── FiRoam sync ──────────────────────────────────────────────────────────
    if (provider === 'firoam') {
      const maxSkus = Math.min(Math.max(body.maxSkus || 2000, 1), 5000);
      const client = new FiRoamClient();

      const skuResult = await client.getSkus();
      if (!skuResult.skus) {
        return reply.code(502).send({
          error: 'FiRoam getSkus failed',
          raw: skuResult.raw,
        });
      }

      const skus = skuResult.skus.slice(0, maxSkus);
      let processedSkus = 0;
      let processedPackages = 0;
      let skipsNoApiCode = 0;
      const upsertedIds: string[] = [];
      const syncStartedAt = new Date();

      for (const sku of skus) {
        const pkgResult = await client.getPackages(String(sku.skuid));
        processedSkus += 1;

        if (!pkgResult.packageData) continue;

        const pkgData = pkgResult.packageData;

        for (const pkg of pkgData.esimPackageDtoList) {
          if (!pkg.apiCode) {
            skipsNoApiCode += 1;
            continue;
          }

          const skuId = String(sku.skuid);
          const skuName = pkgData.displayEn || sku.display || null;
          const dataAmount = `${pkg.flows}${pkg.unit}`;
          const validity = `${pkg.days} days`;
          const productName = pkgData.displayEn
            ? `${pkgData.displayEn} - ${pkg.showName}`
            : pkg.showName;

          const rawPayload = {
            ...pkg,
            skuId: sku.skuid,
            skuDisplay: sku.display,
            countryCode: sku.countryCode,
            skuCountryCodes: pkgData.supportCountry,
          } as unknown as Prisma.InputJsonValue;

          const countryCodes = pkgData.supportCountry?.length
            ? (pkgData.supportCountry as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull;

          const upserted = await providerSkuCatalog.upsert({
            where: {
              provider_skuId_productCode: {
                provider: 'firoam',
                skuId,
                productCode: pkg.apiCode,
              },
            },
            update: {
              skuName,
              productName,
              productType: null,
              region: sku.countryCode || null,
              countryCodes,
              dataAmount,
              validity,
              netPrice: new Prisma.Decimal(pkg.price),
              currency: 'USD',
              cardType: null,
              activeType: null,
              rawPayload,
              isActive: true,
              lastSyncedAt: new Date(),
            },
            create: {
              provider: 'firoam',
              productCode: pkg.apiCode,
              skuId,
              skuName,
              productName,
              productType: null,
              region: sku.countryCode || null,
              countryCodes,
              dataAmount,
              validity,
              netPrice: new Prisma.Decimal(pkg.price),
              currency: 'USD',
              cardType: null,
              activeType: null,
              rawPayload,
              isActive: true,
              lastSyncedAt: new Date(),
            },
          });

          upsertedIds.push(upserted.id);
          processedPackages += 1;
        }
      }

      const deactivated = await prisma.$executeRaw`
        UPDATE "ProviderSkuCatalog"
        SET "isActive" = false
        WHERE provider = 'firoam'
          AND "lastSyncedAt" < ${syncStartedAt}
          AND "isActive" = true
      `;

      // Fire-and-forget: embedding + parsing runs in the background
      const hasOpenAiKey = !!process.env.OPENAI_API_KEY;
      if (hasOpenAiKey && upsertedIds.length > 0) {
        void (async () => {
          try {
            const entries = (await providerSkuCatalog.findMany({
              where: { id: { in: upsertedIds } },
              select: {
                id: true,
                productName: true,
                region: true,
                dataAmount: true,
                validity: true,
              },
            })) as Array<{
              id: string;
              productName: string;
              region: string | null;
              dataAmount: string | null;
              validity: string | null;
            }>;
            if (entries.length > 0) {
              const openaiSync = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
              const texts = entries.map(buildCatalogText);
              const vectors = await embedBatch(texts, openaiSync);
              await Promise.all(entries.map((e, i) => storeEmbedding(e.id, vectors[i])));
              logger.info({ count: entries.length }, 'Stored catalog embeddings after firoam sync');
            }
          } catch (err) {
            logger.warn({ err }, 'Embedding failed after firoam sync — run backfill to retry');
          }

          try {
            const unparsedEntries = (await providerSkuCatalog.findMany({
              where: { id: { in: upsertedIds } },
              select: {
                id: true,
                productName: true,
                region: true,
                countryCodes: true,
                dataAmount: true,
                validity: true,
              },
            })) as Array<{
              id: string;
              productName: string;
              region: string | null;
              countryCodes: unknown;
              dataAmount: string | null;
              validity: string | null;
            }>;
            const openaiParse = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
            const PARSE_BATCH = 20;
            let firoamParsed = 0;
            for (let i = 0; i < unparsedEntries.length; i += PARSE_BATCH) {
              const batch = unparsedEntries.slice(i, i + PARSE_BATCH);
              await Promise.all(
                batch.map(async (e) => {
                  const parsed = await parseCatalogEntry(e, openaiParse);
                  if (parsed) {
                    await prisma.$executeRaw`
                      UPDATE "ProviderSkuCatalog"
                      SET "parsedJson" = ${JSON.stringify(parsed)}::jsonb
                      WHERE id = ${e.id}
                    `;
                    firoamParsed += 1;
                  }
                }),
              );
            }
            logger.info({ count: firoamParsed }, 'Parsed catalog entries after firoam sync');
          } catch (err) {
            logger.warn({ err }, 'Parsing failed after firoam sync — run parse-all to retry');
          }
        })();
      }

      return reply.send({
        ok: true,
        provider: 'firoam',
        processedSkus,
        processedPackages,
        totalSkus: skuResult.skus.length,
        skipsNoApiCode,
        deactivated,
        background: hasOpenAiKey && upsertedIds.length > 0 ? 'embedding_and_parsing' : 'none',
      });
    }

    const pageSize = Math.min(Math.max(body.pageSize || 100, 1), 100);
    const maxPages = Math.min(Math.max(body.maxPages || 150, 1), 300);
    const lang = body.lang || 'en';

    const client = new TgtClient();
    let pageNum = 1;
    let processed = 0;
    let total = 0;
    const tgtUpsertedIds: string[] = [];
    const tgtSyncStartedAt = new Date();

    while (pageNum <= maxPages) {
      const result = await client.listProducts({ pageNum, pageSize, lang });
      total = result.total;
      request.log.info(
        {
          tgtPage: pageNum,
          fetched: result.products.length,
          total: result.total,
          sample: result.products[0] ?? null,
        },
        'TGT catalog page',
      );

      for (const product of result.products) {
        const dataAmount =
          product.dataTotal !== undefined && product.dataUnit
            ? `${product.dataTotal}${product.dataUnit}`
            : null;
        const validity =
          product.validityPeriod !== undefined ? `${product.validityPeriod} days` : null;

        const tgtUpserted = await providerSkuCatalog.upsert({
          where: {
            provider_skuId_productCode: {
              provider: 'tgt',
              skuId: '',
              productCode: product.productCode,
            },
          },
          update: {
            productName: product.productName,
            productType: product.productType || null,
            region: null,
            countryCodes: product.countryCodeList
              ? (product.countryCodeList as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            dataAmount,
            validity,
            netPrice: new Prisma.Decimal(product.netPrice),
            currency: null,
            cardType: product.cardType || null,
            activeType: product.activeType || null,
            rawPayload: product as unknown as Prisma.InputJsonValue,
            isActive: true,
            lastSyncedAt: new Date(),
          },
          create: {
            provider: 'tgt',
            productCode: product.productCode,
            skuId: '',
            productName: product.productName,
            productType: product.productType || null,
            region: null,
            countryCodes: product.countryCodeList
              ? (product.countryCodeList as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            dataAmount,
            validity,
            netPrice: new Prisma.Decimal(product.netPrice),
            currency: null,
            cardType: product.cardType || null,
            activeType: product.activeType || null,
            rawPayload: product as unknown as Prisma.InputJsonValue,
            isActive: true,
            lastSyncedAt: new Date(),
          },
        });

        tgtUpsertedIds.push(tgtUpserted.id);
        processed += 1;
      }

      if (result.products.length < pageSize || processed >= total) break;
      pageNum += 1;
    }

    const tgtDeactivated = await prisma.$executeRaw`
      UPDATE "ProviderSkuCatalog"
      SET "isActive" = false
      WHERE provider = 'tgt'
        AND "lastSyncedAt" < ${tgtSyncStartedAt}
        AND "isActive" = true
    `;

    // Fire-and-forget: embedding + parsing runs in the background
    const hasOpenAiKeyTgt = !!process.env.OPENAI_API_KEY;
    if (hasOpenAiKeyTgt && tgtUpsertedIds.length > 0) {
      void (async () => {
        try {
          const tgtEntries = (await providerSkuCatalog.findMany({
            where: { id: { in: tgtUpsertedIds } },
            select: {
              id: true,
              productName: true,
              region: true,
              dataAmount: true,
              validity: true,
            },
          })) as Array<{
            id: string;
            productName: string;
            region: string | null;
            dataAmount: string | null;
            validity: string | null;
          }>;
          if (tgtEntries.length > 0) {
            const openaiTgt = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
            const tgtTexts = tgtEntries.map(buildCatalogText);
            const tgtVectors = await embedBatch(tgtTexts, openaiTgt);
            await Promise.all(tgtEntries.map((e, i) => storeEmbedding(e.id, tgtVectors[i])));
            logger.info({ count: tgtEntries.length }, 'Stored catalog embeddings after tgt sync');
          }
        } catch (err) {
          logger.warn({ err }, 'Embedding failed after tgt sync — run backfill to retry');
        }

        try {
          const unparsedTgt = (await providerSkuCatalog.findMany({
            where: { id: { in: tgtUpsertedIds } },
            select: {
              id: true,
              productName: true,
              region: true,
              countryCodes: true,
              dataAmount: true,
              validity: true,
            },
          })) as Array<{
            id: string;
            productName: string;
            region: string | null;
            countryCodes: unknown;
            dataAmount: string | null;
            validity: string | null;
          }>;
          const openaiTgtParse = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
          const PARSE_BATCH = 20;
          let tgtParsed = 0;
          for (let i = 0; i < unparsedTgt.length; i += PARSE_BATCH) {
            const batch = unparsedTgt.slice(i, i + PARSE_BATCH);
            await Promise.all(
              batch.map(async (e) => {
                const parsed = await parseCatalogEntry(e, openaiTgtParse);
                if (parsed) {
                  await prisma.$executeRaw`
                    UPDATE "ProviderSkuCatalog"
                    SET "parsedJson" = ${JSON.stringify(parsed)}::jsonb
                    WHERE id = ${e.id}
                  `;
                  tgtParsed += 1;
                }
              }),
            );
          }
          logger.info({ count: tgtParsed }, 'Parsed catalog entries after tgt sync');
        } catch (err) {
          logger.warn({ err }, 'Parsing failed after tgt sync — run parse-all to retry');
        }
      })();
    }

    return reply.send({
      ok: true,
      provider: 'tgt',
      processed,
      total,
      pages: pageNum,
      deactivated: tgtDeactivated,
      background: hasOpenAiKeyTgt && tgtUpsertedIds.length > 0 ? 'embedding_and_parsing' : 'none',
    });
  });

  /**
   * POST /admin/provider-catalog/parse-all
   * Backfill: AI-parse all catalog entries where parsedJson IS NULL.
   * Uses advisory lock 0xCA7A so concurrent calls are no-ops.
   * Body: { provider?: string }
   */
  app.post('/provider-catalog/parse-all', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return reply.code(500).send({ error: 'OPENAI_API_KEY not configured' });
    }

    const body = (request.body || {}) as { provider?: string };

    const LOCK_ID = 0xca7a;
    const [lockResult] = await prisma.$queryRaw<[{ acquired: boolean }]>`
        SELECT pg_try_advisory_lock(${LOCK_ID}::bigint) AS acquired
      `;
    if (!lockResult.acquired) {
      return reply.send({
        ok: true,
        started: false,
        message: 'Another parse-all is already in progress',
      });
    }

    // Fire and forget — reply immediately so the HTTP request doesn't time out
    void (async () => {
      type UnparsedRow = {
        id: string;
        productName: string;
        region: string | null;
        countryCodes: unknown;
        dataAmount: string | null;
        validity: string | null;
      };

      const BATCH_SIZE = 100;
      let parsed = 0;
      const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

      try {
        let hasMore = true;
        while (hasMore) {
          let rows: UnparsedRow[];
          if (body.provider) {
            rows = await prisma.$queryRaw<UnparsedRow[]>`
                SELECT id, "productName", region, "countryCodes", "dataAmount", validity
                FROM "ProviderSkuCatalog"
                WHERE "parsedJson" IS NULL AND provider = ${body.provider}
                LIMIT ${BATCH_SIZE}
              `;
          } else {
            rows = await prisma.$queryRaw<UnparsedRow[]>`
                SELECT id, "productName", region, "countryCodes", "dataAmount", validity
                FROM "ProviderSkuCatalog"
                WHERE "parsedJson" IS NULL
                LIMIT ${BATCH_SIZE}
              `;
          }
          if (rows.length === 0) {
            hasMore = false;
            break;
          }
          const PARSE_CONCURRENT = 20;
          for (let i = 0; i < rows.length; i += PARSE_CONCURRENT) {
            const chunk = rows.slice(i, i + PARSE_CONCURRENT);
            await Promise.all(
              chunk.map(async (e) => {
                const result = await parseCatalogEntry(e, openai);
                if (result) {
                  await prisma.$executeRaw`
                      UPDATE "ProviderSkuCatalog"
                      SET "parsedJson" = ${JSON.stringify(result)}::jsonb
                      WHERE id = ${e.id}
                    `;
                  parsed += 1;
                }
              }),
            );
          }
          logger.info({ count: rows.length, parsed }, 'parse-all batch complete');
        }
        logger.info({ parsed }, 'parse-all complete');
      } catch (err) {
        logger.error({ err }, 'parse-all failed');
      } finally {
        await prisma.$executeRaw`SELECT pg_advisory_unlock(${LOCK_ID}::bigint)`;
      }
    })();

    return reply.send({
      ok: true,
      started: true,
      message: 'Parsing started in background — check server logs for progress',
    });
  });

  /**
   * POST /admin/provider-catalog/embed-backfill
   * One-time (or re-run) backfill: embeds all catalog entries where embedding IS NULL.
   * Safe to run repeatedly — only processes rows without embeddings.
   * Body: { provider?: string }
   */
  app.post(
    '/provider-catalog/embed-backfill',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdminKey(request, reply)) return;

      const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      if (!OPENAI_API_KEY) {
        return reply.code(500).send({ error: 'OPENAI_API_KEY not configured' });
      }

      const body = (request.body || {}) as { provider?: string };
      const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

      const embedded = await backfillMissingEmbeddings(openai, body.provider);

      return reply.send({ ok: true, embedded });
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // Region CRUD
  //
  // Regions are canonical groupings of countries (e.g. EU30, ASIA4, GCC6)
  // used by region-type ShopifyProductTemplates. The `code` is stable and
  // used in SKUs (REGION-<code>-...); the `countryCodes` list is the
  // canonical coverage we advertise to customers and use for strict-coverage
  // matching against provider SKUs.
  //
  // See docs/implementations/INDEX.md for the broader region SKU work.
  // ────────────────────────────────────────────────────────────────────────

  /** Validate + normalize a country code into uppercase 2-letter form. */
  function normalizeCountryCode(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(trimmed)) return null;
    return trimmed;
  }

  /** Region code: uppercase letters, digits, and dashes; 2–32 chars. */
  function isValidRegionCode(input: unknown): input is string {
    return typeof input === 'string' && /^[A-Z0-9-]{2,32}$/.test(input);
  }

  /** Parent code: uppercase letters and digits; 2–16 chars (no dashes). */
  function isValidParentCode(input: unknown): input is string {
    return typeof input === 'string' && /^[A-Z0-9]{2,16}$/.test(input);
  }

  /**
   * GET /admin/regions
   * List regions. Filters: active=true|false, parentCode=EU.
   */
  app.get('/regions', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const query = (request.query || {}) as { active?: string; parentCode?: string };
    const where: Record<string, unknown> = {};
    if (query.active === 'true') where.isActive = true;
    if (query.active === 'false') where.isActive = false;
    if (query.parentCode) where.parentCode = query.parentCode.toUpperCase();

    const regions = await prisma.region.findMany({
      where,
      include: { _count: { select: { templates: true } } },
      orderBy: [{ parentCode: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }],
    });

    return reply.send({
      total: regions.length,
      regions: regions.map((r) => ({
        id: r.id,
        code: r.code,
        parentCode: r.parentCode,
        name: r.name,
        description: r.description,
        countryCodes: r.countryCodes,
        isActive: r.isActive,
        sortOrder: r.sortOrder,
        templateCount: (r as unknown as { _count: { templates: number } })._count.templates,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  });

  /**
   * GET /admin/regions/suggestions
   * Run discovery against the live ProviderSkuCatalog and return proposed
   * Region rows the admin can review and save. Read-only / side-effect-free.
   *
   * Query params:
   *   unionLimit=<n>  Cap union suggestions at <n> countries (default 60).
   */
  app.get('/regions/suggestions', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const query = (request.query || {}) as { unionLimit?: string };
    const unionLimit =
      query.unionLimit && /^\d+$/.test(query.unionLimit)
        ? Math.min(parseInt(query.unionLimit, 10), 200)
        : undefined;

    const groups = await buildRegionSuggestions({ unionLimit });
    return reply.send({
      total: groups.length,
      suggestionCount: groups.reduce((n, g) => n + g.suggestions.length, 0),
      groups,
    });
  });

  /**
   * POST /admin/regions/accept-suggestion
   * Convenience wrapper: re-runs buildRegionSuggestions(), finds the suggestion
   * by `code`, derives a human-readable `name`, and creates the Region row.
   *
   * Lets the dashboard create a region from a 1-click Accept button without
   * re-encoding any of the suggestion's fields. Same validation as POST /regions
   * applies because we go through the same prisma path.
   *
   * Body: { code: string }
   * Returns: 201 + region | 404 if no matching suggestion | 409 if region already exists
   */
  const PARENT_NAMES: Record<string, string> = {
    EU: 'Europe',
    ASIA: 'Asia',
    GCC: 'GCC',
    ME: 'Middle East',
    AMERICAS: 'Americas',
    GLOBAL: 'Global',
    AFRICA: 'Africa',
    OCEANIA: 'Oceania',
  };

  app.post('/regions/accept-suggestion', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const body = (request.body || {}) as { code?: unknown };
    const codeRaw = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    if (codeRaw.length === 0) {
      return reply.code(400).send({ error: 'code is required' });
    }

    const groups = await buildRegionSuggestions();
    let match: {
      code: string;
      parentCode: string;
      countryCodes: string[];
    } | null = null;
    for (const g of groups) {
      for (const s of g.suggestions) {
        if (s.code === codeRaw) {
          match = { code: s.code, parentCode: s.parentCode, countryCodes: s.countryCodes };
          break;
        }
      }
      if (match) break;
    }

    if (!match) {
      return reply.code(404).send({ error: `No current suggestion with code "${codeRaw}"` });
    }

    const parentName = PARENT_NAMES[match.parentCode] ?? match.parentCode;
    const name = `${parentName} (${match.countryCodes.length} countries)`;

    try {
      const region = await prisma.region.create({
        data: {
          code: match.code,
          parentCode: match.parentCode,
          name,
          countryCodes: match.countryCodes,
          isActive: true,
          sortOrder: 0,
        },
      });
      return reply.code(201).send(region);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(409).send({ error: `Region already exists: ${match.code}` });
      }
      throw err;
    }
  });

  /**
   * GET /admin/regions/:code
   * Get a single region by code.
   */
  app.get('/regions/:code', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const { code } = request.params as { code: string };
    const region = await prisma.region.findUnique({
      where: { code: code.toUpperCase() },
    });

    if (!region) {
      return reply.code(404).send({ error: 'Region not found' });
    }

    return reply.send(region);
  });

  /**
   * POST /admin/regions
   * Create a new region. Body: { code, parentCode, name, countryCodes[], description?, isActive?, sortOrder? }
   */
  app.post('/regions', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const body = (request.body || {}) as Record<string, unknown>;

    const codeRaw = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    if (!isValidRegionCode(codeRaw)) {
      return reply
        .code(400)
        .send({ error: 'code is required (uppercase A-Z, 0-9, -, length 2-32)' });
    }

    const parentRaw =
      typeof body.parentCode === 'string' ? body.parentCode.trim().toUpperCase() : '';
    if (!isValidParentCode(parentRaw)) {
      return reply
        .code(400)
        .send({ error: 'parentCode is required (uppercase A-Z, 0-9, length 2-16)' });
    }

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return reply.code(400).send({ error: 'name is required' });
    }

    if (!Array.isArray(body.countryCodes) || body.countryCodes.length === 0) {
      return reply
        .code(400)
        .send({ error: 'countryCodes is required (non-empty array of ISO 3166-1 alpha-2 codes)' });
    }

    const normalizedCountries: string[] = [];
    for (const cc of body.countryCodes) {
      const norm = normalizeCountryCode(cc);
      if (!norm) {
        return reply
          .code(400)
          .send({ error: `Invalid country code: ${JSON.stringify(cc)} (expected 2-letter ISO)` });
      }
      normalizedCountries.push(norm);
    }
    const dedupedCountries = Array.from(new Set(normalizedCountries));

    try {
      const region = await prisma.region.create({
        data: {
          code: codeRaw,
          parentCode: parentRaw,
          name: body.name.trim(),
          description:
            typeof body.description === 'string' ? body.description.trim() || null : null,
          countryCodes: dedupedCountries,
          isActive: typeof body.isActive === 'boolean' ? body.isActive : true,
          sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : 0,
        },
      });
      return reply.code(201).send(region);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(409).send({ error: `Region code already exists: ${codeRaw}` });
      }
      throw err;
    }
  });

  /**
   * PATCH /admin/regions/:code
   * Update region fields. Code itself is immutable (it's referenced by SKUs).
   */
  app.patch('/regions/:code', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const { code } = request.params as { code: string };
    const body = (request.body || {}) as Record<string, unknown>;

    const data: Record<string, unknown> = {};

    if (body.parentCode !== undefined) {
      const parentRaw =
        typeof body.parentCode === 'string' ? body.parentCode.trim().toUpperCase() : '';
      if (!isValidParentCode(parentRaw)) {
        return reply.code(400).send({ error: 'parentCode invalid' });
      }
      data.parentCode = parentRaw;
    }

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        return reply.code(400).send({ error: 'name must be a non-empty string' });
      }
      data.name = body.name.trim();
    }

    if (body.description !== undefined) {
      data.description =
        typeof body.description === 'string' ? body.description.trim() || null : null;
    }

    if (body.countryCodes !== undefined) {
      if (!Array.isArray(body.countryCodes) || body.countryCodes.length === 0) {
        return reply
          .code(400)
          .send({ error: 'countryCodes must be a non-empty array of ISO 3166-1 alpha-2 codes' });
      }
      const normalized: string[] = [];
      for (const cc of body.countryCodes) {
        const norm = normalizeCountryCode(cc);
        if (!norm) {
          return reply.code(400).send({ error: `Invalid country code: ${JSON.stringify(cc)}` });
        }
        normalized.push(norm);
      }
      data.countryCodes = Array.from(new Set(normalized));
    }

    if (body.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean') {
        return reply.code(400).send({ error: 'isActive must be a boolean' });
      }
      data.isActive = body.isActive;
    }

    if (body.sortOrder !== undefined) {
      if (typeof body.sortOrder !== 'number') {
        return reply.code(400).send({ error: 'sortOrder must be a number' });
      }
      data.sortOrder = body.sortOrder;
    }

    if (Object.keys(data).length === 0) {
      return reply.code(400).send({ error: 'No updatable fields provided' });
    }

    try {
      const updated = await prisma.region.update({
        where: { code: code.toUpperCase() },
        data,
      });
      return reply.send(updated);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return reply.code(404).send({ error: 'Region not found' });
      }
      throw err;
    }
  });

  /**
   * DELETE /admin/regions/:code
   * Hard delete a region. ShopifyProductTemplates referencing it have their
   * regionCode set to NULL (ON DELETE SET NULL) — they become orphaned and
   * the admin should reassign or delete them.
   */
  app.delete('/regions/:code', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdminKey(request, reply)) return;

    const { code } = request.params as { code: string };
    const upper = code.toUpperCase();

    try {
      await prisma.region.delete({ where: { code: upper } });
      return reply.send({ ok: true, deleted: upper });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return reply.code(404).send({ error: 'Region not found' });
      }
      throw err;
    }
  });

  done();
}
