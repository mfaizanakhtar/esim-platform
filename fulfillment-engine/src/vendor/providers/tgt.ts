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
      const entry = await prisma.providerSkuCatalog.findUnique({
        where: { id: config.providerCatalogId },
        select: { productCode: true },
      });
      if (!entry) {
        throw new MappingError(`Catalog entry not found: ${config.providerCatalogId}`);
      }
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

    // ── Top-up / Renewal path ─────────────────────────────────────────────
    if (ctx.topupIccid) {
      const { orders } = await this.client.queryOrders({ iccid: ctx.topupIccid });
      // Sort descending by createdTime so the most-recent order is always first,
      // regardless of the API's default ordering.
      const sorted = [...orders].sort((a, b) => {
        const ta = a.createdTime ?? '';
        const tb = b.createdTime ?? '';
        return tb.localeCompare(ta);
      });
      const currentOrder = sorted[0];
      if (!currentOrder) {
        throw new VendorError(`TGT: no existing order found for ICCID ${ctx.topupIccid}`);
      }

      const isC4 = currentOrder.productCode?.includes('-C4-') ?? false;

      // Stable idempotency key derived from deliveryId to prevent double-billing on retries
      const stableKey = ctx.deliveryId ? `topup-${ctx.deliveryId}` : crypto.randomUUID();

      if (isC4) {
        // C4 daily pack: synchronous data top-up
        const purchaseType =
          typeof providerConfig.tgtPurchaseType === 'number'
            ? (providerConfig.tgtPurchaseType as number)
            : 1;
        const { topupNumber } = await this.client.createTopup({
          orderNo: currentOrder.orderNo,
          purchaseType,
          idempotencyKey: stableKey,
        });
        return {
          vendorOrderId: topupNumber,
          lpa: '',
          activationCode: '',
          iccid: ctx.topupIccid,
        };
      } else {
        // M1/C2/F2: async renewal with new product code
        const { orderNo } = await this.client.renewOrder({
          iccid: ctx.topupIccid,
          productCode,
          idempotencyKey: stableKey,
          channelOrderNo: (ctx.deliveryId || crypto.randomUUID()).slice(0, 100),
        });
        return {
          vendorOrderId: orderNo,
          lpa: '',
          activationCode: '',
          iccid: '',
          pending: true,
        };
      }
    }

    const startDate =
      typeof providerConfig.startDate === 'string' ? providerConfig.startDate : undefined;

    const channelOrderNo = (ctx.deliveryId || crypto.randomUUID()).slice(0, 100);
    const idempotencyKey = crypto.randomUUID();

    const { orderNo } = await this.client.createOrder({
      productCode,
      channelOrderNo,
      idempotencyKey,
      // Omit email so TGT does not send their own QR email — we send via Resend instead
      email: undefined,
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
