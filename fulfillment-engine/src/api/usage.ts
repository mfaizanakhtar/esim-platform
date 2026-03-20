import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import prisma from '~/db/prisma';
import FiRoamClient from '~/vendor/firoamClient';
import TgtClient from '~/vendor/tgtClient';
import { decrypt, hashIccid } from '~/utils/crypto';

/**
 * Schema for the JSON stored in EsimDelivery.payloadEncrypted.
 * This is our own data written by finalizeDelivery/provisionEsim, but we
 * validate defensively to avoid runtime errors on old or malformed rows.
 */
const StoredPayloadSchema = z.object({
  vendorId: z.string().optional(),
  lpa: z.string().optional(),
  activationCode: z.string().optional(),
  iccid: z.string().optional(),
  provider: z.string().optional(),
});

type StoredPayload = z.infer<typeof StoredPayloadSchema>;

type DeliveryRow = {
  id: string;
  vendorReferenceId: string | null;
  provider: string | null;
  payloadEncrypted: string | null;
  orderName: string;
  customerEmail: string | null;
};

/**
 * Usage tracking API routes
 * GET /api/esim/:iccid/usage      - Get data usage for specific ICCID
 * GET /api/esim/usage?q=<query>   - Search by ICCID, order number, or email
 */
export default function usageRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
  done: () => void,
) {
  /**
   * GET /api/esim/usage?q=<query>
   * Public search endpoint — accepts ICCID, order number (#1001), or email address.
   * Must be registered BEFORE /:iccid/usage to avoid route conflict.
   */
  app.get(
    '/api/esim/usage',
    async (request: FastifyRequest<{ Querystring: { q?: string } }>, reply: FastifyReply) => {
      const q = (request.query as Record<string, string>).q?.trim();

      if (!q) {
        return reply
          .code(400)
          .send({ error: 'Missing query', message: 'Provide ?q=<iccid|order|email>' });
      }

      try {
        // ── Detect input type ────────────────────────────────────────────────
        if (q.includes('@')) {
          // Email search — may return multiple eSIMs
          return await handleEmailSearch(app, reply, q);
        }

        if (/^#?\d{1,8}$/.test(q)) {
          // Order number search (up to 8 digits — ICCIDs are 18-20 digits)
          const orderName = q.startsWith('#') ? q : `#${q}`;
          return await handleOrderSearch(app, reply, orderName);
        }

        // Default: treat as ICCID
        return await handleIccidSearch(app, reply, q);
      } catch (error) {
        app.log.error({ error }, '[Usage API] Error in search endpoint');
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },
  );

  /**
   * GET /api/esim/:iccid/usage
   * Get current data usage for an eSIM by ICCID
   */
  app.get(
    '/api/esim/:iccid/usage',
    async (request: FastifyRequest<{ Params: { iccid: string } }>, reply: FastifyReply) => {
      const { iccid } = request.params;

      try {
        app.log.info(`[Usage API] Fetching usage for ICCID: ${iccid}`);
        return await handleIccidSearch(app, reply, iccid);
      } catch (error) {
        app.log.error({ error }, '[Usage API] Error fetching usage data');
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },
  );

  done();
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleIccidSearch(app: FastifyInstance, reply: FastifyReply, iccid: string) {
  // Fast path: hash-indexed lookup (O(1)) for rows provisioned after iccidHash was added
  const iccid_hash = hashIccid(iccid);
  const hashed = await prisma.esimDelivery.findFirst({
    where: { iccidHash: iccid_hash, status: 'delivered' },
    select: {
      id: true,
      vendorReferenceId: true,
      provider: true,
      payloadEncrypted: true,
      orderName: true,
      customerEmail: true,
    },
  });

  if (hashed) {
    let storedPayload: StoredPayload | null = null;
    if (hashed.payloadEncrypted) {
      try {
        const result = StoredPayloadSchema.safeParse(JSON.parse(decrypt(hashed.payloadEncrypted)));
        if (result.success) storedPayload = result.data;
      } catch {
        // ignore
      }
    }
    return await dispatchUsageByProvider(app, reply, hashed, storedPayload, iccid);
  }

  // Legacy fallback: full scan + decrypt for rows without iccidHash (provisioned before this feature)
  const deliveries = await prisma.esimDelivery.findMany({
    where: {
      status: 'delivered',
      iccidHash: null,
      payloadEncrypted: { not: null },
    },
    select: {
      id: true,
      vendorReferenceId: true,
      provider: true,
      payloadEncrypted: true,
      orderName: true,
      customerEmail: true,
    },
  });

  let matchingDelivery: DeliveryRow | null = null;
  let storedPayload: StoredPayload | null = null;

  for (const delivery of deliveries) {
    if (delivery.payloadEncrypted) {
      try {
        const decrypted = decrypt(delivery.payloadEncrypted);
        const result = StoredPayloadSchema.safeParse(JSON.parse(decrypted));
        if (!result.success) continue;
        const payload = result.data;
        if (payload.iccid === iccid) {
          matchingDelivery = delivery;
          storedPayload = payload;
          break;
        }
      } catch {
        continue;
      }
    }
  }

  if (!matchingDelivery) {
    return reply.code(404).send({
      error: 'ICCID not found',
      message: 'No delivery record found for this ICCID',
    });
  }

  return await dispatchUsageByProvider(app, reply, matchingDelivery, storedPayload, iccid);
}

async function handleOrderSearch(app: FastifyInstance, reply: FastifyReply, orderName: string) {
  const delivery = await prisma.esimDelivery.findFirst({
    where: { orderName, status: 'delivered' },
    select: {
      id: true,
      vendorReferenceId: true,
      provider: true,
      payloadEncrypted: true,
      orderName: true,
      customerEmail: true,
    },
  });

  if (!delivery) {
    return reply.code(404).send({
      error: 'Order not found',
      message: `No delivered eSIM found for order ${orderName}`,
    });
  }

  // Decrypt to get the ICCID for the response
  let iccid = '';
  let storedPayload: StoredPayload | null = null;
  if (delivery.payloadEncrypted) {
    try {
      const decrypted = decrypt(delivery.payloadEncrypted);
      const result = StoredPayloadSchema.safeParse(JSON.parse(decrypted));
      if (result.success) {
        storedPayload = result.data;
        iccid = result.data.iccid ?? '';
      }
    } catch {
      // ignore
    }
  }

  if (!iccid) {
    return reply.code(404).send({
      error: 'Usage not found',
      message: 'Could not retrieve ICCID for this order',
    });
  }

  return await dispatchUsageByProvider(app, reply, delivery, storedPayload, iccid);
}

async function handleEmailSearch(app: FastifyInstance, reply: FastifyReply, email: string) {
  const deliveries = await prisma.esimDelivery.findMany({
    where: { customerEmail: email, status: 'delivered' },
    select: {
      id: true,
      vendorReferenceId: true,
      provider: true,
      payloadEncrypted: true,
      orderName: true,
      customerEmail: true,
    },
  });

  if (deliveries.length === 0) {
    return reply.code(404).send({
      error: 'Not found',
      message: `No delivered eSIMs found for ${email}`,
    });
  }

  // Fetch usage for each delivery in parallel
  const results = await Promise.all(
    deliveries.map(async (delivery) => {
      let iccid = '';
      let storedPayload: StoredPayload | null = null;
      if (delivery.payloadEncrypted) {
        try {
          const decrypted = decrypt(delivery.payloadEncrypted);
          const parsed = StoredPayloadSchema.safeParse(JSON.parse(decrypted));
          if (parsed.success) {
            storedPayload = parsed.data;
            iccid = parsed.data.iccid ?? '';
          }
        } catch {
          // ignore
        }
      }

      try {
        // Collect the usage response without sending reply
        const usageData = await fetchUsageData(delivery, storedPayload, iccid);
        return usageData;
      } catch {
        return null;
      }
    }),
  );

  const filtered = results.filter((r) => r !== null);
  return reply.send({ results: filtered });
}

// ── Dispatch helpers ──────────────────────────────────────────────────────────

/**
 * Dispatch to the correct provider based on delivery.provider (DB column),
 * falling back to storedPayload.provider for legacy rows, then FiRoam→TGT trial.
 */
async function dispatchUsageByProvider(
  app: FastifyInstance,
  reply: FastifyReply,
  delivery: DeliveryRow,
  storedPayload: StoredPayload | null,
  iccid: string,
) {
  // NOTE: Vendor API calls below are intentionally synchronous and read-only.
  // The "no vendor calls in HTTP handlers" rule applies to provisioning (write) operations.
  // Usage queries are read-only lookups that must return a real-time response.

  const provider = delivery.provider ?? storedPayload?.provider;

  if (provider === 'tgt') {
    return await handleTgtUsage(app, reply, delivery, iccid);
  }

  if (provider === 'firoam') {
    return await handleFiRoamUsage(app, reply, delivery, iccid);
  }

  // Legacy rows (no provider stored): keep existing FiRoam→TGT fallback
  const fiRoam = new FiRoamClient();
  const usageResult = await fiRoam.queryEsimOrder({ iccid });

  if (usageResult.success && usageResult.orders && usageResult.orders.length > 0) {
    const order = usageResult.orders[0];
    const packageData = order.packages.find((pkg) => pkg.iccid === iccid);

    if (packageData) {
      return reply.send(buildFiRoamResponse(delivery.orderName, iccid, order, packageData));
    }
  }

  // FiRoam didn't find it — try TGT using the stored vendorReferenceId (orderNo)
  if (delivery.vendorReferenceId) {
    return await handleTgtUsage(app, reply, delivery, iccid);
  }

  return reply.code(404).send({
    error: 'Usage not found',
    message: 'No usage data available for this ICCID',
  });
}

/**
 * Fetch usage data and return a plain object (for multi-result email responses).
 */
async function fetchUsageData(
  delivery: DeliveryRow,
  storedPayload: StoredPayload | null,
  iccid: string,
): Promise<Record<string, unknown> | null> {
  const provider = delivery.provider ?? storedPayload?.provider;

  if (provider === 'tgt') {
    return fetchTgtUsageData(delivery, iccid);
  }

  if (provider === 'firoam') {
    return fetchFiRoamUsageData(delivery, iccid);
  }

  // Legacy fallback
  const fiRoam = new FiRoamClient();
  const usageResult = await fiRoam.queryEsimOrder({ iccid });

  if (usageResult.success && usageResult.orders && usageResult.orders.length > 0) {
    const order = usageResult.orders[0];
    const packageData = order.packages.find((pkg) => pkg.iccid === iccid);
    if (packageData) {
      return buildFiRoamResponse(delivery.orderName, iccid, order, packageData);
    }
  }

  if (delivery.vendorReferenceId) {
    return fetchTgtUsageData(delivery, iccid);
  }

  return null;
}

// ── Provider-specific helpers ─────────────────────────────────────────────────

async function handleFiRoamUsage(
  app: FastifyInstance,
  reply: FastifyReply,
  delivery: DeliveryRow,
  iccid: string,
) {
  const data = await fetchFiRoamUsageData(delivery, iccid);
  if (!data) {
    return reply
      .code(404)
      .send({ error: 'Usage not found', message: 'FiRoam returned no usage data for this ICCID' });
  }
  reply.header('Cache-Control', 'public, max-age=300, s-maxage=300');
  return reply.send(data);
}

async function fetchFiRoamUsageData(
  delivery: DeliveryRow,
  iccid: string,
): Promise<Record<string, unknown> | null> {
  const fiRoam = new FiRoamClient();
  const usageResult = await fiRoam.queryEsimOrder({ iccid });

  if (!usageResult.success || !usageResult.orders || usageResult.orders.length === 0) {
    return null;
  }

  const order = usageResult.orders[0];
  const packageData = order.packages.find((pkg) => pkg.iccid === iccid);
  if (!packageData) return null;

  return buildFiRoamResponse(delivery.orderName, iccid, order, packageData);
}

function buildFiRoamResponse(
  orderName: string,
  iccid: string,
  order: { skuId: unknown; skuName: unknown; createTime: unknown },
  packageData: {
    flows: unknown;
    unit: unknown;
    usedMb: unknown;
    days: unknown;
    name: unknown;
    beginDate: unknown;
    endDate: unknown;
    status: unknown;
  },
): Record<string, unknown> {
  const totalMb =
    packageData.unit === 'GB'
      ? (packageData.flows as number) * 1024
      : (packageData.flows as number);
  const usedMb = packageData.usedMb as number;
  const usagePercent = totalMb > 0 ? (usedMb / totalMb) * 100 : 0;

  return {
    iccid,
    provider: 'firoam',
    orderNum: orderName,
    packageName: packageData.name,
    region: order.skuName,
    usage: {
      total: packageData.flows,
      unit: packageData.unit,
      totalMb,
      usedMb,
      remainingMb: totalMb - usedMb,
      usagePercent: Math.round(usagePercent * 100) / 100,
    },
    validity: {
      days: packageData.days,
      beginDate: packageData.beginDate,
      endDate: packageData.endDate,
    },
    status: packageData.status,
    orderDetails: {
      skuId: order.skuId,
      skuName: order.skuName,
      createTime: order.createTime,
    },
  };
}

async function handleTgtUsage(
  app: FastifyInstance,
  reply: FastifyReply,
  delivery: DeliveryRow,
  iccid: string,
) {
  if (!delivery.vendorReferenceId) {
    return reply.code(404).send({
      error: 'Usage not found',
      message: 'No vendor order reference available for TGT usage lookup',
    });
  }
  const data = await fetchTgtUsageData(delivery, iccid);
  if (!data) {
    return reply.code(404).send({
      error: 'Usage not found',
      message: 'TGT returned no usage data for this order',
    });
  }
  reply.header('Cache-Control', 'public, max-age=300, s-maxage=300');
  return reply.send(data);
}

async function fetchTgtUsageData(
  delivery: DeliveryRow,
  iccid: string,
): Promise<Record<string, unknown> | null> {
  const orderNo = delivery.vendorReferenceId;
  if (!orderNo) return null;

  const tgt = new TgtClient();
  const { usage } = await tgt.getUsage(orderNo);

  if (!usage) return null;

  return {
    iccid,
    provider: 'tgt',
    orderNum: delivery.orderName,
    vendorOrderNo: orderNo,
    usage: {
      dataTotal: usage.dataTotal ?? null,
      dataUsage: usage.dataUsage ?? null,
      dataResidual: usage.dataResidual ?? null,
      refuelingTotal: usage.refuelingTotal ?? null,
    },
  };
}
