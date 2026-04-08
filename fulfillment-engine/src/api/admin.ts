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
              packageType: entry.productCode?.includes('?') ? 'daypass' : 'fixed',
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
            packageType: entry.productCode?.includes('?') ? 'daypass' : 'fixed',
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

      // Sort unlocked by netPrice ascending
      unlocked.sort((a, b) => {
        const pa = Number(a.catalogEntry!.netPrice!);
        const pb = Number(b.catalogEntry!.netPrice!);
        return pa - pb;
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
   * Fetch all product variant SKUs from Shopify.
   * Query: unmappedOnly=true — exclude SKUs already in ProviderSkuMapping
   *        provider=firoam|tgt — when combined with unmappedOnly, only excludes SKUs
   *          already mapped for that specific provider (not any provider)
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
    const search = (query.search ?? '').toLowerCase().trim();
    const parsedLimit = Number.parseInt(query.limit ?? '25', 10);
    const parsedOffset = Number.parseInt(query.offset ?? '0', 10);
    const limit = Math.min(Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 25), 500);
    const offset = Math.max(0, Number.isFinite(parsedOffset) ? parsedOffset : 0);

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
      logger.error({ err: error }, 'Failed to fetch Shopify variants');
      return reply.code(502).send({ error: 'shopify_unavailable' });
    }

    // Apply status (mapped / unmapped) filter
    let filtered = allVariants;
    if (status !== 'all') {
      let mappedSkus: Array<{ shopifySku: string }>;
      try {
        mappedSkus = await prisma.providerSkuMapping.findMany({
          select: { shopifySku: true },
          distinct: ['shopifySku'],
          where: {
            isActive: true,
            ...(providerFilter ? { provider: providerFilter } : {}),
          },
        });
      } catch (err) {
        logger.error(
          { err, status, providerFilter },
          'Failed to query mapped SKUs for status filter',
        );
        return reply.code(500).send({ error: 'db_unavailable' });
      }
      const mappedSet = new Set(mappedSkus.map((m) => m.shopifySku));
      filtered =
        status === 'unmapped'
          ? allVariants.filter((v) => !mappedSet.has(v.sku))
          : allVariants.filter((v) => mappedSet.has(v.sku));
    }

    // Apply search filter
    if (search) {
      filtered = filtered.filter(
        (v) =>
          v.sku.toLowerCase().includes(search) || v.productTitle.toLowerCase().includes(search),
      );
    }

    const total = filtered.length;
    const skus = filtered.slice(offset, offset + limit);

    return reply.send({ skus, total });
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
        productName: string;
        region: string | null;
        dataAmount: string | null;
        validity: string | null;
        netPrice: unknown;
        parsedJson: ParsedCatalogAttributes | null;
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
                    ? 'Validity IS required to match: REJECT any catalog entry where validityDays ≠ SKU validityDays. EXCEPTION: if skuType is DAYPASS, skip this check (DAYPASS have no fixed validity).'
                    : 'Validity is NOT required to match — allow validity mismatches.';
                const systemPrompt = `You are an eSIM product matcher. ${requireDataNote} ${requireValidityNote} Region match is ALWAYS required. Parsed numeric fields (dataMb, validityDays) are provided directly — use them for exact comparison. For each Shopify SKU you are given its top-10 most semantically similar catalog candidates. Pick the best match per SKU or omit if none are suitable. Confidence reflects structural match quality. Return only JSON.`;
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
                    });
                  }
                  // Hard post-filter: enforce relaxOptions deterministically regardless of GPT output
                  const filteredDrafts = drafts.filter((draft) => {
                    const parsedSku = parseShopifySku(draft.shopifySku);
                    if (!parsedSku) return true;
                    const entry = catalogEntries.find((e) => e.id === draft.catalogId);
                    if (!entry?.parsedJson) {
                      // Unverifiable — only pass through if both constraints are relaxed
                      return (
                        relaxOptions?.requireData === false &&
                        relaxOptions?.requireValidity === false
                      );
                    }
                    if (!entry.parsedJson.regionCodes.includes(parsedSku.regionCode)) return false;
                    if (
                      relaxOptions?.requireData !== false &&
                      entry.parsedJson.dataMb !== parsedSku.dataMb
                    )
                      return false;
                    if (
                      relaxOptions?.requireValidity !== false &&
                      parsedSku.skuType !== 'DAYPASS' &&
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
              ? 'Validity IS required to match: REJECT any catalog entry where validityDays ≠ SKU validityDays. EXCEPTION: if skuType is DAYPASS, skip this check (DAYPASS have no fixed validity).'
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
                    if (!entry.parsedJson.regionCodes.includes(parsedSku.regionCode)) continue;
                    if (
                      relaxOptions?.requireData !== false &&
                      entry.parsedJson.dataMb !== parsedSku.dataMb
                    )
                      continue;
                    if (
                      relaxOptions?.requireValidity !== false &&
                      parsedSku.skuType !== 'DAYPASS' &&
                      entry.parsedJson.validityDays !== parsedSku.validityDays
                    )
                      continue;
                  }
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
  };

  type ParsedCatalogRow = {
    id: string;
    provider: string;
    productName: string;
    region: string | null;
    dataAmount: string | null;
    validity: string | null;
    netPrice: unknown;
    parsedJson: ParsedCatalogAttributes | null;
  };

  async function findStructuredMatches(
    sku: string,
    provider: string | undefined,
    relaxOptions: StructuredRelaxOptions,
  ): Promise<AiMappingDraftInternal[]> {
    const parsed = parseShopifySku(sku);
    if (!parsed) return [];

    const { regionCode, dataMb, validityDays, skuType } = parsed;
    const isDaypass = skuType === 'DAYPASS';

    // JSONB containment query: regionCodes array must contain this regionCode
    let rows: ParsedCatalogRow[];
    if (provider) {
      rows = await prisma.$queryRaw<ParsedCatalogRow[]>`
        SELECT id, provider, "productName", region, "dataAmount", validity, "netPrice",
               "parsedJson"
        FROM "ProviderSkuCatalog"
        WHERE "isActive" = true
          AND "parsedJson" IS NOT NULL
          AND provider = ${provider}
          AND "parsedJson"->'regionCodes' ? ${regionCode}
      `;
    } else {
      rows = await prisma.$queryRaw<ParsedCatalogRow[]>`
        SELECT id, provider, "productName", region, "dataAmount", validity, "netPrice",
               "parsedJson"
        FROM "ProviderSkuCatalog"
        WHERE "isActive" = true
          AND "parsedJson" IS NOT NULL
          AND "parsedJson"->'regionCodes' ? ${regionCode}
      `;
    }

    const candidates: { draft: AiMappingDraftInternal; specificity: number }[] = [];
    for (const row of rows) {
      const p = row.parsedJson;
      if (!p) continue;

      const dataMatch = p.dataMb === dataMb;

      let confidence: number;
      const reasons: string[] = ['region'];

      if (isDaypass) {
        // For daypass SKUs, validity is irrelevant — the provider handles daily renewal.
        // Region + data match = full confidence.
        if (!relaxOptions.relaxData && !dataMatch) continue;
        confidence = dataMatch ? 1.0 : 0.6;
        if (dataMatch) reasons.push('data');
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
        },
        // Fewer region codes = more targeted product (SA-only beats Middle East beats Global)
        specificity: p.regionCodes.length,
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

      // Filter unmapped if requested
      let skus = shopifySkuList;
      if (params.unmappedOnly !== false) {
        const where = params.provider ? { provider: params.provider } : {};
        const mappedSkus = await prisma.providerSkuMapping.findMany({
          select: { shopifySku: true },
          distinct: ['shopifySku'],
          where,
        });
        const mappedSet = new Set(mappedSkus.map((m) => m.shopifySku));
        skus = shopifySkuList.filter((v) => !mappedSet.has(v.sku));
      }

      capturedInputSkus.push(...skus);

      const totalBatches = skus.length; // one "batch" per SKU for progress granularity
      await prisma.aiMapJob.update({
        where: { id: jobId },
        data: { totalBatches },
      });

      for (let i = 0; i < skus.length; i++) {
        const variant = skus[i];
        const drafts = await findStructuredMatches(
          variant.sku,
          params.provider,
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
      limit?: string;
      offset?: string;
    };

    const limit = Math.min(parseInt(query.limit || '100', 10), 500);
    const offset = parseInt(query.offset || '0', 10);

    const where: Record<string, unknown> = {};
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
      const maxSkus = Math.min(Math.max(body.maxSkus || 500, 1), 2000);
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

      let embedded = 0;
      const OPENAI_API_KEY_SYNC = process.env.OPENAI_API_KEY;
      if (OPENAI_API_KEY_SYNC && upsertedIds.length > 0) {
        try {
          const entries = (await providerSkuCatalog.findMany({
            where: { id: { in: upsertedIds } },
            select: { id: true, productName: true, region: true, dataAmount: true, validity: true },
          })) as Array<{
            id: string;
            productName: string;
            region: string | null;
            dataAmount: string | null;
            validity: string | null;
          }>;
          if (entries.length > 0) {
            const openaiSync = new OpenAI({ apiKey: OPENAI_API_KEY_SYNC });
            const texts = entries.map(buildCatalogText);
            const vectors = await embedBatch(texts, openaiSync);
            await Promise.all(entries.map((e, i) => storeEmbedding(e.id, vectors[i])));
            embedded = entries.length;
            logger.info({ count: entries.length }, 'Stored catalog embeddings after firoam sync');
          }
        } catch (err) {
          logger.warn({ err }, 'Embedding failed after firoam sync — run backfill to retry');
        }
      }

      let firoamParsed = 0;
      if (OPENAI_API_KEY_SYNC && upsertedIds.length > 0) {
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
          const openaiParse = new OpenAI({ apiKey: OPENAI_API_KEY_SYNC });
          const PARSE_BATCH = 20;
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
      }

      return reply.send({
        ok: true,
        provider: 'firoam',
        processedSkus,
        processedPackages,
        totalSkus: skuResult.skus.length,
        skipsNoApiCode,
        embedded,
        parsed: firoamParsed,
      });
    }

    const pageSize = Math.min(Math.max(body.pageSize || 100, 1), 100);
    const maxPages = Math.min(Math.max(body.maxPages || 10, 1), 200);
    const lang = body.lang || 'en';

    const client = new TgtClient();
    let pageNum = 1;
    let processed = 0;
    let total = 0;
    const tgtUpsertedIds: string[] = [];

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

    let tgtEmbedded = 0;
    const OPENAI_API_KEY_TGT = process.env.OPENAI_API_KEY;
    if (OPENAI_API_KEY_TGT && tgtUpsertedIds.length > 0) {
      try {
        const tgtEntries = (await providerSkuCatalog.findMany({
          where: { id: { in: tgtUpsertedIds } },
          select: { id: true, productName: true, region: true, dataAmount: true, validity: true },
        })) as Array<{
          id: string;
          productName: string;
          region: string | null;
          dataAmount: string | null;
          validity: string | null;
        }>;
        if (tgtEntries.length > 0) {
          const openaiTgt = new OpenAI({ apiKey: OPENAI_API_KEY_TGT });
          const tgtTexts = tgtEntries.map(buildCatalogText);
          const tgtVectors = await embedBatch(tgtTexts, openaiTgt);
          await Promise.all(tgtEntries.map((e, i) => storeEmbedding(e.id, tgtVectors[i])));
          tgtEmbedded = tgtEntries.length;
          logger.info({ count: tgtEntries.length }, 'Stored catalog embeddings after tgt sync');
        }
      } catch (err) {
        logger.warn({ err }, 'Embedding failed after tgt sync — run backfill to retry');
      }
    }

    let tgtParsed = 0;
    const OPENAI_API_KEY_TGT_PARSE = process.env.OPENAI_API_KEY;
    if (OPENAI_API_KEY_TGT_PARSE && tgtUpsertedIds.length > 0) {
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
        const openaiTgtParse = new OpenAI({ apiKey: OPENAI_API_KEY_TGT_PARSE });
        const PARSE_BATCH = 20;
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
    }

    return reply.send({
      ok: true,
      provider: 'tgt',
      processed,
      total,
      pages: pageNum,
      embedded: tgtEmbedded,
      parsed: tgtParsed,
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

  done();
}
