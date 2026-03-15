import crypto from 'crypto';
import type {
  VendorProvider,
  ProviderMappingConfig,
  ProvisionContext,
  EsimProvisionResult,
} from '~/vendor/types';
import TgtClient from '~/vendor/tgtClient';
import {
  getTgtFulfillmentMode,
  getTgtPollIntervalSeconds,
  getTgtPollMaxAttempts,
} from '~/vendor/tgtConfig';
import { MappingError, VendorError } from '~/utils/errors';
import prisma from '~/db/prisma';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TgtProvider implements VendorProvider {
  readonly name = 'tgt';
  private client: TgtClient;

  constructor(client?: TgtClient) {
    this.client = client ?? new TgtClient();
  }

  async provision(
    config: ProviderMappingConfig,
    ctx: ProvisionContext,
  ): Promise<EsimProvisionResult> {
    let productCode: string;

    if (config.providerCatalogId) {
      // Catalog-linked path: use productCode directly from catalog entry
      const entry = await (
        prisma as unknown as {
          providerSkuCatalog: {
            findUniqueOrThrow: (args: {
              where: { id: string };
            }) => Promise<{ productCode: string }>;
          };
        }
      ).providerSkuCatalog.findUniqueOrThrow({ where: { id: config.providerCatalogId } });
      productCode = entry.productCode;
    } else {
      // Legacy path: providerSku is the productCode directly
      productCode = config.providerSku;
    }

    if (!productCode || typeof productCode !== 'string') {
      throw new MappingError(
        'Invalid TGT productCode: expected non-empty string from mapping/catalog',
      );
    }

    const providerConfig = (config.providerConfig ?? {}) as Record<string, unknown>;
    const startDate =
      typeof providerConfig.startDate === 'string' ? providerConfig.startDate : undefined;

    const channelOrderNo = (ctx.deliveryId || crypto.randomUUID()).slice(0, 100);
    const idempotencyKey = crypto.randomUUID();

    const { orderNo } = await this.client.createOrder({
      productCode,
      channelOrderNo,
      idempotencyKey,
      email: ctx.customerEmail || undefined,
      startDate,
    });

    const mode = getTgtFulfillmentMode();

    if (mode === 'callback' || mode === 'hybrid') {
      return {
        vendorOrderId: orderNo,
        lpa: '',
        activationCode: '',
        iccid: '',
        pending: true,
      };
    }

    // polling mode (blocking in this worker execution)
    const intervalSeconds = getTgtPollIntervalSeconds();
    const maxAttempts = getTgtPollMaxAttempts();

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const resolved = await this.client.tryResolveOrderCredentials(orderNo);
      if (resolved.ready && resolved.lpa) {
        return {
          vendorOrderId: orderNo,
          lpa: resolved.lpa,
          activationCode: resolved.activationCode || '',
          iccid: resolved.iccid || '',
        };
      }
      if (attempt < maxAttempts) {
        await sleep(intervalSeconds * 1000);
      }
    }

    throw new VendorError(`TGT order ${orderNo} created but credentials not ready after polling`);
  }
}
