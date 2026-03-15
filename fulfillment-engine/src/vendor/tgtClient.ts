import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { VendorError, MappingError } from '~/utils/errors';
import {
  TgtCreateOrderResponseSchema,
  TgtProductsListResponseSchema,
  TgtQueryOrdersResponseSchema,
  TgtTokenResponseSchema,
  TgtUsageResponseSchema,
  type TgtOrderInfo,
  type TgtProduct,
} from '~/vendor/tgtSchemas';

interface TgtApiResponse<T = unknown> {
  code: string;
  msg: string;
  subCode?: string;
  subMsg?: string;
  data?: T;
}

type FlatParams = Record<string, unknown>;

export function flattenParams(value: unknown, parentKey = '', out: string[] = []): string[] {
  if (value === null || value === undefined) return out;

  if (typeof value !== 'object' || Array.isArray(value)) {
    if (parentKey && String(value).trim() !== '') {
      out.push(`${parentKey}${String(value)}`);
    }
    return out;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'sign') continue;
    if (child === null || child === undefined) continue;
    if (typeof child === 'string' && child.trim() === '') continue;

    const currentKey = parentKey ? `${parentKey}.${key}` : key;

    if (Array.isArray(child)) {
      child.forEach((item, index) => {
        const arrKey = `${currentKey}.${index}`;
        if (item !== null && item !== undefined && String(item).trim() !== '') {
          if (typeof item === 'object') {
            flattenParams(item, arrKey, out);
          } else {
            out.push(`${arrKey}${String(item)}`);
          }
        }
      });
      continue;
    }

    if (typeof child === 'object') {
      flattenParams(child, currentKey, out);
    } else {
      out.push(`${currentKey}${String(child)}`);
    }
  }

  return out;
}

export function createTgtSignature(payload: unknown, secret: string): string {
  const pairs = flattenParams(payload);
  pairs.sort();
  const signSource = `${secret}${pairs.join('')}${secret}`;
  return crypto.createHash('md5').update(signSource, 'utf8').digest('hex');
}

export default class TgtClient {
  private readonly baseUrl: string;
  private readonly accountId?: string;
  private readonly secret?: string;
  private readonly http: AxiosInstance;
  private accessToken?: string;
  private accessTokenExpiry?: number;

