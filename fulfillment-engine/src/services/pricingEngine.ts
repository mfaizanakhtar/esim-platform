import prisma from '~/db/prisma';
import { parseShopifySku } from '~/utils/parseShopifySku';
import { logger } from '~/utils/logger';

export interface MarginTier {
  maxCost: number; // upper bound (Infinity for the last tier)
  multiplier: number;
}

export const DEFAULT_MARGIN_TIERS: MarginTier[] = [
  { maxCost: 1, multiplier: 3.0 },
  { maxCost: 3, multiplier: 2.5 },
  { maxCost: 5, multiplier: 2.0 },
  { maxCost: 10, multiplier: 1.8 },
  { maxCost: 20, multiplier: 1.5 },
  { maxCost: 40, multiplier: 1.35 },
  { maxCost: Infinity, multiplier: 1.25 },
];

export interface CostFloorParams {
  minimumPrice: number; // default 2.99
  marginTiers: MarginTier[];
}

export const DEFAULT_COST_FLOOR_PARAMS: CostFloorParams = {
  minimumPrice: 2.99,
  marginTiers: DEFAULT_MARGIN_TIERS,
};

export interface PricingParams {
  survivalMargin: number; // default 0.15 (15%)
  undercutPercent: number; // default 0.10 (10%)
  minimumPrice: number; // default 2.99
  monotonicStep: number; // default 1.00
  noDataBuffer: number; // default 1.0 (multiplier on floor when no competitor data)
}

export const DEFAULT_PRICING_PARAMS: PricingParams = {
  survivalMargin: 0.15,
  undercutPercent: 0.1,
  minimumPrice: 2.99,
  monotonicStep: 1.0,
  noDataBuffer: 1.0,
};

function getMultiplier(cost: number, tiers: MarginTier[]): number {
  for (const tier of tiers) {
    if (cost < tier.maxCost) return tier.multiplier;
  }
  return tiers[tiers.length - 1]?.multiplier ?? 1.25;
}

export function calculateFloors(
  cost: number,
  params: PricingParams,
  costFloorParams?: CostFloorParams,
): { standardFloor: number; survivalFloor: number } {
  const cfp = costFloorParams ?? DEFAULT_COST_FLOOR_PARAMS;
  const minPrice = cfp.minimumPrice;
  return {
    standardFloor: Math.max(minPrice, cost * getMultiplier(cost, cfp.marginTiers)),
    survivalFloor: Math.max(minPrice, cost * (1 + params.survivalMargin)),
  };
}

export function calculateSuggestedPrice(
  standardFloor: number,
  survivalFloor: number,
  cheapestCompetitor: number | null,
  params: PricingParams,
): { price: number; source: string; position: string } {
  if (cheapestCompetitor == null) {
    return {
      price: standardFloor * (params.noDataBuffer || 1.0),
      source: 'cost_floor',
      position: 'no_data',
    };
  }

  if (cheapestCompetitor > standardFloor) {
    // Scenario A: we can comfortably undercut
    return {
      price: cheapestCompetitor * (1 - params.undercutPercent),
      source: 'competitor',
      position: 'competitive',
    };
  }

  if (cheapestCompetitor > survivalFloor) {
    // Scenario B: squeeze margin to stay competitive
    return {
      price: cheapestCompetitor * 0.97,
      source: 'competitor',
      position: 'competitive',
    };
  }

  // Scenario C: can't compete without losing money
  return {
    price: standardFloor,
    source: 'cost_floor',
    position: 'above_market',
  };
}

export function roundTo99(price: number): number {
  if (price < 1) return 0.99;
  return Math.floor(price) + 0.99;
}

interface VariantForPricing {
  id: string;
  dataMb: number;
  validityDays: number;
  price: number;
  priceLocked: boolean;
}

export function enforceMonotonicPricing(variants: VariantForPricing[], step: number): void {
  // Pass 1: Within each validity, more data = more expensive
  const byValidity = new Map<number, VariantForPricing[]>();
  for (const v of variants) {
    if (!byValidity.has(v.validityDays)) byValidity.set(v.validityDays, []);
    byValidity.get(v.validityDays)!.push(v);
  }
  for (const group of byValidity.values()) {
    group.sort((a, b) => a.dataMb - b.dataMb);
    for (let i = 1; i < group.length; i++) {
      if (group[i].priceLocked) continue;
      if (group[i].price <= group[i - 1].price) {
        group[i].price = group[i - 1].price + step;
      }
    }
  }

  // Pass 2: Within each data amount, more validity = more expensive
  const byData = new Map<number, VariantForPricing[]>();
  for (const v of variants) {
    if (!byData.has(v.dataMb)) byData.set(v.dataMb, []);
    byData.get(v.dataMb)!.push(v);
  }
  for (const group of byData.values()) {
    group.sort((a, b) => a.validityDays - b.validityDays);
    for (let i = 1; i < group.length; i++) {
      if (group[i].priceLocked) continue;
      if (group[i].price <= group[i - 1].price) {
        group[i].price = group[i - 1].price + step;
      }
    }
  }
}

