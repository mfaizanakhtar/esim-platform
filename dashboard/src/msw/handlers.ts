import { http, HttpResponse } from 'msw';

const BASE_URL = 'http://localhost:3000/admin';

const mockDelivery = {
  id: 'cltest123',
  shop: 'test-shop.myshopify.com',
  orderId: '5001',
  orderName: '#5001',
  lineItemId: '100',
  variantId: '42001',
  customerEmail: 'customer@example.com',
  vendorReferenceId: 'VR-001',
  status: 'delivered',
  lastError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  attempts: [
    {
      id: 'att1',
      deliveryId: 'cltest123',
      channel: 'firoam',
      result: 'success',
      createdAt: new Date().toISOString(),
    },
  ],
};

const mockDeliveryDetail = {
  ...mockDelivery,
  esimPayload: {
    iccid: '8901234567890123456',
    lpa: 'LPA:1$smdp.example.com$ACTIVATION123',
    activationCode: 'ACTIVATION123',
  },
  esimOrders: [],
};

const mockMapping = {
  id: 'map1',
  shopifySku: 'ESIM-US-5GB',
  provider: 'firoam',
  providerSku: '123:abc:price1',
  providerConfig: null,
  name: 'US 5GB 30 Days',
  region: 'US',
  dataAmount: '5GB',
  validity: '30 days',
  packageType: 'fixed',
  daysCount: null,
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

export const handlers = [
  // Deliveries list
  http.get(`${BASE_URL}/deliveries`, () => {
    return HttpResponse.json({
      total: 1,
      limit: 50,
      offset: 0,
      deliveries: [mockDelivery],
    });
  }),

  // Delivery detail
  http.get(`${BASE_URL}/deliveries/:id`, ({ params }) => {
    if (params.id === 'cltest123') {
      return HttpResponse.json(mockDeliveryDetail);
    }
    return HttpResponse.json({ error: 'Delivery not found' }, { status: 404 });
  }),

  // Retry
  http.post(`${BASE_URL}/deliveries/:id/retry`, () => {
    return HttpResponse.json({ ok: true, message: 'Re-enqueued' });
  }),

  // Resend email
  http.post(`${BASE_URL}/deliveries/:id/resend-email`, () => {
    return HttpResponse.json({ ok: true, messageId: 'email-id-123' });
  }),

  // SKU mappings list
  http.get(`${BASE_URL}/sku-mappings`, () => {
    return HttpResponse.json({
      total: 1,
      limit: 100,
      offset: 0,
      mappings: [mockMapping],
    });
  }),

  // Create SKU mapping
  http.post(`${BASE_URL}/sku-mappings`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    return HttpResponse.json({ ...mockMapping, ...body, id: 'new-map-1' }, { status: 201 });
  }),

  // Update SKU mapping
  http.put(`${BASE_URL}/sku-mappings/:id`, async ({ params, request }) => {
    const body = await request.json() as Record<string, unknown>;
    return HttpResponse.json({ ...mockMapping, id: params.id as string, ...body });
  }),

  // Delete SKU mapping
  http.delete(`${BASE_URL}/sku-mappings/:id`, () => {
    return HttpResponse.json({ ok: true, message: 'Deactivated' });
  }),

  // Catalog
  http.get(`${BASE_URL}/provider-catalog`, () => {
    return HttpResponse.json({
      total: 0,
      limit: 100,
      offset: 0,
      items: [],
    });
  }),

  // Catalog sync
  http.post(`${BASE_URL}/provider-catalog/sync`, async ({ request }) => {
    const body = await request.json() as { provider: string };
    return HttpResponse.json({
      ok: true,
      provider: body.provider,
      processedPackages: 42,
      processed: 42,
      total: 42,
    });
  }),
];
