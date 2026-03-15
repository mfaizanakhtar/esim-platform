// TypeScript interfaces matching backend API response shapes.
// These mirror the Prisma models in fulfillment-engine/prisma/schema.prisma.

export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  channel: string;
  result: string | null;
  createdAt: string;
}

export interface EsimOrder {
  id: string;
  deliveryId: string | null;
  vendorReferenceId: string;
  payloadJson: Record<string, unknown> | null;
  status: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DeliveryStatus =
  | 'pending'
  | 'provisioning'
  | 'delivered'
  | 'failed'
  | 'awaiting_callback'
  | 'polling';

export interface Delivery {
  id: string;
  shop: string;
  orderId: string;
  orderName: string;
  lineItemId: string;
  variantId: string;
  customerEmail: string | null;
  vendorReferenceId: string | null;
  status: DeliveryStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  attempts: DeliveryAttempt[];
}

export interface EsimPayload {
  lpa?: string;
  iccid?: string;
  activationCode?: string;
  qrCodeUrl?: string;
  [key: string]: unknown;
}

export interface DeliveryDetail extends Delivery {
  esimPayload: EsimPayload | null;
  esimOrders: EsimOrder[];
}

export type SkuMappingProvider = 'firoam' | 'tgt';
export type SkuMappingPackageType = 'fixed' | 'daypass';

export interface SkuMapping {
  id: string;
  shopifySku: string;
  provider: SkuMappingProvider;
  providerSku: string;
  providerCatalogId: string | null;
  providerConfig: Record<string, unknown> | null;
  name: string | null;
  region: string | null;
  dataAmount: string | null;
  validity: string | null;
  packageType: SkuMappingPackageType | null;
  daysCount: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogItem {
  id: string;
  provider: string;
  productCode: string;
  productName: string;
  productType: string | null;
  region: string | null;
  countryCodes: string[] | null;
  dataAmount: string | null;
  validity: string | null;
  netPrice: string | null;
  currency: string | null;
  cardType: string | null;
  activeType: string | null;
  isActive: boolean;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
}

interface OffsetPage {
  total: number;
  limit: number;
  offset: number;
}

export interface DeliveriesPage<T> extends OffsetPage {
  deliveries: T[];
}

export interface SkuMappingsPage<T> extends OffsetPage {
  mappings: T[];
}

export interface CatalogPage<T> extends OffsetPage {
  items: T[];
}

export interface ApiErrorResponse {
  error: string;
}
