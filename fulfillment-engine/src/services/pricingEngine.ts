import prisma from '~/db/prisma';
import { parseShopifySku } from '~/utils/parseShopifySku';
import { logger } from '~/utils/logger';

export interface PricingParams {
  survivalMargin: number; // default 0.15 (15%)
  undercutPercent: number; // default 0.10 (10%)
  minimumPrice: number; // default 2.99
  monotonicStep: number; // default 1.00
}

export const DEFAULT_PRICING_PARAMS: PricingParams = {
  survivalMargin: 0.15,
  undercutPercent: 0.1,
  minimumPrice: 2.99,
  monotonicStep: 1.0,
};

function getMultiplier(cost: number): number {
  if (cost < 1) return 3.0;
  if (cost < 3) return 2.5;
  if (cost < 5) return 2.0;
  if (cost < 10) return 1.8;
  if (cost < 20) return 1.5;
  if (cost < 40) return 1.35;
  return 1.25;
}

export function calculateFloors(
  cost: number,
  params: PricingParams,
): { standardFloor: number; survivalFloor: number } {
  return {
    standardFloor: Math.max(params.minimumPrice, cost * getMultiplier(cost)),
    survivalFloor: Math.max(params.minimumPrice, cost * (1 + params.survivalMargin)),
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
      price: standardFloor * 1.2,
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
  variants.sort((a, b) => a.validityDays - b.validityDays || a.dataMb - b.dataMb);
  for (let i = 1; i < variants.length; i++) {
    if (variants[i].priceLocked) continue; // locked is a fixed point
    const prev = variants[i - 1].price;
    if (variants[i].price <= prev) {
      variants[i].price = prev + step;
    }
  }
}

export async function findCheapestProviderCost(
  countryCode: string,
  dataMb: number,
  validityDays: number,
): Promise<{ netPrice: number; provider: string } | null> {
  // Query catalog entries matching this country + data + validity
  const rows = await prisma.$queryRaw<
    Array<{ netPrice: string; provider: string; productCode: string; parsedJson: unknown }>
  >`
    SELECT "netPrice", "provider", "productCode", "parsedJson"
    FROM "ProviderSkuCatalog"
    WHERE "isActive" = true
      AND "netPrice" IS NOT NULL
      AND "parsedJson" IS NOT NULL
      AND ("parsedJson"->>'dataMb')::int >= ${dataMb}
      AND ("parsedJson"->>'validityDays')::int >= ${validityDays}
      AND "countryCodes"::jsonb @> ${JSON.stringify([countryCode])}::jsonb
    ORDER BY "netPrice" ASC
    LIMIT 5
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
  const result = await prisma.competitorPrice.findFirst({
    where: {
      countryCode,
      dataMb: { gte: dataMb },
      validityDays: { gte: validityDays },
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

export async function calculateCostFloors(countryCodes?: string[]): Promise<CostFloorResult> {
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
        skipped++;
        continue;
      }

      const { standardFloor } = calculateFloors(cheapest.netPrice, DEFAULT_PRICING_PARAMS);

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
