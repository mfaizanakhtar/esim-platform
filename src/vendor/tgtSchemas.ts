import { z } from 'zod';

export const TgtBaseResponseSchema = z.object({
  code: z.string(),
  msg: z.string(),
  subCode: z.string().optional(),
  subMsg: z.string().optional(),
});

export const TgtTokenInfoSchema = z.object({
  accessToken: z.string(),
  expires: z.coerce.number(),
});

export const TgtTokenResponseSchema = TgtBaseResponseSchema.extend({
  data: TgtTokenInfoSchema.optional(),
});

export const TgtTopupInfoSchema = z.object({
  topupId: z.string(),
  topupName: z.string(),
  topupSize: z.string(),
  topupUnit: z.string(),
  topupPrice: z.coerce.number(),
});

export const TgtProductSchema = z.object({
  productCode: z.string(),
  productName: z.string(),
  productType: z.string(),
  countryCodeList: z.array(z.string()).optional(),
  mccList: z.array(z.string()).optional(),
  netPrice: z.coerce.number(),
  periodType: z.coerce.number().optional(),
  usagePeriod: z.coerce.number().optional(),
  validityPeriod: z.coerce.number().optional(),
  dataLimited: z.string().optional(),
  dataTotal: z.coerce.number().optional(),
  dataUnit: z.string().optional(),
  lastModifiedTime: z.string().optional(),
  activeType: z.string().optional(),
  cardType: z.string().optional(),
  topupInfoList: z.array(TgtTopupInfoSchema).optional(),
});

export const TgtProductsListResponseSchema = TgtBaseResponseSchema.extend({
  data: z
    .object({
      total: z.coerce.number(),
      list: z.array(TgtProductSchema),
    })
    .optional(),
});

export const TgtCreateOrderResponseSchema = TgtBaseResponseSchema.extend({
  data: z
    .object({
      orderNo: z.string(),
    })
    .optional(),
});

export const TgtCardInfoSchema = z.object({
  iccid: z.string().optional(),
  imsi: z.string().optional(),
  msisdn: z.string().optional(),
  rentalContractNumber: z.string().optional(),
});

export const TgtOrderInfoSchema = z.object({
  orderNo: z.string(),
  productCode: z.string().optional(),
  productName: z.string().optional(),
  activatedStartTime: z.string().optional(),
  activatedEndTime: z.string().optional(),
  latestActivationTime: z.string().optional(),
  renewExpirationTime: z.string().optional(),
  createdTime: z.string().optional(),
  orderStatus: z.string().optional(),
  profileStatus: z.string().optional(),
  qrCode: z.string().optional(),
  channelOrderNo: z.string().optional(),
  orderType: z.string().optional(),
  cardInfo: TgtCardInfoSchema.optional(),
  iccid: z.string().optional(),
  imsi: z.string().optional(),
  msisdn: z.string().optional(),
});

export const TgtQueryOrdersResponseSchema = TgtBaseResponseSchema.extend({
  data: z
    .object({
      list: z.array(TgtOrderInfoSchema),
    })
    .optional(),
});

export const TgtUsageInfoSchema = z.object({
  dataTotal: z.string().optional(),
  dataUsage: z.string().optional(),
  dataResidual: z.string().optional(),
  refuelingTotal: z.string().optional(),
  qtaconsumption: z.string().optional(),
});

export const TgtUsageResponseSchema = TgtBaseResponseSchema.extend({
  data: TgtUsageInfoSchema.optional(),
});

export const TgtCallbackOrderInfoSchema = z.object({
  orderNo: z.string(),
  iccid: z.string().optional(),
  qrCode: z.string().optional(),
  channelOrderNo: z.string().optional(),
  imsi: z.string().optional(),
  msisdn: z.string().optional(),
  activatedStartTime: z.string().optional(),
  activatedEndTime: z.string().optional(),
  latestActivationTime: z.string().optional(),
  renewExpirationTime: z.string().optional(),
  createdTime: z.string().optional(),
  orderType: z.string().optional(),
});

export const TgtCallbackDataSchema = z.object({
  eventType: z.coerce.number(),
  businessType: z.string().optional(),
  idempotencyKey: z.string().optional(),
  orderInfo: z.union([TgtCallbackOrderInfoSchema, z.array(TgtCallbackOrderInfoSchema)]),
});

export const TgtCallbackSchema = z.object({
  code: z.string(),
  msg: z.string(),
  timestamp: z.string(),
  sign: z.string(),
  data: TgtCallbackDataSchema,
});

export type TgtProduct = z.infer<typeof TgtProductSchema>;
export type TgtOrderInfo = z.infer<typeof TgtOrderInfoSchema>;
export type TgtCallbackPayload = z.infer<typeof TgtCallbackSchema>;
