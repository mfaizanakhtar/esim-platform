import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '~/db/prisma';
import FiRoamClient from '~/vendor/firoamClient';
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

        let matchingDelivery = null;
        for (const delivery of deliveries) {
          if (delivery.payloadEncrypted) {
            try {
              const decrypted = decrypt(delivery.payloadEncrypted);
              const payload = JSON.parse(decrypted);
              if (payload.iccid === iccid) {
                matchingDelivery = delivery;
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

        // Query FiRoam for current usage data
        const fiRoam = new FiRoamClient();
        const usageResult = await fiRoam.queryEsimOrder({ iccid });

        if (!usageResult.success || !usageResult.orders || usageResult.orders.length === 0) {
          return reply.code(500).send({
            error: 'Failed to fetch usage data',
            message: usageResult.error || 'No usage data available',
          });
        }

        // Find the package with matching ICCID
        const order = usageResult.orders[0];
        const packageData = order.packages.find((pkg) => pkg.iccid === iccid);

        if (!packageData) {
          return reply.code(404).send({
            error: 'Package not found',
            message: 'ICCID not found in order packages',
          });
        }

        // Calculate usage percentage
        const totalMb =
          packageData.unit === 'GB'
            ? (packageData.flows as number) * 1024
            : (packageData.flows as number);
        const usedMb = packageData.usedMb as number;
        const usagePercent = totalMb > 0 ? (usedMb / totalMb) * 100 : 0;

        // Set cache headers to reduce vendor API calls
        // Usage data doesn't change frequently, cache for 5 minutes
        reply.header('Cache-Control', 'public, max-age=300, s-maxage=300');

        // Return formatted usage data
        return reply.send({
          iccid,
          orderNum: matchingDelivery.orderName, // Shopify order number (e.g., #1001)
          packageName: packageData.name,
          region: order.skuName, // Region/country from SKU name
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
