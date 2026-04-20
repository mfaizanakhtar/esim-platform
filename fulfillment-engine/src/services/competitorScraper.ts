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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractPlanFromProduct(product: any): CompetitorPlan | null {
  // Handle both JSON-LD format and Nuxt props format
  const price =
    typeof product.price === 'object'
      ? parseFloat(product.price?.value ?? product.price?.amount)
      : product.offers?.price
        ? parseFloat(product.offers.price)
        : NaN;
  if (isNaN(price) || price <= 0) return null;

  const brand =
    typeof product.providerName === 'object'
      ? product.providerName?.displayName
      : typeof product.brand === 'string'
        ? product.brand
        : (product.brand?.name ?? 'Unknown');
  if (!brand) return null;

  // Data capacity in MB
  let dataMb = 0;
  if (product.capacity) {
    dataMb =
      typeof product.capacity === 'number' ? product.capacity : parseInt(product.capacity, 10);
  }
  if (!dataMb) {
    const text = product.description || product.displayName || product.name || '';
    const gbMatch = text.match(/(\d+)\s*GB/i);
    const mbMatch = text.match(/(\d+)\s*MB/i);
    if (gbMatch) dataMb = parseInt(gbMatch[1], 10) * 1024;
    else if (mbMatch) dataMb = parseInt(mbMatch[1], 10);
  }

  // Validity in days
  let validityDays = 0;
  if (product.duration) {
    validityDays =
      typeof product.duration === 'number' ? product.duration : parseInt(product.duration, 10);
  }
  if (!validityDays) {
    const text = product.description || product.displayName || product.name || '';
    const dayMatch = text.match(/(\d+)\s*day/i);
    if (dayMatch) validityDays = parseInt(dayMatch[1], 10);
  }

  if (!dataMb || !validityDays) return null;

  let promoCode: string | null = null;
  let originalPrice: number | null = null;
  if (product.promoCode?.code) promoCode = product.promoCode.code;
  const op = product.originalPrice;
  if (op) {
    originalPrice = typeof op === 'object' ? parseFloat(op.value ?? op.amount) : parseFloat(op);
    if (isNaN(originalPrice!)) originalPrice = null;
  }

  return {
    brand,
    planName: product.displayName ?? product.name ?? null,
    price,
    dataMb,
    validityDays,
    coverageType: product.coverageType ?? null,
    promoCode,
    originalPrice,
  };
}

function parsePlansFromHtml(html: string): CompetitorPlan[] {
  const plans: CompetitorPlan[] = [];
  const seen = new Set<string>();

  function addPlan(plan: CompetitorPlan) {
    const key = `${plan.brand}:${plan.dataMb}:${plan.validityDays}`;
    if (seen.has(key)) return;
    seen.add(key);
    plans.push(plan);
  }

  // Strategy 1: Parse JSON-LD (gives ~10 featured plans)
  const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      if (data['@type'] !== 'ItemList' || !Array.isArray(data.itemListElement)) continue;
      for (const item of data.itemListElement) {
        const product = item.item ?? item;
        const plan = extractPlanFromProduct(product);
        if (plan) addPlan(plan);
      }
    } catch {
      // skip
    }
  }

  // Strategy 2: Parse Nuxt/props payload (gives ~60 plans with full data)
  // Look for initialFilteredProducts or products arrays in embedded JSON
  const propsPatterns = [
    /"initialFilteredProducts"\s*:\s*\{[^}]*"products"\s*:\s*\[/,
    /"products"\s*:\s*\[/,
  ];

  for (const pattern of propsPatterns) {
    const idx = html.search(pattern);
    if (idx === -1) continue;

    // Find the start of the products array
    const arrStart = html.indexOf('[', idx + html.substring(idx).search(/\[/));
    if (arrStart === -1) continue;

    // Extract the array by counting brackets
    let depth = 0;
    let arrEnd = arrStart;
    for (let i = arrStart; i < html.length && i < arrStart + 500000; i++) {
      if (html[i] === '[') depth++;
      else if (html[i] === ']') {
        depth--;
        if (depth === 0) {
          arrEnd = i + 1;
          break;
        }
      }
    }

    if (arrEnd <= arrStart) continue;

    try {
      const products = JSON.parse(html.substring(arrStart, arrEnd));
      if (!Array.isArray(products)) continue;
      for (const product of products) {
        const plan = extractPlanFromProduct(product);
        if (plan) addPlan(plan);
      }
      if (plans.length > 10) break; // Got good data from props, stop looking
    } catch {
      // skip malformed JSON
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
  return parsePlansFromHtml(response.data);
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
  const skippedCached = 0;
  let errors = 0;

  for (const code of codes) {
    const country = getCountryByCode(code);
    if (!country) continue;

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
