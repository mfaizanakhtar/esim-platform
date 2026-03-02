import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { encrypt } from '../utils/crypto';
import prisma from '../db/prisma';
import type { Prisma } from '@prisma/client';
import {
  validateCanonical,
  CanonicalEsimPayload,
  validateAddEsimOrder,
  AddEsimOrderInput,
  validateSkus,
  SkuItem,
  validatePackages,
  PackageItem,
  validateSkuByGroup,
  SkuByGroup,
  FiRoamApiResponse,
  FiRoamCard,
  FiRoamOrderData,
  FiRoamQueryData,
} from './firoamSchemas';

function createSign(params: Record<string, unknown>, signKey: string) {
  const copy: Record<string, unknown> = { ...params };
  delete copy.sign;
  const keys = Object.keys(copy).sort();
  // Join params without separator (per FiRoam examples)
  const buffer = keys.map((k) => `${k}=${String(copy[k])}`).join('');
  // Python example uses urllib.parse.quote for URL encoding before MD5
  const content = encodeURIComponent(buffer + signKey);
  const md5 = crypto.createHash('md5').update(content, 'utf-8').digest('hex').toUpperCase();
  return md5;
}

/**
 * Check if FiRoam API response indicates success
 */
function isSuccessResponse(resp: FiRoamApiResponse): boolean {
  return resp.code === 0 || resp.code === '0';
}

/**
 * Extract card data from various possible response structures.
 * Handles the three field-name variants used across FiRoam API versions.
 */
function extractCardData(orderDetails: FiRoamApiResponse): FiRoamCard[] {
  const data = orderDetails.data as FiRoamOrderData | undefined;
  return data?.cardApiDtoList ?? data?.cards ?? data?.cardList ?? [];
}

/**
 * Normalize card data to canonical eSIM payload format.
 * Resolves the multiple field-name variants FiRoam uses across API versions.
 */
function normalizeCardToCanonical(card: FiRoamCard, orderNum: string): CanonicalEsimPayload {
  return {
    vendorId: orderNum,
    lpa: card.code ?? card.lpa ?? card.lpaString ?? card.sm_dp_address,
    activationCode: card.activationCode ?? card.activation_code,
    iccid: card.iccid ?? card.mobileNumber,
  };
}

export default class FiRoamClient {
  private baseUrl: string;
  private phone?: string;
  private password?: string;
  private signKey: string;
  private token?: string;
  private tokenExpiry?: number;
  private http: AxiosInstance;

  constructor() {
    this.baseUrl = process.env.FIROAM_BASE_URL || 'https://bpm.roamwifi.hk';
    this.phone = process.env.FIROAM_PHONE;
    this.password = process.env.FIROAM_PASSWORD;
    this.signKey = process.env.FIROAM_SIGN_KEY || '1234567890qwertyuiopasdfghjklzxc';
    this.http = axios.create({ baseURL: this.baseUrl, timeout: 15000 });
  }

  private async loginIfNeeded() {
    // Check if token exists and hasn't expired (with 5 minute buffer)
    const now = Date.now();
    if (this.token && this.tokenExpiry && this.tokenExpiry > now + 5 * 60 * 1000) {
      return this.token;
    }

    // Token expired or doesn't exist - login again
    console.log('[FiRoamClient] Token expired or missing, logging in...');
    if (!this.phone || !this.password) throw new Error('FIROAM_PHONE/FIROAM_PASSWORD not set');
    const payload = { phonenumber: this.phone, password: this.password } as Record<string, unknown>;
    payload['sign'] = createSign(payload, this.signKey);
    // Per Python example in documentation: login uses GET with query params, not POST
    const resp = await this.http.get('/api_order/login', { params: payload });
    const data = resp.data;
    if (!data || !data.data || !data.data.token)
      throw new Error(`FiRoam login failed: ${JSON.stringify(data)}`);
    this.token = data.data.token;
    // Set expiry to 1 hour from now (adjust based on FiRoam's actual token lifetime)
    this.tokenExpiry = Date.now() + 60 * 60 * 1000;
    console.log(
      '[FiRoamClient] Successfully logged in, token valid until:',
      new Date(this.tokenExpiry),
    );
    return this.token;
  }

