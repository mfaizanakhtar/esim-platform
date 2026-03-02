import type {
  VendorProvider,
  ProviderMappingConfig,
  ProvisionContext,
  EsimProvisionResult,
} from '../types';
import FiRoamClient from '../firoamClient';
import type { FiRoamOrderData } from '../firoamSchemas';

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
    // 1. Parse providerSku
    //    New format:    "skuId:apiCode:priceId"   e.g. "120:826-0-?-1-G-D:14094"
    //    Legacy format: "skuId:apiCode"           e.g. "156:14791"
    //
    const parts = config.providerSku.split(':');
    if (parts.length < 2) {
      throw new Error(
        `Invalid providerSku format: ${config.providerSku}. Expected "skuId:apiCode:priceId" or "skuId:apiCode".`,
      );
    }

    const skuId = parts[0];
    const apiCode = parts[1];
    const storedPriceId = parts[2] ?? null;

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
        throw new Error(
          `Daypass package requires daysCount in mapping (providerSku: ${config.providerSku})`,
        );
      }

      const apiCodeWithDays = apiCode.replace('?', String(config.daysCount));

      if (storedPriceId) {
        // New format — priceId already stored in the mapping row
        console.log(
          `[FiRoamProvider] Daypass: ${config.daysCount} days, using stored priceId: ${storedPriceId}`,
        );
        orderPayload.priceId = storedPriceId;
      } else {
        // Legacy format — look up the numeric priceId from FiRoam's packages API
        console.log(
          `[FiRoamProvider] Daypass: ${config.daysCount} days, looking up priceid for apiCode: ${apiCodeWithDays}`,
        );

        const packagesResult = await this.client.getPackages(skuId);
        if (!packagesResult.packageData) {
          throw new Error(
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
          console.log(
            `[FiRoamProvider] Available packages:`,
            esimPackages.map((p) => ({
              apiCode: p.apiCode,
              priceid: p.priceid,
              supportDaypass: p.supportDaypass,
            })),
          );
          throw new Error(`No matching daypass package found for apiCode: ${apiCodeWithDays}`);
        }

        orderPayload.priceId = String(matchingPkg.priceid);
        console.log(`[FiRoamProvider] Found daypass package, priceid: ${matchingPkg.priceid}`);
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
      console.log(`[FiRoamProvider] Provision failed: ${errorMsg}`);
      console.log('[FiRoamProvider] Raw response:', JSON.stringify(result.raw, null, 2));
      throw new Error(errorMsg);
    }

    //
    // 5. Extract vendorOrderId from raw response
    //
    const rawData = result.raw.data;
    const vendorOrderId =
      typeof rawData === 'string' ? rawData : (rawData as FiRoamOrderData | undefined)?.orderNum;

    if (!vendorOrderId) {
      throw new Error('No order number in FiRoam response');
    }

    console.log(`[FiRoamProvider] Order created: ${vendorOrderId}`);

    return {
      vendorOrderId: String(vendorOrderId),
      lpa: result.canonical.lpa ?? '',
      activationCode: result.canonical.activationCode ?? '',
      iccid: result.canonical.iccid ?? '',
    };
  }
}
