import { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import prisma from '~/db/prisma';
import { finalizeDelivery } from '~/worker/jobs/finalizeDelivery';
import { TgtCallbackSchema } from '~/vendor/tgtSchemas';
import TgtClient from '~/vendor/tgtClient';
import { getTgtCallbackSecret } from '~/vendor/tgtConfig';

export default function tgtCallbackRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
  done: () => void,
) {
  app.post('/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    const parse = TgtCallbackSchema.safeParse(request.body);
    if (!parse.success) {
      app.log.error({ issues: parse.error.issues }, 'Invalid TGT callback payload');
      return reply.code(400).send({ code: '0001', msg: 'invalid request' });
    }

    const payload = parse.data;
    const secret = getTgtCallbackSecret();
    if (!secret) {
      app.log.error('TGT callback secret not configured');
      return reply.code(500).send({ code: '0001', msg: 'server misconfiguration' });
    }

    const { sign, ...withoutSign } = payload;
    const valid = TgtClient.verifyCallbackSignature(withoutSign, sign, secret);
    if (!valid) {
      app.log.error({ orderNo: payload.data.orderInfo }, 'Invalid TGT callback signature');
      return reply.code(401).send({ code: '0001', msg: 'invalid signature' });
    }

    const orderInfos = Array.isArray(payload.data.orderInfo)
      ? payload.data.orderInfo
      : [payload.data.orderInfo];

    for (const orderInfo of orderInfos) {
      const orderNo = orderInfo.orderNo;
      if (!orderNo) continue;

      const delivery = await prisma.esimDelivery.findFirst({
        where: { vendorReferenceId: orderNo },
      });

      if (!delivery) {
        app.log.warn({ orderNo }, 'TGT callback for unknown order');
        continue;
      }

      if (!orderInfo.qrCode || !orderInfo.qrCode.startsWith('LPA:')) {
        app.log.info({ orderNo }, 'TGT callback received without credentials yet');
        continue;
      }

      const parts = orderInfo.qrCode.split('$');
      const activationCode = parts.length >= 3 ? parts[2] : '';

      await finalizeDelivery({
        deliveryId: delivery.id,
        vendorOrderId: orderNo,
        lpa: orderInfo.qrCode,
        activationCode,
        iccid: orderInfo.iccid || '',
        provider: 'tgt',
      });
    }

    return reply.send({ code: '0000', msg: 'success' });
  });

  done();
}
