import prisma from '~/db/prisma';
import TgtClient from '~/vendor/tgtClient';
import { finalizeDelivery } from '~/worker/jobs/finalizeDelivery';
import { getJobQueue } from '~/queue/jobQueue';
import { getTgtPollIntervalSeconds } from '~/vendor/tgtConfig';
import { logger } from '~/utils/logger';

interface TgtPollJobData {
  deliveryId: string;
  orderNo: string;
  attempt: number;
  maxAttempts: number;
  mode: 'hybrid' | 'polling';
}

export async function handleTgtPoll(data: TgtPollJobData) {
  const delivery = await prisma.esimDelivery.findUnique({ where: { id: data.deliveryId } });
  if (!delivery) {
    return { ok: true, reason: 'delivery_not_found' };
  }

  if (delivery.status === 'delivered') {
    return { ok: true, reason: 'already_delivered' };
  }

  const client = new TgtClient();
  const resolved = await client.tryResolveOrderCredentials(data.orderNo);

  if (resolved.ready && resolved.lpa) {
    await finalizeDelivery({
      deliveryId: data.deliveryId,
      vendorOrderId: data.orderNo,
      lpa: resolved.lpa,
      activationCode: resolved.activationCode || '',
      iccid: resolved.iccid || '',
    });
    return { ok: true, reason: 'resolved' };
  }

  if (data.attempt >= data.maxAttempts) {
    if (data.mode === 'polling') {
      await prisma.esimDelivery.update({
        where: { id: data.deliveryId },
        data: {
          status: 'failed',
          lastError: `TGT polling exhausted after ${data.maxAttempts} attempts`,
        },
      });
    } else {
      await prisma.esimDelivery.update({
        where: { id: data.deliveryId },
        data: {
          status: 'awaiting_callback',
          lastError: `TGT polling exhausted after ${data.maxAttempts} attempts (waiting callback)`,
        },
      });
    }

    logger.warn(
      { deliveryId: data.deliveryId, orderNo: data.orderNo, mode: data.mode },
      'TGT poll attempts exhausted',
    );
    return { ok: true, reason: 'poll_exhausted' };
  }

  const queue = getJobQueue();
  await queue.send(
    'tgt-poll-order',
    {
      ...data,
      attempt: data.attempt + 1,
    },
    {
      startAfter: getTgtPollIntervalSeconds(),
    },
  );

  await prisma.esimDelivery.update({
    where: { id: data.deliveryId },
    data: {
      status: 'polling',
      lastError: null,
    },
  });

  return { ok: true, reason: 'requeued' };
}