  constructor() {
    this.baseUrl = process.env.TGT_BASE_URL || 'https://enterpriseapi.tugegroup.com:8070/openapi';
    this.accountId = process.env.TGT_ACCOUNT_ID;
    this.secret = process.env.TGT_SECRET;
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 20000,
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    });
  }

  static verifyCallbackSignature(
    payloadWithoutSign: unknown,
    receivedSign: string,
    secret: string,
  ) {
    const expected = createTgtSignature(payloadWithoutSign, secret);
    return expected.toLowerCase() === receivedSign.toLowerCase();
  }

  private requireCredentials() {
    if (!this.accountId || !this.secret) {
      throw new MappingError('TGT_ACCOUNT_ID/TGT_SECRET not set');
    }
  }

  private async authIfNeeded(): Promise<string> {
    this.requireCredentials();

    const now = Date.now();
    if (
      this.accessToken &&
      this.accessTokenExpiry &&
      this.accessTokenExpiry > now + 5 * 60 * 1000
    ) {
      return this.accessToken;
    }

    const response = await this.http.post('/oauth/token', {
      accountId: this.accountId,
      secret: this.secret,
    });

    const parsed = TgtTokenResponseSchema.parse(response.data);
    const tokenValue = parsed.data?.accessToken ?? parsed.data?.token;
    if (parsed.code !== '0000' || !tokenValue) {
      throw new VendorError(
        `TGT auth failed [code=${parsed.code}]: ${parsed.msg}` +
          (parsed.subCode ? ` subCode=${parsed.subCode}: ${parsed.subMsg}` : ''),
      );
    }

    this.accessToken = tokenValue;
    this.accessTokenExpiry = Date.now() + parsed.data!.expires * 1000;
    return this.accessToken;
  }

  private async post<T>(
    path: string,
    body: FlatParams,
    retryOnTokenError = true,
  ): Promise<TgtApiResponse<T>> {
    const token = await this.authIfNeeded();

    const response = await this.http.post(path, body, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = response.data as TgtApiResponse<T>;

    if (retryOnTokenError && (data.code === '2003' || data.code === '2004')) {
      this.accessToken = undefined;
      this.accessTokenExpiry = undefined;
      return this.post<T>(path, body, false);
    }

    return data;
  }

  async listProducts(params: {
    pageNum?: number;
    pageSize?: number;
    productType?: string;
    cardType?: string;
    usagePeriod?: number;
    periodType?: number;
    lang?: string;
  }): Promise<{ raw: TgtApiResponse; products: TgtProduct[]; total: number }> {
    const payload = {
      pageNum: params.pageNum ?? 1,
      pageSize: params.pageSize ?? 100,
      productType: params.productType,
      cardType: params.cardType,
      usagePeriod: params.usagePeriod,
      periodType: params.periodType,
      lang: params.lang ?? 'en',
    };

    const raw = await this.post('/eSIMApi/v2/products/list', payload);
    const parsed = TgtProductsListResponseSchema.parse(raw);

    if (parsed.code !== '0000') {
      throw new VendorError(`TGT products list failed: ${parsed.msg} (${parsed.subCode || 'n/a'})`);
    }

    return {
      raw,
      products: parsed.data?.list ?? [],
      total: parsed.data?.total ?? 0,
    };
  }

  async createOrder(params: {
    productCode: string;
    channelOrderNo: string;
    idempotencyKey: string;
    email?: string;
    startDate?: string;
  }): Promise<{ raw: TgtApiResponse; orderNo: string }> {
    const body: Record<string, unknown> = {
      productCode: params.productCode,
      channelOrderNo: params.channelOrderNo,
      idempotencyKey: params.idempotencyKey,
    };
    if (params.email) body.email = params.email;
    if (params.startDate) body.startDate = params.startDate;

    const raw = await this.post<{ orderNo: string }>('/eSIMApi/v2/order/create', body);
    const parsed = TgtCreateOrderResponseSchema.parse(raw);

    if (parsed.code !== '0000' || !parsed.data?.orderNo) {
      throw new VendorError(`TGT createOrder failed: ${parsed.msg} (${parsed.subCode || 'n/a'})`);
    }

    return { raw, orderNo: parsed.data.orderNo };
  }

  async queryOrders(params: {
    orderNo?: string;
    iccid?: string;
    channelOrderNo?: string;
    lang?: string;
  }): Promise<{ raw: TgtApiResponse; orders: TgtOrderInfo[] }> {
    const raw = await this.post('/eSIMApi/v2/order/orders', {
      orderNo: params.orderNo,
      iccid: params.iccid,
      channelOrderNo: params.channelOrderNo,
      lang: params.lang ?? 'en',
    });

    const parsed = TgtQueryOrdersResponseSchema.parse(raw);
    if (parsed.code !== '0000') {
      throw new VendorError(`TGT queryOrders failed: ${parsed.msg} (${parsed.subCode || 'n/a'})`);
    }

    return { raw, orders: parsed.data?.list ?? [] };
  }

  async getUsage(orderNo: string) {
    const raw = await this.post('/eSIMApi/v2/order/usage', { orderNo });
    const parsed = TgtUsageResponseSchema.parse(raw);

    if (parsed.code !== '0000') {
      throw new VendorError(`TGT usage failed: ${parsed.msg} (${parsed.subCode || 'n/a'})`);
    }

    return { raw, usage: parsed.data };
  }

  async tryResolveOrderCredentials(orderNo: string): Promise<{
    ready: boolean;
    lpa?: string;
    iccid?: string;
    activationCode?: string;
  }> {
    const { orders } = await this.queryOrders({ orderNo });
    const order = orders.find((item) => item.orderNo === orderNo) ?? orders[0];

    const lpa = order?.qrCode;
    if (!lpa || !lpa.startsWith('LPA:')) {
      return { ready: false };
    }

    const parts = lpa.split('$');
    const activationCode = parts.length >= 3 ? parts[2] : '';

    return {
      ready: true,
      lpa,
      iccid: order?.cardInfo?.iccid || order?.iccid,
      activationCode,
    };
  }
}
