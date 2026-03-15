import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '~/db/prisma';
import FiRoamClient from '~/vendor/firoamClient';
import TgtClient from '~/vendor/tgtClient';
import { decrypt } from '~/utils/crypto';

/**
 * Usage tracking API routes
 * GET /api/esim/:iccid/usage - Get data usage for specific ICCID
 */
export default function usageRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
  done: () => void,
) {
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

        // Find the delivery record by decrypting payloads and searching for ICCID
        const deliveries = await prisma.esimDelivery.findMany({
          where: {
            status: 'delivered',
            payloadEncrypted: { not: null },
          },
          select: {
            id: true,
            vendorReferenceId: true,
            payloadEncrypted: true,
            orderName: true,
            customerEmail: true,
          },
        });

        type StoredPayload = {
          vendorId?: string;
          lpa?: string;
          activationCode?: string;
          iccid?: string;
          provider?: string;
        };

        let matchingDelivery: (typeof deliveries)[number] | null = null;
        let storedPayload: StoredPayload | null = null;

        for (const delivery of deliveries) {
          if (delivery.payloadEncrypted) {
            try {
              const decrypted = decrypt(delivery.payloadEncrypted);
              const payload = JSON.parse(decrypted) as StoredPayload;
              if (payload.iccid === iccid) {
                matchingDelivery = delivery;
                storedPayload = payload;
                break;
              }
            } catch (err) {
              // Skip invalid payloads
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

        // If the payload explicitly marks this as TGT, skip FiRoam entirely
        if (storedPayload?.provider === 'tgt') {
          return await handleTgtUsage(app, reply, matchingDelivery, iccid);
        }

        // Try FiRoam first (covers FiRoam and legacy deliveries)
        const fiRoam = new FiRoamClient();
        const usageResult = await fiRoam.queryEsimOrder({ iccid });

        if (usageResult.success && usageResult.orders && usageResult.orders.length > 0) {
          const order = usageResult.orders[0];
          const packageData = order.packages.find((pkg) => pkg.iccid === iccid);

          if (packageData) {
            const totalMb =
              packageData.unit === 'GB'
                ? (packageData.flows as number) * 1024
                : (packageData.flows as number);
            const usedMb = packageData.usedMb as number;
            const usagePercent = totalMb > 0 ? (usedMb / totalMb) * 100 : 0;

            reply.header('Cache-Control', 'public, max-age=300, s-maxage=300');

            return reply.send({
              iccid,
              provider: 'firoam',
              orderNum: matchingDelivery.orderName,
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
            });
          }
        }

        // FiRoam didn't find it — try TGT using the stored vendorReferenceId (orderNo)
        if (matchingDelivery.vendorReferenceId) {
          return await handleTgtUsage(app, reply, matchingDelivery, iccid);
        }

        return reply.code(404).send({
          error: 'Usage not found',
          message: 'No usage data available for this ICCID',
        });
      } catch (error) {
        app.log.error({ error }, '[Usage API] Error fetching usage data');
        return reply.code(500).send({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
  );

  done();
}

async function handleTgtUsage(
  app: FastifyInstance,
  reply: FastifyReply,
  delivery: { vendorReferenceId: string | null; orderName: string },
  iccid: string,
) {
  const orderNo = delivery.vendorReferenceId;
  if (!orderNo) {
    return reply.code(404).send({
      error: 'Usage not found',
      message: 'No vendor order reference available for TGT usage lookup',
    });
  }

  const tgt = new TgtClient();
  const { usage } = await tgt.getUsage(orderNo);

  if (!usage) {
    return reply.code(404).send({
      error: 'Usage not found',
      message: 'TGT returned no usage data for this order',
    });
  }

  reply.header('Cache-Control', 'public, max-age=300, s-maxage=300');

  return reply.send({
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
  });
}
