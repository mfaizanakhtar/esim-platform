import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';

// Mock prisma to prevent actual DB calls
vi.mock('~/db/prisma', () => ({
  default: {},
}));

import { scrapeCountry } from '~/services/competitorScraper';

// ---------------------------------------------------------------------------
// Helpers — sample HTML fragments
// ---------------------------------------------------------------------------

/** Build a minimal HTML page with a JSON-LD ItemList */
function htmlWithJsonLd(items: object[]): string {
  const jsonLd = JSON.stringify({
    '@type': 'ItemList',
    itemListElement: items.map((item) => ({ item })),
  });
  return `<html><head><script type="application/ld+json">${jsonLd}</script></head><body></body></html>`;
}

/** Build a minimal HTML page with Nuxt-style embedded products JSON */
function htmlWithNuxtProps(products: object[]): string {
  const payload = JSON.stringify(products);
  return `<html><body><script>window.__NUXT__={"initialFilteredProducts":{"products":${payload}}}</script></body></html>`;
}

/** Build HTML page with products array (simpler Nuxt pattern) */
function htmlWithProductsArray(products: object[]): string {
  const payload = JSON.stringify(products);
  return `<html><body><script>var data={"products":${payload}}</script></body></html>`;
}

// ---------------------------------------------------------------------------
// scrapeCountry — JSON-LD parsing
// ---------------------------------------------------------------------------
describe('scrapeCountry', () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe('JSON-LD format parsing', () => {
    it('extracts plans from JSON-LD ItemList with offers.price format', async () => {
      const html = htmlWithJsonLd([
        {
          name: 'Thailand 5GB 30 Days',
          brand: { name: 'Airalo' },
          description: '5GB data for 30 days in Thailand',
          offers: { price: '12.50' },
          capacity: 5120,
          duration: 30,
        },
      ]);

      nock('https://esims.io').get('/en/countries/thailand').reply(200, html);

      const plans = await scrapeCountry('TH', 'thailand');
      expect(plans).toHaveLength(1);
      expect(plans[0]).toEqual({
        brand: 'Airalo',
        planName: 'Thailand 5GB 30 Days',
        price: 12.5,
        dataMb: 5120,
        validityDays: 30,
        coverageType: null,
        promoCode: null,
        originalPrice: null,
      });
    });

    it('extracts plan with string brand (not object)', async () => {
      const html = htmlWithJsonLd([
        {
          name: 'USA 3GB 7 Days',
          brand: 'eSIM2Fly',
          offers: { price: '8.99' },
          capacity: 3072,
          duration: 7,
        },
      ]);

      nock('https://esims.io').get('/en/countries/united-states').reply(200, html);

      const plans = await scrapeCountry('US', 'united-states');
      expect(plans).toHaveLength(1);
      expect(plans[0].brand).toBe('eSIM2Fly');
    });

    it('skips products with invalid price (NaN)', async () => {
      const html = htmlWithJsonLd([
        {
          name: 'Bad Plan',
          brand: 'Test',
          offers: { price: 'not-a-number' },
          capacity: 1024,
          duration: 7,
        },
      ]);

      nock('https://esims.io').get('/en/countries/japan').reply(200, html);

      const plans = await scrapeCountry('JP', 'japan');
      expect(plans).toHaveLength(0);
    });

    it('skips products with zero price', async () => {
      const html = htmlWithJsonLd([
        {
          name: 'Free Plan',
          brand: 'Test',
          offers: { price: '0' },
          capacity: 1024,
          duration: 7,
        },
      ]);

      nock('https://esims.io').get('/en/countries/france').reply(200, html);

      const plans = await scrapeCountry('FR', 'france');
      expect(plans).toHaveLength(0);
    });

    it('skips products missing data capacity', async () => {
      const html = htmlWithJsonLd([
        {
          name: 'No Data Plan',
          brand: 'Test',
          offers: { price: '5.00' },
          duration: 7,
        },
      ]);

      nock('https://esims.io').get('/en/countries/germany').reply(200, html);

      const plans = await scrapeCountry('DE', 'germany');
      expect(plans).toHaveLength(0);
    });

    it('skips products missing validity', async () => {
      const html = htmlWithJsonLd([
        {
          name: 'No Validity Plan',
          brand: 'Test',
          offers: { price: '5.00' },
          capacity: 1024,
        },
      ]);

      nock('https://esims.io').get('/en/countries/spain').reply(200, html);

      const plans = await scrapeCountry('ES', 'spain');
      expect(plans).toHaveLength(0);
    });

    it('extracts data from description text when capacity not provided', async () => {
      const html = htmlWithJsonLd([
        {
          name: 'Data Plan',
          brand: 'TestBrand',
          description: 'Get 10GB for 14 day in Italy',
          offers: { price: '15.00' },
        },
      ]);

      nock('https://esims.io').get('/en/countries/italy').reply(200, html);

      const plans = await scrapeCountry('IT', 'italy');
      expect(plans).toHaveLength(1);
      expect(plans[0].dataMb).toBe(10240); // 10GB
      expect(plans[0].validityDays).toBe(14);
    });

    it('extracts MB from description text', async () => {
      const html = htmlWithJsonLd([
        {
          name: 'Small Plan',
          brand: 'TestBrand',
          description: '500MB for 3 day usage',
          offers: { price: '2.00' },
        },
      ]);

      nock('https://esims.io').get('/en/countries/india').reply(200, html);

      const plans = await scrapeCountry('IN', 'india');
      expect(plans).toHaveLength(1);
      expect(plans[0].dataMb).toBe(500);
      expect(plans[0].validityDays).toBe(3);
    });

    it('handles multiple plans and deduplicates by brand:dataMb:validityDays', async () => {
      const html = htmlWithJsonLd([
        {
          name: 'Plan A',
          brand: 'Airalo',
          offers: { price: '10.00' },
          capacity: 1024,
          duration: 7,
        },
        {
          name: 'Plan A Duplicate',
          brand: 'Airalo',
          offers: { price: '11.00' },
          capacity: 1024,
          duration: 7,
        },
        {
          name: 'Plan B',
          brand: 'Airalo',
          offers: { price: '20.00' },
          capacity: 3072,
          duration: 7,
        },
      ]);

      nock('https://esims.io').get('/en/countries/uk').reply(200, html);

      const plans = await scrapeCountry('GB', 'uk');
      // Duplicate (same brand:dataMb:validityDays) should be skipped
      expect(plans).toHaveLength(2);
      expect(plans[0].price).toBe(10.0); // first one wins
      expect(plans[1].dataMb).toBe(3072);
    });
  });

  // ---------------------------------------------------------------------------
  // Nuxt props format parsing
  // ---------------------------------------------------------------------------
  describe('Nuxt props format parsing', () => {
    it('extracts plans from Nuxt props with price object format', async () => {
      const html = htmlWithNuxtProps([
        {
          displayName: 'Korea 2GB 7 Days',
          providerName: { displayName: 'Nomad' },
          price: { value: '6.50' },
          capacity: 2048,
          duration: 7,
          coverageType: 'local',
        },
      ]);

      nock('https://esims.io').get('/en/countries/south-korea').reply(200, html);

      const plans = await scrapeCountry('KR', 'south-korea');
      expect(plans).toHaveLength(1);
      expect(plans[0]).toEqual({
        brand: 'Nomad',
        planName: 'Korea 2GB 7 Days',
        price: 6.5,
        dataMb: 2048,
        validityDays: 7,
        coverageType: 'local',
        promoCode: null,
        originalPrice: null,
      });
    });

    it('extracts plans with price.amount format', async () => {
      const html = htmlWithNuxtProps([
        {
          displayName: 'Plan X',
          providerName: { displayName: 'Provider' },
          price: { amount: '9.99' },
          capacity: 5120,
          duration: 30,
        },
      ]);

      nock('https://esims.io').get('/en/countries/mexico').reply(200, html);

      const plans = await scrapeCountry('MX', 'mexico');
      expect(plans).toHaveLength(1);
      expect(plans[0].price).toBe(9.99);
    });

    it('extracts promoCode and originalPrice', async () => {
      const html = htmlWithNuxtProps([
        {
          displayName: 'Promo Plan',
          providerName: { displayName: 'PromoProvider' },
          price: { value: '4.99' },
          capacity: 1024,
          duration: 7,
          promoCode: { code: 'SAVE20' },
          originalPrice: { value: '6.99' },
        },
      ]);

      nock('https://esims.io').get('/en/countries/brazil').reply(200, html);

      const plans = await scrapeCountry('BR', 'brazil');
      expect(plans).toHaveLength(1);
      expect(plans[0].promoCode).toBe('SAVE20');
      expect(plans[0].originalPrice).toBe(6.99);
    });

    it('handles originalPrice as a plain number string', async () => {
      const html = htmlWithNuxtProps([
        {
          displayName: 'Sale Plan',
          providerName: { displayName: 'SaleProvider' },
          price: { value: '3.99' },
          capacity: 1024,
          duration: 7,
          originalPrice: '5.99',
        },
      ]);

      nock('https://esims.io').get('/en/countries/argentina').reply(200, html);

      const plans = await scrapeCountry('AR', 'argentina');
      expect(plans).toHaveLength(1);
      expect(plans[0].originalPrice).toBe(5.99);
    });
  });

  // ---------------------------------------------------------------------------
  // Products array pattern (simpler Nuxt)
  // ---------------------------------------------------------------------------
  describe('products array pattern', () => {
    it('extracts plans from plain products array', async () => {
      const html = htmlWithProductsArray([
        {
          name: 'Australia 10GB 30 Days',
          brand: 'Holafly',
          offers: { price: '25.00' },
          capacity: 10240,
          duration: 30,
        },
      ]);

      nock('https://esims.io').get('/en/countries/australia').reply(200, html);

      const plans = await scrapeCountry('AU', 'australia');
      expect(plans).toHaveLength(1);
      expect(plans[0].brand).toBe('Holafly');
      expect(plans[0].price).toBe(25.0);
    });
  });

  // ---------------------------------------------------------------------------
  // extractPlanFromProduct — brand extraction edge cases
  // ---------------------------------------------------------------------------
  describe('brand extraction', () => {
    it('uses brand.name when brand is object', async () => {
      const html = htmlWithJsonLd([
        {
          name: 'Test Plan',
          brand: { name: 'BrandFromName' },
          offers: { price: '10.00' },
          capacity: 1024,
          duration: 7,
        },
      ]);

      nock('https://esims.io').get('/en/countries/canada').reply(200, html);

      const plans = await scrapeCountry('CA', 'canada');
      expect(plans[0].brand).toBe('BrandFromName');
    });

    it('falls back to Unknown when brand is missing', async () => {
      const html = htmlWithJsonLd([
        {
          name: 'No Brand Plan',
          offers: { price: '10.00' },
          capacity: 1024,
          duration: 7,
        },
      ]);

      nock('https://esims.io').get('/en/countries/portugal').reply(200, html);

      const plans = await scrapeCountry('PT', 'portugal');
      expect(plans).toHaveLength(1);
      expect(plans[0].brand).toBe('Unknown');
    });
  });

  // ---------------------------------------------------------------------------
  // Data extraction from name/displayName
  // ---------------------------------------------------------------------------
  describe('data extraction from text', () => {
    it('parses GB from name when capacity is missing', async () => {
      const html = htmlWithNuxtProps([
        {
          displayName: '3GB 7 Days',
          providerName: { displayName: 'SomeBrand' },
          price: { value: '5.00' },
        },
      ]);

      nock('https://esims.io').get('/en/countries/turkey').reply(200, html);

      const plans = await scrapeCountry('TR', 'turkey');
      expect(plans).toHaveLength(1);
      expect(plans[0].dataMb).toBe(3072); // 3 * 1024
      expect(plans[0].validityDays).toBe(7);
    });

    it('parses duration from displayName when duration field is missing', async () => {
      const html = htmlWithNuxtProps([
        {
          displayName: '1GB valid for 14 day',
          providerName: { displayName: 'Brand' },
          price: { value: '3.00' },
        },
      ]);

      nock('https://esims.io').get('/en/countries/egypt').reply(200, html);

      const plans = await scrapeCountry('EG', 'egypt');
      expect(plans).toHaveLength(1);
      expect(plans[0].validityDays).toBe(14);
    });

    it('uses numeric capacity field directly', async () => {
      const html = htmlWithNuxtProps([
        {
          displayName: 'Plan',
          providerName: { displayName: 'Brand' },
          price: { value: '5.00' },
          capacity: 2048,
          duration: 7,
        },
      ]);

      nock('https://esims.io').get('/en/countries/nigeria').reply(200, html);

      const plans = await scrapeCountry('NG', 'nigeria');
      expect(plans[0].dataMb).toBe(2048);
    });

    it('parses string capacity field', async () => {
      const html = htmlWithNuxtProps([
        {
          displayName: 'Plan',
          providerName: { displayName: 'Brand' },
          price: { value: '5.00' },
          capacity: '4096',
          duration: '10',
        },
      ]);

      nock('https://esims.io').get('/en/countries/colombia').reply(200, html);

      const plans = await scrapeCountry('CO', 'colombia');
      expect(plans[0].dataMb).toBe(4096);
      expect(plans[0].validityDays).toBe(10);
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------
  describe('error handling', () => {
    it('throws on HTTP errors', async () => {
      nock('https://esims.io').get('/en/countries/nowhere').reply(404);

      await expect(scrapeCountry('XX', 'nowhere')).rejects.toThrow();
    });

    it('throws on network timeout', async () => {
      nock('https://esims.io')
        .get('/en/countries/slow-country')
        .delayConnection(20000)
        .reply(200, '<html></html>');

      await expect(scrapeCountry('ZZ', 'slow-country')).rejects.toThrow();
    }, 25000);

    it('returns empty array for HTML with no plans', async () => {
      nock('https://esims.io')
        .get('/en/countries/empty')
        .reply(200, '<html><body>No plans here</body></html>');

      const plans = await scrapeCountry('XX', 'empty');
      expect(plans).toEqual([]);
    });

    it('returns empty array for malformed JSON-LD', async () => {
      const html =
        '<html><head><script type="application/ld+json">{bad json here</script></head><body></body></html>';
      nock('https://esims.io').get('/en/countries/bad').reply(200, html);

      const plans = await scrapeCountry('XX', 'bad');
      expect(plans).toEqual([]);
    });

    it('skips non-ItemList JSON-LD blocks', async () => {
      const jsonLd = JSON.stringify({ '@type': 'Organization', name: 'Test' });
      const html = `<html><head><script type="application/ld+json">${jsonLd}</script></head><body></body></html>`;
      nock('https://esims.io').get('/en/countries/orgonly').reply(200, html);

      const plans = await scrapeCountry('XX', 'orgonly');
      expect(plans).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Combined JSON-LD + Nuxt props
  // ---------------------------------------------------------------------------
  describe('combined sources', () => {
    it('merges plans from both JSON-LD and Nuxt props, deduplicating', async () => {
      // Create HTML with both a JSON-LD script and a Nuxt props payload
      const jsonLd = JSON.stringify({
        '@type': 'ItemList',
        itemListElement: [
          {
            item: {
              name: 'Plan From LD',
              brand: 'BrandA',
              offers: { price: '10.00' },
              capacity: 1024,
              duration: 7,
            },
          },
        ],
      });
      const nuxtProducts = JSON.stringify([
        {
          displayName: 'Plan From Nuxt',
          providerName: { displayName: 'BrandB' },
          price: { value: '15.00' },
          capacity: 2048,
          duration: 14,
        },
        // Duplicate of the JSON-LD plan (same brand:dataMb:validityDays)
        {
          displayName: 'Duplicate of LD',
          providerName: { displayName: 'BrandA' },
          price: { value: '12.00' },
          capacity: 1024,
          duration: 7,
        },
      ]);

      const html = `<html>
        <head><script type="application/ld+json">${jsonLd}</script></head>
        <body><script>var x={"initialFilteredProducts":{"products":${nuxtProducts}}}</script></body>
      </html>`;

      nock('https://esims.io').get('/en/countries/singapore').reply(200, html);

      const plans = await scrapeCountry('SG', 'singapore');
      // Should have 2 unique plans (BrandA:1024:7 and BrandB:2048:14)
      expect(plans).toHaveLength(2);
      const brands = plans.map((p) => p.brand).sort();
      expect(brands).toEqual(['BrandA', 'BrandB']);
      // BrandA should be the JSON-LD one (first seen), price 10
      const brandAPlan = plans.find((p) => p.brand === 'BrandA');
      expect(brandAPlan!.price).toBe(10.0);
    });
  });
});
