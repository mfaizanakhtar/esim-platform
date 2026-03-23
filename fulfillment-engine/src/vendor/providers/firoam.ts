import type {
  VendorProvider,
  ProviderMappingConfig,
  ProvisionContext,
  EsimProvisionResult,
} from '~/vendor/types';
import FiRoamClient from '~/vendor/firoamClient';
import type { FiRoamOrderData } from '~/vendor/firoamSchemas';
import { logger } from '~/utils/logger';
import { MappingError, VendorError } from '~/utils/errors';
import prisma from '~/db/prisma';

/**
 * FiRoam vendor implementation of VendorProvider.
 *
 * Encapsulates all FiRoam-specific provisioning logic:
 * - Parsing the `"skuId:apiCode:priceId"` providerSku format
 * - Daypass package lookup via FiRoam's getPackages API (legacy path)
 * - Building and sending the addEsimOrder payload
 * - Normalising the FiRoam response to EsimProvisionResult
 *
 * The underlying FiRoamClient (auth, signing, HTTP) is unchanged.
 */
export class FiRoamProvider implements VendorProvider {
  readonly name = 'firoam';
  private client: FiRoamClient;

  /**
   * @param client - Optional FiRoamClient instance (used for injection in tests).
   *                 Defaults to a new FiRoamClient() configured from env vars.
   */
  constructor(client?: FiRoamClient) {
    this.client = client ?? new FiRoamClient();
  }

  async provision(
    config: ProviderMappingConfig,
    ctx: ProvisionContext,
  ): Promise<EsimProvisionResult> {
    //
    // 1. Resolve skuId, apiCode, storedPriceId — either from catalog or legacy colon-string
    //
    let skuId: string;
    let apiCode: string;
    let storedPriceId: string | null;

    if (config.providerCatalogId) {
      // Catalog-linked path: look up the catalog entry for authoritative fields
      const entry = await (
        prisma as unknown as {
          providerSkuCatalog: {
            findUniqueOrThrow: (args: {
              where: { id: string };
            }) => Promise<{ productCode: string; skuId: string; rawPayload: unknown }>;
          };
        }
      ).providerSkuCatalog.findUniqueOrThrow({ where: { id: config.providerCatalogId } });

      // skuId is now a top-level column — no rawPayload parsing needed
      skuId = entry.skuId;
      apiCode = entry.productCode; // may contain '?' for daypass
      const raw = entry.rawPayload as { priceid?: unknown } | null;
      storedPriceId = raw?.priceid != null ? String(raw.priceid) : null;

      if (!skuId) {
        throw new MappingError(`Catalog entry ${config.providerCatalogId} is missing skuId`);
      }
    } else {
      // Legacy path: parse colon-separated providerSku
      // New format:    "skuId:apiCode:priceId"   e.g. "120:826-0-?-1-G-D:14094"
      // Legacy format: "skuId:apiCode"           e.g. "156:14791"
      const parts = config.providerSku.split(':');
      if (parts.length < 2) {
        throw new MappingError(
          `Invalid providerSku format: ${config.providerSku}. Expected "skuId:apiCode:priceId" or "skuId:apiCode".`,
        );
      }
      skuId = parts[0];
      apiCode = parts[1];
      storedPriceId = parts[2] ?? null;
    }

    //
    // 2. Build base order payload
    //
    const orderPayload: Record<string, unknown> = {
      skuId,
      count: String(ctx.quantity),
      backInfo: '1', // One-step flow: get full eSIM details immediately
      customerEmail: ctx.customerEmail || undefined,
    };

    //
    // 3. Resolve priceId — differs for fixed vs daypass packages
    //
    if (config.packageType === 'daypass') {
      if (!config.daysCount) {
        throw new MappingError(
          `Daypass package requires daysCount in mapping (providerSku: ${config.providerSku})`,
        );
      }

      const apiCodeWithDays = apiCode.replace('?', String(config.daysCount));

      if (storedPriceId) {
        // New format — priceId already stored in the mapping row
        logger.info(
          { days: config.daysCount, priceId: storedPriceId },
          'Daypass: using stored priceId',
        );
        orderPayload.priceId = storedPriceId;
      } else {
        // Legacy format — look up the numeric priceId from FiRoam's packages API
        logger.info(
          { days: config.daysCount, apiCode: apiCodeWithDays },
          'Daypass: looking up priceid',
        );

        const packagesResult = await this.client.getPackages(skuId);
        if (!packagesResult.packageData) {
          throw new VendorError(
            `Failed to fetch packages for skuId ${skuId}: ${String(packagesResult.error) || 'Unknown error'}`,
          );
        }

        const esimPackages = packagesResult.packageData.esimPackageDtoList || [];
        const matchingPkg =
          esimPackages.find((pkg) => pkg.apiCode === apiCodeWithDays) ??
          esimPackages.find(
            (pkg) =>
              pkg.supportDaypass === 1 && pkg.flows === parseInt(apiCode.split('-')[3] ?? '0', 10),
          );

        if (!matchingPkg) {
          logger.info(
            {
              packages: esimPackages.map((p) => ({
                apiCode: p.apiCode,
                priceid: p.priceid,
                supportDaypass: p.supportDaypass,
              })),
            },
            'Available packages',
          );
          throw new MappingError(
            `No matching daypass package found for apiCode: ${apiCodeWithDays}`,
          );
        }

        orderPayload.priceId = String(matchingPkg.priceid);
        logger.info({ priceid: matchingPkg.priceid }, 'Found daypass package');
      }

      orderPayload.daypassDays = String(config.daysCount);
    } else {
      // Fixed package: use storedPriceId if present, else fall back to apiCode (legacy)
      orderPayload.priceId = storedPriceId ?? apiCode;
    }

    //
    // 4. Place the order
    //
    const result = await this.client.addEsimOrder(orderPayload);

    if (!result.canonical || !result.db) {
      const errorMsg = result.error
        ? `FiRoam error: ${String(result.error)}`
        : 'FiRoam returned unexpected response';
      logger.error({ errorMsg, raw: result.raw }, 'Provision failed');
      throw new VendorError(errorMsg);
    }

    //
    // 5. Extract vendorOrderId from raw response
    //
    const rawData = result.raw.data;
    const vendorOrderId =
      typeof rawData === 'string' ? rawData : (rawData as FiRoamOrderData | undefined)?.orderNum;

    if (!vendorOrderId) {
      throw new VendorError('No order number in FiRoam response');
    }

    logger.info({ vendorOrderId }, 'Order created');

    return {
      vendorOrderId: String(vendorOrderId),
      lpa: result.canonical.lpa ?? '',
      activationCode: result.canonical.activationCode ?? '',
      iccid: result.canonical.iccid ?? '',
    };
  }
}
