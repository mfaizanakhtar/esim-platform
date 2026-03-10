import { z } from 'zod';

export const CanonicalEsimPayloadSchema = z.object({
  vendorId: z.string().optional(),
  lpa: z.string().optional(),
  activationCode: z.string().optional(),
  iccid: z.string().optional(),
});

export type CanonicalEsimPayload = z.infer<typeof CanonicalEsimPayloadSchema>;

export function validateCanonical(payload: unknown) {
  return CanonicalEsimPayloadSchema.parse(payload);
}

// Schema for the request payload sent to FiRoam's addEsimOrder endpoint.
export const AddEsimOrderSchema = z
  .object({
    // Required fields per FiRoam documentation
    skuId: z.string(), // Product ID (country)
    priceId: z.string().optional(), // Package price ID (optional for daypass with API code)
    count: z.string(), // Order quantity
    // Conditional fields
    daypassDays: z.string().optional(), // Required if supportDaypass=1
    beginDate: z.string().optional(), // Required if mustDate=1, format: MM/dd/yyyy
    // Optional fields
    remark: z.string().optional(),
    otherOrderId: z.string().optional(),
    otherItemId: z.string().optional(),
    otherPrice: z.string().optional(),
    backInfo: z.string().optional(),
    dpId: z.string().optional(),
    iccids: z.string().optional(),
    customerEmail: z.string().optional(),
    isSendEmail: z.string().optional(),
    pdfLanguage: z.string().optional(),
  })
  .passthrough(); // Allow additional vendor-specific fields

export type AddEsimOrderInput = z.infer<typeof AddEsimOrderSchema>;

export function validateAddEsimOrder(payload: unknown) {
  return AddEsimOrderSchema.parse(payload);
}

// SKU schemas
export const SkuItemSchema = z.object({
  skuid: z.coerce.number(),
  display: z.string(),
  countryCode: z.string(),
});

export const GetSkusSchema = z.array(SkuItemSchema);
export type SkuItem = z.infer<typeof SkuItemSchema>;

export function validateSkus(payload: unknown) {
  return GetSkusSchema.parse(payload);
}

// Package/Plan schemas
export const NetworkDtoSchema = z.object({
  type: z.string(), // e.g., "LTE"
  operator: z.string(),
  namecn: z.string(),
  nameen: z.string(),
});

export const CountryImageUrlDtoSchema = z.object({
  imageUrl: z.string(),
  countryCode: z.number(),
  name: z.string(),
  nameEn: z.string(),
});

export const EsimPackageDtoSchema = z.object({
  flows: z.number(), // Traffic in package
  days: z.number(), // Days of validity
  unit: z.string(), // GB/MB
  price: z.number(), // Package price
  priceid: z.number(), // Unique identification (used for ordering)
  flowType: z.number(), // 0-renewable, 1-non-renewable
  countryImageUrlDtoList: z.array(CountryImageUrlDtoSchema).nullable(),
  showName: z.string(), // Display name
  pid: z.number(),
  premark: z.string(), // Description
  expireDays: z.number(), // 0-effective immediately, non-zero-expires after n days
  networkDtoList: z.array(NetworkDtoSchema),
  supportDaypass: z.number(), // 0-Regular, 1-Inclusive, 2-Enum package
  openCardFee: z.number(),
  minDay: z.number(),
  singleDiscountDay: z.number(),
  singleDiscount: z.number(),
  maxDiscount: z.number(),
  maxDay: z.number(),
  mustDate: z.number(), // 1-Required
  apiCode: z.string(), // Unique identifier for the package
});

export const PackageItemSchema = z.object({
  skuid: z.number(),
  detailId: z.number().nullable(),
  countrycode: z.string(),
  imageUrl: z.string(),
  display: z.string(),
  displayEn: z.string(),
  esimPackageDtoList: z.array(EsimPackageDtoSchema),
  supportCountry: z.array(z.string()),
  expirydate: z.string().nullable(),
  countryImageUrlDtoList: z.array(CountryImageUrlDtoSchema),
});

export const GetPackagesSchema = PackageItemSchema;
export type PackageItem = z.infer<typeof PackageItemSchema>;
export type EsimPackageDto = z.infer<typeof EsimPackageDtoSchema>;

export function validatePackages(payload: unknown) {
  return GetPackagesSchema.parse(payload);
}

// Refund/Cancel Order response schema
export const RefundOrderSchema = z.object({
  code: z.union([z.number(), z.string()]),
  message: z.string(),
  data: z.null().or(z.string()),
});

export type RefundOrderResponse = z.infer<typeof RefundOrderSchema>;

export function validateRefundOrder(payload: unknown) {
  return RefundOrderSchema.parse(payload);
}

// SKU grouped by continent schemas
export const SkuNewDtoSchema = z.object({
  skuid: z.number(),
  countryCode: z.number(),
  imageUrl: z.string(),
  display: z.string(),
  note: z.string(),
  search: z.string(),
  continentCode: z.number(),
});

export const GetSkuByGroupSchema = z.object({
  continent: z.array(z.string()),
  data: z.record(z.string(), z.array(SkuNewDtoSchema)),
});

export type SkuByGroup = z.infer<typeof GetSkuByGroupSchema>;
export type SkuNewDto = z.infer<typeof SkuNewDtoSchema>;

export function validateSkuByGroup(payload: unknown) {
  return GetSkuByGroupSchema.parse(payload);
}

// ---------------------------------------------------------------------------
// Raw FiRoam API response shapes — used to eliminate `unknown` casts in
// firoamClient.ts.  These are plain interfaces (not Zod schemas) because the
// raw responses arrive before any validation step.
// ---------------------------------------------------------------------------

/** Common response envelope returned by every FiRoam endpoint. */
export interface FiRoamApiResponse {
  code: number | string;
  message?: string;
  /** Payload varies per endpoint — narrow with a concrete interface at call sites. */
  data?: unknown;
}

/** eSIM card credentials included in order responses.
 *  FiRoam uses different field names across API versions, so all variants are
 *  listed as optional. */
export interface FiRoamCard {
  /** LPA string (v1 field name) */
  code?: string;
  lpa?: string;
  lpaString?: string;
  sm_dp_address?: string;
  activationCode?: string;
  activation_code?: string;
  iccid?: string;
  /** Sometimes used as ICCID in older response formats. */
  mobileNumber?: string;
}

/** Order details object inside the `data` field of order responses. */
export interface FiRoamOrderData {
  orderNum?: string;
  cardApiDtoList?: FiRoamCard[];
  cards?: FiRoamCard[];
  cardList?: FiRoamCard[];
}

/** Package / usage entry inside a `queryEsimOrder` row. */
export interface FiRoamPackageUsage {
  iccid?: string;
  flows?: number;
  unit?: string;
  usedMb?: number;
  days?: number;
  name?: string;
  beginDate?: string;
  endDate?: string;
  status?: string;
  priceId?: string;
}

/** Order row returned in the paginated `queryEsimOrder` response. */
export interface FiRoamOrderRow {
  orderNum?: string;
  skuId?: string;
  skuName?: string;
  createTime?: string;
  status?: string;
  packageList?: FiRoamPackageUsage[];
}

/** Paginated wrapper inside the `data` field of a `queryEsimOrder` response. */
export interface FiRoamQueryData {
  rows?: FiRoamOrderRow[];
  total?: number;
  page?: number;
}
