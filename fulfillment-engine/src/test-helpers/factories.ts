/**
 * Typed test-data factories powered by @faker-js/faker.
 *
 * Usage:
 *   import { esimDeliveryFactory, providerSkuMappingFactory, esimOrderFactory } from '../../test-helpers/factories';
 *
 *   const delivery = esimDeliveryFactory();                        // random data
 *   const delivery = esimDeliveryFactory({ status: 'failed' });   // with overrides
 */

import { faker } from '@faker-js/faker';
import type { EsimDelivery, ProviderSkuMapping, EsimOrder } from '@prisma/client';

// ---------------------------------------------------------------------------
// EsimDelivery
// ---------------------------------------------------------------------------
export function esimDeliveryFactory(overrides: Partial<EsimDelivery> = {}): EsimDelivery {
  return {
    id: faker.string.uuid(),
    shop: `${faker.internet.domainWord()}.myshopify.com`,
    orderId: faker.string.numeric(6),
    orderName: `#${faker.string.numeric(4)}`,
    lineItemId: faker.string.numeric(8),
    variantId: faker.string.numeric(8),
    customerEmail: faker.internet.email(),
    vendorReferenceId: null,
    provider: null,
    iccidHash: null,
    payloadEncrypted: null,
    accessToken: null,
    status: 'pending',
    lastError: null,
    createdAt: faker.date.recent({ days: 7 }),
    updatedAt: faker.date.recent({ days: 1 }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ProviderSkuMapping
// ---------------------------------------------------------------------------
export function providerSkuMappingFactory(
  overrides: Partial<ProviderSkuMapping> = {},
): ProviderSkuMapping {
  const skuId = faker.number.int({ min: 100, max: 400 });
  const priceId = faker.number.int({ min: 10000, max: 20000 });

  return {
    id: faker.string.uuid(),
    shopifySku: `ESIM-${faker.location.countryCode()}-${faker.number.int({ min: 1, max: 30 })}GB`,
    provider: 'firoam',
    providerSku: `${skuId}:826-0-?-1-G-D:${priceId}`,
    providerConfig: null,
    isActive: true,
    name: `${faker.location.country()} ${faker.number.int({ min: 1, max: 30 })}GB`,
    region: faker.helpers.arrayElement(['Asia', 'Europe', 'Americas', 'Global', null]),
    dataAmount: `${faker.number.int({ min: 1, max: 30 })}GB`,
    validity: faker.helpers.arrayElement(['7 days', '14 days', '30 days']),
    packageType: 'fixed',
    daysCount: null,
    providerCatalogId: null,
    createdAt: faker.date.recent({ days: 30 }),
    updatedAt: faker.date.recent({ days: 7 }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EsimOrder
// ---------------------------------------------------------------------------
export function esimOrderFactory(overrides: Partial<EsimOrder> = {}): EsimOrder {
  return {
    id: faker.string.uuid(),
    deliveryId: null,
    vendorReferenceId: `EP-${faker.string.alphanumeric(8).toUpperCase()}`,
    payloadJson: {
      vendorId: `EP-${faker.string.alphanumeric(6).toUpperCase()}`,
      lpa: `LPA:1$smdp.example.com$${faker.string.alphanumeric(20)}`,
      activationCode: faker.string.alphanumeric(20),
      iccid: `8901${faker.string.numeric(15)}`,
    },
    payloadEncrypted: faker.string.alphanumeric(88),
    status: 'created',
    lastError: null,
    createdAt: faker.date.recent({ days: 7 }),
    updatedAt: faker.date.recent({ days: 1 }),
    ...overrides,
  };
}
