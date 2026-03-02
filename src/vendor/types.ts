/**
 * Shared vendor provider types.
 *
 * All eSIM vendor implementations must implement VendorProvider.
 *
 * To add a new vendor:
 *   1. Create `src/vendor/providers/<vendor>.ts` implementing VendorProvider
 *   2. Register it in `src/vendor/registry.ts`
 *   3. Add ProviderSkuMapping rows via the admin API (no deploy required)
 */

/**
 * Normalised eSIM credentials returned by any vendor after successful provisioning.
 */
export interface EsimProvisionResult {
  /** Vendor's internal order reference — used for tracking, cancellations, and audit. */
  vendorOrderId: string;
  /** LPA string — used to generate the QR code (e.g. "LPA:1$smdp.example.com$ABC123"). */
  lpa: string;
  /** Manual activation code shown as a text alternative to QR scanning. */
  activationCode: string;
  /** SIM identifier. */
  iccid: string;
}

/**
 * What the provider receives from a `ProviderSkuMapping` DB row.
 * Each vendor class interprets these fields according to its own API contract.
 */
export interface ProviderMappingConfig {
  /**
   * Opaque identifier — each provider class knows how to parse its own format.
   * - FiRoam: `"skuId:apiCode:priceId"` (e.g. `"120:826-0-?-1-G-D:14094"`)
   * - Airalo: package slug (e.g. `"airalo-europe-5gb"`)
   */
  providerSku: string;
  /** Vendor-specific structured extras stored as JSON in the DB. */
  providerConfig?: Record<string, unknown> | null;
  /** `'fixed'` | `'daypass'` — FiRoam concept; may be ignored by other vendors. */
  packageType?: string | null;
  /** Number of days for daypass packages. */
  daysCount?: number | null;
}

/**
 * Caller-supplied runtime context that vendor implementations may need.
 */
export interface ProvisionContext {
  /** Customer email address. May be an empty string if not available. */
  customerEmail: string;
  /** Number of eSIMs to provision (usually 1). */
  quantity: number;
}

/**
 * Contract that every eSIM vendor implementation must satisfy.
 * Register implementations in `src/vendor/registry.ts`.
 */
export interface VendorProvider {
  readonly name: string;
  provision(config: ProviderMappingConfig, context: ProvisionContext): Promise<EsimProvisionResult>;
}
