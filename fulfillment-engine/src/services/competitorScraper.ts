import axios from 'axios';
import prisma from '~/db/prisma';
import { getCountryByCode } from '~/utils/countryCodes';
import { logger } from '~/utils/logger';

export interface CompetitorPlan {
  brand: string;
  planName: string | null;
  price: number;
  dataMb: number;
  validityDays: number;
  coverageType: string | null;
  promoCode: string | null;
  originalPrice: number | null;
}

const JSON_LD_REGEX = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;

function parseJsonLdPlans(html: string): CompetitorPlan[] {
  const plans: CompetitorPlan[] = [];
  let match;

  JSON_LD_REGEX.lastIndex = 0;
  while ((match = JSON_LD_REGEX.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      if (data['@type'] !== 'ItemList' || !Array.isArray(data.itemListElement)) continue;

      for (const item of data.itemListElement) {
        const product = item.item ?? item;
        if (!product || product['@type'] !== 'Product') continue;

        const offers = product.offers;
        if (!offers?.price) continue;

        const brand =
          typeof product.brand === 'string' ? product.brand : (product.brand?.name ?? 'Unknown');

        const price = parseFloat(offers.price);
        if (isNaN(price) || price <= 0) continue;

        // Parse data amount from capacity or description
        let dataMb = 0;
        if (product.capacity) {
          dataMb =
            typeof product.capacity === 'number'
              ? product.capacity
              : parseInt(product.capacity, 10);
        }
        if (!dataMb && product.description) {
          const gbMatch = product.description.match(/(\d+)\s*GB/i);
          const mbMatch = product.description.match(/(\d+)\s*MB/i);
          if (gbMatch) dataMb = parseInt(gbMatch[1], 10) * 1024;
          else if (mbMatch) dataMb = parseInt(mbMatch[1], 10);
        }

        // Parse validity from duration or description
        let validityDays = 0;
        if (product.duration) {
          validityDays =
            typeof product.duration === 'number'
              ? product.duration
              : parseInt(product.duration, 10);
        }
        if (!validityDays && product.description) {
          const dayMatch = product.description.match(/(\d+)\s*day/i);
          if (dayMatch) validityDays = parseInt(dayMatch[1], 10);
        }

        if (!dataMb || !validityDays) continue;

        // Extract promo info
        let promoCode: string | null = null;
        let originalPrice: number | null = null;
        if (product.promoCode?.code) promoCode = product.promoCode.code;
        if (product.originalPrice) originalPrice = parseFloat(product.originalPrice);

        plans.push({
          brand,
          planName: product.name ?? null,
          price,
          dataMb,
          validityDays,
          coverageType: product.coverageType ?? null,
          promoCode,
          originalPrice: isNaN(originalPrice ?? NaN) ? null : originalPrice,
        });
      }
    } catch {
      // Skip unparseable JSON-LD blocks
    }
  }

  return plans;
}

export async function scrapeCountry(
  countryCode: string,
  countrySlug: string,
): Promise<CompetitorPlan[]> {
  const url = `https://esims.io/en/countries/${countrySlug}`;
  const response = await axios.get<string>(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SAILeSIM-Pricer/1.0)',
      Accept: 'text/html',
    },
  });
  return parseJsonLdPlans(response.data);
}

export interface ScrapeResult {
  totalCountries: number;
  totalPlans: number;
  skippedCached: number;
  errors: number;
}

export async function scrapeCompetitors(countryCodes?: string[]): Promise<ScrapeResult> {
  // Determine which countries to scrape
  let codes: string[];
  if (countryCodes && countryCodes.length > 0) {
    codes = countryCodes;
  } else {
    // Get all countries that have templates
    const templates = await prisma.shopifyProductTemplate.findMany({
      select: { countryCode: true },
      orderBy: { countryCode: 'asc' },
    });
    codes = templates.map((t) => t.countryCode);
  }

  let totalPlans = 0;
  let skippedCached = 0;
  let errors = 0;

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h ago

  for (const code of codes) {
    const country = getCountryByCode(code);
    if (!country) continue;

    // Check cache
    const cached = await prisma.competitorPrice.findFirst({
      where: { countryCode: code, scrapedAt: { gt: cutoff } },
    });
    if (cached) {
      skippedCached++;
      continue;
    }

    try {
      const plans = await scrapeCountry(code, country.slug);

      // Upsert plans
      for (const plan of plans) {
        await prisma.competitorPrice.upsert({
          where: {
            countryCode_brand_dataMb_validityDays: {
              countryCode: code,
              brand: plan.brand,
              dataMb: plan.dataMb,
              validityDays: plan.validityDays,
            },
          },
          update: {
            price: plan.price,
            planName: plan.planName,
            coverageType: plan.coverageType,
            promoCode: plan.promoCode,
            originalPrice: plan.originalPrice,
            scrapedAt: new Date(),
          },
          create: {
            countryCode: code,
            countrySlug: country.slug,
            brand: plan.brand,
            planName: plan.planName,
            price: plan.price,
            dataMb: plan.dataMb,
            validityDays: plan.validityDays,
            coverageType: plan.coverageType,
            promoCode: plan.promoCode,
            originalPrice: plan.originalPrice,
          },
        });
      }

      totalPlans += plans.length;
      logger.info({ code, plans: plans.length }, 'Scraped competitor prices');
    } catch (err) {
      errors++;
      logger.error({ code, err }, 'Failed to scrape competitor prices');
    }

    // Rate limit
    await new Promise((r) => setTimeout(r, 1500));
  }

  return {
    totalCountries: codes.length,
    totalPlans,
    skippedCached,
    errors,
  };
}