export async function findCheapestProviderCost(
  countryCode: string,
  dataMb: number,
  validityDays: number,
): Promise<{ netPrice: number; provider: string } | null> {
  // Find catalog entries that closely match the requested data+validity.
  // Data range: 80%-150% of requested (prevents 10GB matching 1GB).
  // Validity range: wider for short durations since providers may not have exact matches.
  const dataMin = Math.floor(dataMb * 0.8);
  const dataMax = Math.ceil(dataMb * 1.5);
  const validMin = Math.max(1, validityDays <= 3 ? 1 : Math.floor(validityDays * 0.7));
  const validMax = validityDays <= 3 ? 7 : Math.ceil(validityDays * 2.5);

  // Search by parsedJson.regionCodes (always ISO codes like ['AF']) for reliable matching.
  // countryCodes is unreliable — FiRoam stores display names, TGT stores ISO codes.
  const rows = await prisma.$queryRaw<
    Array<{
      netPrice: string;
      provider: string;
      productCode: string;
      dataMb: number;
      validityDays: number;
    }>
  >`
    SELECT "netPrice", "provider", "productCode",
           ROUND(("parsedJson"->>'dataMb')::numeric)::int as "dataMb",
           ROUND(("parsedJson"->>'validityDays')::numeric)::int as "validityDays"
    FROM "ProviderSkuCatalog"
    WHERE "isActive" = true
      AND "netPrice" IS NOT NULL
      AND "parsedJson" IS NOT NULL
      AND ROUND(("parsedJson"->>'dataMb')::numeric) BETWEEN ${dataMin} AND ${dataMax}
      AND ROUND(("parsedJson"->>'validityDays')::numeric) BETWEEN ${validMin} AND ${validMax}
      AND (
        "parsedJson"->'regionCodes' @> ${JSON.stringify([countryCode])}::jsonb
      )
    ORDER BY ABS(ROUND(("parsedJson"->>'dataMb')::numeric) - ${dataMb}) ASC,
             ABS(ROUND(("parsedJson"->>'validityDays')::numeric) - ${validityDays}) ASC,
             "netPrice" ASC
    LIMIT 10
  `;

  if (rows.length === 0) return null;

  // Find cheapest, adjusting FiRoam daypass cost
  let cheapest: { netPrice: number; provider: string } | null = null;
  for (const row of rows) {
    let cost = parseFloat(row.netPrice);
    // FiRoam daypass: netPrice is per-day, multiply by validityDays
    if (row.provider === 'firoam' && row.productCode.includes('?')) {
      cost = cost * validityDays;
    }
    if (!cheapest || cost < cheapest.netPrice) {
      cheapest = { netPrice: cost, provider: row.provider };
    }
  }

  return cheapest;
}

export async function findCheapestCompetitor(
  countryCode: string,
  dataMb: number,
  validityDays: number,
): Promise<{ price: number; brand: string } | null> {
  // Find competitor plans that closely match
  const dataMin = Math.floor(dataMb * 0.8);
  const dataMax = Math.ceil(dataMb * 1.5);
  const validMin = Math.max(1, validityDays <= 3 ? 1 : Math.floor(validityDays * 0.7));
  const validMax = validityDays <= 3 ? 7 : Math.ceil(validityDays * 2.5);

  const result = await prisma.competitorPrice.findFirst({
    where: {
      countryCode,
      dataMb: { gte: dataMin, lte: dataMax },
      validityDays: { gte: validMin, lte: validMax },
    },
    orderBy: { price: 'asc' },
    select: { price: true, brand: true },
  });
  if (!result) return null;
  return { price: Number(result.price), brand: result.brand };
}

export interface CostFloorResult {
  totalProcessed: number;
  totalUpdated: number;
  totalSkipped: number;
  totalErrors: number;
}