  private async post(
    path: string,
    params: Record<string, unknown>,
    retryOnExpire = true,
  ): Promise<FiRoamApiResponse> {
    await this.loginIfNeeded();
    const body: Record<string, unknown> = { ...params, token: this.token };
    body['sign'] = createSign(body, this.signKey);
    // FiRoam API expects form-urlencoded data, not JSON
    const resp = await this.http.post(path, new URLSearchParams(body as Record<string, string>), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const data = resp.data;

    // If token expired, retry once with fresh token
    if (retryOnExpire && data?.code === '-1' && data?.message === 'token expire') {
      console.log('[FiRoamClient] Token expired during request, refreshing and retrying...');
      this.token = undefined; // Force re-login
      this.tokenExpiry = undefined;
      return this.post(path, params, false); // Retry without further retries
    }

    return data;
  }

  /**
   * Place an eSIM order. The `orderPayload` should follow FiRoam `addEsimOrder` spec.
   * Returns the API response (including orderNum / details) and a canonical payload if available.
   *
   * Flow Options:
   * - One-step (recommended): Set backInfo="1" in orderPayload to get full details immediately
   * - Two-step (legacy): Omit backInfo, will automatically call getOrderInfo() after order creation
   *
   * @param orderPayload - Order parameters (include backInfo="1" for one-step flow)
   */
  async addEsimOrder(orderPayload: unknown) {
    const payload: AddEsimOrderInput = validateAddEsimOrder(orderPayload);

    // Debug: Log the exact payload being sent to FiRoam
    console.log('[FiRoamClient] Sending order payload:', JSON.stringify(payload, null, 2));

    const data = await this.post('/api_esim/addEsimOrder', payload as Record<string, unknown>);

    if (!isSuccessResponse(data)) {
      return { raw: data };
    }

    const orderNum = this.extractOrderNumber(data);
    if (!orderNum) {
      return { raw: data };
    }

    try {
      const orderDetails = await this.fetchOrderDetails(data, orderNum);
      const canonical = this.extractAndValidateCanonical(orderDetails, orderNum);

      if (!canonical) {
        return { raw: data, canonical: undefined };
      }

      const dbRecord = await this.persistOrderToDatabase(orderNum, canonical);
      return { raw: data, canonical, db: { id: dbRecord.id } };
    } catch (err) {
      return { raw: data, canonical: undefined, error: err };
    }
  }

  /**
   * Extract order number from API response (handles both string and object formats).
   * FiRoam returns `data` as a bare string (orderNum) for simple cases and as
   * a FiRoamOrderData object for the one-step backInfo flow.
   */
  private extractOrderNumber(data: FiRoamApiResponse): string | undefined {
    const responseData = data.data;
    return typeof responseData === 'string'
      ? responseData
      : (responseData as FiRoamOrderData | undefined)?.orderNum;
  }

  /**
   * Fetch full order details (one-step or two-step flow).
   * When backInfo="1" is set the initial response already contains card data
   * (one-step); otherwise we fetch it with a separate getOrderInfo call.
   */
  private async fetchOrderDetails(
    data: FiRoamApiResponse,
    orderNum: string,
  ): Promise<FiRoamApiResponse> {
    const responseData = data.data as FiRoamOrderData | undefined;
    const hasFullDetails =
      responseData != null && responseData.orderNum != null && responseData.cardApiDtoList != null;

    if (hasFullDetails) {
      return data; // One-step flow: already have full details
    }

    return await this.getOrderInfo(orderNum); // Two-step flow
  }

  /**
   * Extract and validate canonical eSIM payload from order details
   */
  private extractAndValidateCanonical(
    orderDetails: FiRoamApiResponse,
    orderNum: string,
  ): CanonicalEsimPayload | undefined {
    const cards = extractCardData(orderDetails);
    const firstCard: FiRoamCard = cards[0] ?? {};
    const canonicalRaw = normalizeCardToCanonical(firstCard, orderNum);

    try {
      return validateCanonical(canonicalRaw);
    } catch (zerr) {
      // Persist failed validation for debugging
      this.persistInvalidOrder(orderNum, canonicalRaw, zerr).catch(console.error);
      return undefined;
    }
  }

  /**
   * Persist validated order to database
   */
  private async persistOrderToDatabase(orderNum: string, canonical: CanonicalEsimPayload) {
    return await prisma.esimOrder.create({
      data: {
        vendorReferenceId: String(orderNum),
        payloadJson: canonical as Prisma.InputJsonValue,
        payloadEncrypted: encrypt(JSON.stringify(canonical)),
        status: 'created',
      },
    });
  }

  /**
   * Persist order with invalid payload for debugging
   */
  private async persistInvalidOrder(
    orderNum: string,
    canonicalRaw: CanonicalEsimPayload,
    error: unknown,
  ) {
    await prisma.esimOrder.create({
      data: {
        vendorReferenceId: String(orderNum),
        payloadJson: canonicalRaw as Prisma.InputJsonValue,
        payloadEncrypted: encrypt(JSON.stringify(canonicalRaw)),
        status: 'invalid_payload',
        lastError: error instanceof Error ? error.message : String(error),
      },
    });
  }

  /**
   * Fetch full order details by orderNum.
   * Used internally after addEsimOrder (two-step flow) or can be called manually.
   *
   * @param orderNum - Order number returned from addEsimOrder
   * @returns Full order details including cardApiDtoList with eSIM credentials
   */
  async getOrderInfo(orderNum: string) {
    const resp = await this.post('/api_esim/getOrderInfo', { orderNum } as Record<string, unknown>);
    return resp;
  }

  /**
   * Query the vendor for supported eSIM SKUs.
   * Returns { raw, skus } when successful, otherwise { raw }.
   */
  async getSkus() {
    const resp = await this.post('/api_esim/getSkus', {} as Record<string, unknown>);

    if (isSuccessResponse(resp) && resp.data) {
      try {
        const skus: SkuItem[] = validateSkus(resp.data);
        return { raw: resp, skus };
      } catch (zerr) {
        return { raw: resp, error: zerr };
      }
    }

    return { raw: resp };
  }

  /**
   * Get SKUs grouped by continent.
   * Returns { raw, grouped } when successful, otherwise { raw }.
   */
  async getSkuByGroup() {
    const resp = await this.post('/api_esim/getSkuByGroup', {} as Record<string, unknown>);

    if (isSuccessResponse(resp) && resp.data) {
      try {
        const grouped: SkuByGroup = validateSkuByGroup(resp.data);
        return { raw: resp, grouped };
      } catch (zerr) {
        return { raw: resp, error: zerr };
      }
    }

    return { raw: resp };
  }

  /**
   * Get the list of supported packages for a specific SKU.
   * Returns { raw, packageData } when successful, otherwise { raw }.
   *
   * @param skuId - The SKU ID to get packages for
   */
  async getPackages(skuId: string) {
    const resp = await this.post('/api_esim/getPackages', { skuId } as Record<string, unknown>);

    if (isSuccessResponse(resp) && resp.data) {
      try {
        const packageData: PackageItem = validatePackages(resp.data);
        return { raw: resp, packageData };
      } catch (zerr) {
        return { raw: resp, error: zerr };
      }
    }

    return { raw: resp };
  }

  /**
   * Cancel/refund an eSIM order.
   *
   * @param params - Cancellation parameters
   * @param params.orderNum - The order number to cancel
   * @param params.iccids - Comma-separated ICCIDs to cancel (required for FiRoam API)
   * @returns { raw, success, message }
   */
  async cancelOrder(params: { orderNum: string; iccids: string }) {
    // Note: FiRoam API has issues with optional 'remark' parameter causing signature failures.
    // Keep payload minimal for reliability.
    const body: Record<string, unknown> = {
      orderNum: params.orderNum,
      iccids: params.iccids,
    };

    const resp = await this.post('/api_esim/refundOrder', body);

    return {
      raw: resp,
      success: isSuccessResponse(resp),
      message: resp.message ?? 'Unknown error',
    };
  }

  /**
   * Query eSIM order information list with usage data.
   * Can query by orderNum, iccid, or other filters.
   * Returns detailed usage statistics including data consumed (usedMb).
   *
   * @param params - Query parameters
   * @param params.orderNum - (Optional) Order number
   * @param params.iccid - (Optional) ICCID to query
   * @param params.pageNo - (Optional) Page number, default 1
   * @param params.pageSize - (Optional) Results per page, default 30
   * @returns { raw, orders, usage } - Raw response, order list, and usage data
   */
  async queryEsimOrder(params: {
    orderNum?: string;
    iccid?: string;
    pageNo?: number;
    pageSize?: number;
  }) {
    const body: Record<string, unknown> = {
      pageNo: params.pageNo || 1,
      pageSize: params.pageSize || 30,
    };

    if (params.orderNum) {
      body.orderNum = params.orderNum;
    }

    if (params.iccid) {
      body.iccid = params.iccid;
    }

    const resp = await this.post('/api_esim/queryEsimOrder', body);

    if (!isSuccessResponse(resp)) {
      return {
        raw: resp,
        success: false,
        error: resp.message ?? 'Query failed',
      };
    }

    // Extract order data
    const data = resp.data as FiRoamQueryData | undefined;
    const rows = data?.rows ?? [];

    // Normalize usage data for each package
    const orders = rows.map((order) => {
      const packageList = order.packageList ?? [];

      const packages = packageList.map((pkg) => ({
        iccid: pkg.iccid,
        flows: pkg.flows, // Total data in MB/GB
        unit: pkg.unit, // MB or GB
        usedMb: pkg.usedMb, // Used data in MB
        days: pkg.days,
        name: pkg.name,
        beginDate: pkg.beginDate,
        endDate: pkg.endDate,
        status: pkg.status,
        priceId: pkg.priceId,
      }));

      return {
        orderNum: order.orderNum,
        skuId: order.skuId,
        skuName: order.skuName,
        createTime: order.createTime,
        status: order.status,
        packages,
      };
    });

    return {
      raw: resp,
      success: true,
      orders,
      total: data?.total ?? 0,
      page: data?.page ?? 1,
    };
  }
}
