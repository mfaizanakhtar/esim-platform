import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '~/db/prisma';
import { Prisma } from '@prisma/client';
import { getJobQueue } from '~/queue/jobQueue';
import { sendDeliveryEmail, type EsimPayload } from '~/services/email';
import { decrypt } from '~/utils/crypto';
import TgtClient from '~/vendor/tgtClient';
import FiRoamClient from '~/vendor/firoamClient';

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
  // NOTE:
  // `providerSkuCatalog` exists in generated Prisma client, but VS Code's TS server
  // can temporarily report stale diagnostics if Prisma types were generated in a
  // different workspace context. We bind the delegate through a narrow local type
  // so route logic remains strictly typed and resilient to stale editor state.
  type CatalogEntry = {
    id: string;
    provider: string;
    productCode: string;
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
        upsert: (args: unknown) => Promise<unknown>;
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
    const limit = Math.min(parseInt(query.limit || '100', 10), 500);
    const offset = parseInt(query.offset || '0', 10);

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
        orderBy: { shopifySku: 'asc' },
        take: limit,
        skip: offset,
      }),
      prisma.providerSkuMapping.count({ where }),
    ]);

    return reply.send({ total, limit, offset, mappings });
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

    // Check for duplicate shopifySku
    const existing = await prisma.providerSkuMapping.findUnique({ where: { shopifySku } });
    if (existing) {
      return reply.code(409).send({ error: `SKU mapping already exists for: ${shopifySku}` });
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
      ];
    }

    const [items, total] = await Promise.all([
      providerSkuCatalog.findMany({
        where,
        orderBy: { productName: 'asc' },
        skip: offset,
        take: limit,
      }),
      providerSkuCatalog.count({ where }),
    ]);

    return reply.send({ total, limit, offset, items });
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

          await providerSkuCatalog.upsert({
            where: {
              provider_productCode: {
                provider: 'firoam',
                productCode: pkg.apiCode,
              },
            },
            update: {
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

          processedPackages += 1;
        }
      }

      return reply.send({
        ok: true,
        provider: 'firoam',
        processedSkus,
        processedPackages,
        totalSkus: skuResult.skus.length,
        skipsNoApiCode,
      });
    }

    const pageSize = Math.min(Math.max(body.pageSize || 100, 1), 100);
    const maxPages = Math.min(Math.max(body.maxPages || 10, 1), 200);
    const lang = body.lang || 'en';

    const client = new TgtClient();
    let pageNum = 1;
    let processed = 0;
    let total = 0;

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

        await providerSkuCatalog.upsert({
          where: {
            provider_productCode: {
              provider: 'tgt',
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

        processed += 1;
      }

      if (result.products.length < pageSize || processed >= total) break;
      pageNum += 1;
    }

    return reply.send({ ok: true, provider: 'tgt', processed, total, pages: pageNum });
  });

  done();
}