export async function calculateCostFloors(
  countryCodes?: string[],
  costFloorParams?: CostFloorParams,
): Promise<CostFloorResult> {
  const cfp = costFloorParams ?? DEFAULT_COST_FLOOR_PARAMS;
  const where: Record<string, unknown> = {};
  if (countryCodes && countryCodes.length > 0) {
    where.template = { countryCode: { in: countryCodes } };
  }

  const variants = await prisma.shopifyProductTemplateVariant.findMany({
    where,
    include: { template: { select: { countryCode: true } } },
  });

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const variant of variants) {
    processed++;
    const parsed = parseShopifySku(variant.sku);
    if (!parsed) {
      skipped++;
      continue;
    }

    try {
      const cheapest = await findCheapestProviderCost(
        variant.template.countryCode,
        parsed.dataMb,
        parsed.validityDays,
      );

      if (!cheapest) {
        // Clear stale cost data if no current match exists
        await prisma.shopifyProductTemplateVariant.update({
          where: { id: variant.id },
          data: { providerCost: null, costFloor: null },
        });
        skipped++;
        continue;
      }

      const { standardFloor } = calculateFloors(cheapest.netPrice, DEFAULT_PRICING_PARAMS, cfp);

      await prisma.shopifyProductTemplateVariant.update({
        where: { id: variant.id },
        data: {
          providerCost: cheapest.netPrice,
          costFloor: standardFloor,
        },
      });
      updated++;
    } catch (err) {
      errors++;
      logger.error({ sku: variant.sku, err }, 'Failed to calculate cost floor');
    }
  }

  return {
    totalProcessed: processed,
    totalUpdated: updated,
    totalSkipped: skipped,
    totalErrors: errors,
  };
}

export async function generateSuggestions(
  params: PricingParams,
  countryCodes?: string[],
): Promise<CostFloorResult> {
  const where: Record<string, unknown> = {};
  if (countryCodes && countryCodes.length > 0) {
    where.template = { countryCode: { in: countryCodes } };
  }

  const variants = await prisma.shopifyProductTemplateVariant.findMany({
    where,
    include: { template: { select: { countryCode: true } } },
    orderBy: [{ templateId: 'asc' }, { sortOrder: 'asc' }],
  });

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  // Group by country + planType for monotonic enforcement
  const groups = new Map<
    string,
    Array<{ id: string; dataMb: number; validityDays: number; price: number; priceLocked: boolean }>
  >();

  for (const variant of variants) {
    processed++;

    if (variant.priceLocked) {
      skipped++;
      // Still track for monotonic enforcement
      const parsed = parseShopifySku(variant.sku);
      if (parsed) {
        const key = `${variant.template.countryCode}:${variant.planType}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push({
          id: variant.id,
          dataMb: parsed.dataMb,
          validityDays: parsed.validityDays,
          price: Number(variant.price),
          priceLocked: true,
        });
      }
      continue;
    }

    const parsed = parseShopifySku(variant.sku);
    if (!parsed) {
      skipped++;
      continue;
    }

    try {
      // Get or calculate provider cost
      let providerCost = variant.providerCost ? Number(variant.providerCost) : null;
      if (providerCost == null) {
        const cheapest = await findCheapestProviderCost(
          variant.template.countryCode,
          parsed.dataMb,
          parsed.validityDays,
        );
        providerCost = cheapest?.netPrice ?? null;
      }

      if (providerCost == null) {
        // No provider cost — can't price
        await prisma.shopifyProductTemplateVariant.update({
          where: { id: variant.id },
          data: { priceSource: 'default', marketPosition: 'no_data' },
        });
        skipped++;
        continue;
      }

      const { standardFloor, survivalFloor } = calculateFloors(providerCost, params);

      // Find competitor
      const competitor = await findCheapestCompetitor(
        variant.template.countryCode,
        parsed.dataMb,
        parsed.validityDays,
      );

      const suggestion = calculateSuggestedPrice(
        standardFloor,
        survivalFloor,
        competitor?.price ?? null,
        params,
      );

      // Track for monotonic enforcement
      const key = `${variant.template.countryCode}:${variant.planType}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({
        id: variant.id,
        dataMb: parsed.dataMb,
        validityDays: parsed.validityDays,
        price: suggestion.price,
        priceLocked: false,
      });

      await prisma.shopifyProductTemplateVariant.update({
        where: { id: variant.id },
        data: {
          providerCost: providerCost,
          costFloor: standardFloor,
          competitorPrice: competitor?.price ?? null,
          competitorBrand: competitor?.brand ?? null,
          proposedPrice: suggestion.price, // will be refined by monotonic step
          priceSource: suggestion.source,
          marketPosition: suggestion.position,
          lastPricedAt: new Date(),
        },
      });
      updated++;
    } catch (err) {
      errors++;
      logger.error({ sku: variant.sku, err }, 'Failed to generate suggestion');
    }
  }

  // Monotonic enforcement + rounding
  for (const [, group] of groups) {
    enforceMonotonicPricing(group, params.monotonicStep);
    for (const v of group) {
      if (v.priceLocked) continue;
      const rounded = roundTo99(v.price);
      await prisma.shopifyProductTemplateVariant.update({
        where: { id: v.id },
        data: { proposedPrice: rounded },
      });
    }
  }

  return {
    totalProcessed: processed,
    totalUpdated: updated,
    totalSkipped: skipped,
    totalErrors: errors,
  };
}
