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

export type RoundingMode = '99' | '49_99';

export interface PricingParams {
  survivalMargin: number; // default 0.15 (15%)
  undercutPercent: number; // default 0.10 (10%)
  minimumPrice: number; // default 2.99
  monotonicStep: number; // default 0.50 (post-rounding step between adjacent variants)
  noDataBuffer: number; // default 1.0 (multiplier on floor when no competitor data)
  roundingMode: RoundingMode; // default '49_99'
  // Per-transaction payment processing fees absorbed into the cost floor before margin tiers.
  // Approximates retail-side fees against cost; the markup absorbs the small delta.
  paymentFeePercent: number; // default 0.029 (Shopify Payments 2.9%)
  paymentFeeFixed: number; // default 0.30 ($0.30 per transaction)
}

export const DEFAULT_PRICING_PARAMS: PricingParams = {
  survivalMargin: 0.15,
  undercutPercent: 0.1,
  minimumPrice: 2.99,
  monotonicStep: 1.0,
  noDataBuffer: 1.0,
  roundingMode: '49_99',
  // Backend defaults are 0 so existing flows are unchanged. The dashboard ships
  // Shopify-shaped recommendations (2.9% + $0.30) which the user can opt into.
  paymentFeePercent: 0,
  paymentFeeFixed: 0,
};

function getMultiplier(cost: number, tiers: MarginTier[]): number {
  for (const tier of tiers) {
    if (cost < tier.maxCost) return tier.multiplier;
  }
  return tiers[tiers.length - 1]?.multiplier ?? 1.25;
}

export function applyPaymentFees(cost: number, params: PricingParams): number {
  const pct = Math.max(0, params.paymentFeePercent ?? 0);
  const fixed = Math.max(0, params.paymentFeeFixed ?? 0);
  return cost + cost * pct + fixed;
}

export function calculateFloors(
  cost: number,
  params: PricingParams,
  costFloorParams?: CostFloorParams,
): { standardFloor: number; survivalFloor: number } {
  const cfp = costFloorParams ?? DEFAULT_COST_FLOOR_PARAMS;
  const minPrice = cfp.minimumPrice;
  const grossCost = applyPaymentFees(cost, params);
  return {
    standardFloor: Math.max(minPrice, grossCost * getMultiplier(grossCost, cfp.marginTiers)),
    survivalFloor: Math.max(minPrice, grossCost * (1 + params.survivalMargin)),
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

export function roundPrice(price: number, mode: RoundingMode = '49_99'): number {
  if (price < 1) return 0.99;
  if (mode === '99') {
    return Math.floor(price) + 0.99;
  }
  // '49_99': round UP to the next .49 or .99 (never below input price)
  const base = Math.floor(price);
  const candidates = [base + 0.49, base + 0.99, base + 1.49].filter((c) => c >= 0.99);
  const rounded = candidates.find((c) => c >= price) ?? base + 1.99;
  return parseFloat(rounded.toFixed(2));
}

/** @deprecated Use roundPrice instead */
export function roundTo99(price: number): number {
  return roundPrice(price, '99');
}

interface VariantForPricing {
  id: string;
  dataMb: number;
  validityDays: number;
  price: number;
  priceLocked: boolean;
}

/**
 * Enforce strict monotonic pricing across the (dataMb × validityDays) partial order.
 *
 * For any pair A, B where A.dataMb ≤ B.dataMb AND A.validityDays ≤ B.validityDays
 * AND (A.dataMb < B.dataMb OR A.validityDays < B.validityDays), require:
 *   B.price ≥ A.price + step
 *
 * Catches "diagonal" violations (e.g. 1GB/3d vs 2GB/2d) that the previous 2-pass
 * algorithm missed. Locked variants are not modified but still anchor the order.
 *
 * O(N²) per call — N is small (≤ ~50 variants per country).
 */
export function enforceMonotonicPricing(variants: VariantForPricing[], step: number): void {
  // Sweep in partial-order: predecessors must come before successors.
  const sorted = [...variants].sort(
    (a, b) =>
      a.dataMb + a.validityDays - (b.dataMb + b.validityDays) ||
      a.dataMb - b.dataMb ||
      a.validityDays - b.validityDays,
  );
  for (const b of sorted) {
    let maxPredecessor = -Infinity;
    for (const a of sorted) {
      if (a === b) continue;
      const dataLE = a.dataMb <= b.dataMb;
      const daysLE = a.validityDays <= b.validityDays;
      const strict = a.dataMb < b.dataMb || a.validityDays < b.validityDays;
      if (dataLE && daysLE && strict) {
        if (a.price > maxPredecessor) maxPredecessor = a.price;
      }
    }
    if (b.priceLocked) continue;
    if (maxPredecessor !== -Infinity && b.price <= maxPredecessor) {
      b.price = maxPredecessor + step;
    }
  }
}

/* v8 ignore start — DB-dependent orchestration, integration-tested in production */
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
    // Country-only pricing path; region templates have no countryCode.
    if (!variant.template.countryCode) {
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
        const key = `${variant.template.countryCode}`;
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
    // Country-only pricing path; region templates have no countryCode.
    if (!variant.template.countryCode) {
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

      // Use existing costFloor from Step 2 if available, otherwise calculate
      const existingFloor = variant.costFloor ? Number(variant.costFloor) : null;
      const { standardFloor, survivalFloor } = existingFloor
        ? {
            standardFloor: existingFloor,
            survivalFloor: Math.max(
              params.minimumPrice,
              providerCost * (1 + params.survivalMargin),
            ),
          }
        : calculateFloors(providerCost, params);

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

      // Track for monotonic enforcement. Group by country only so diagonals across
      // planType (Day-Pass vs Total Data) are also enforced — customers see them on
      // the same product page and expect a coherent ladder.
      const key = `${variant.template.countryCode}`;
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
          // Don't overwrite costFloor — it's set by Step 2 with its own params
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

  // Round first, then enforce monotonic on rounded prices, so the step survives rounding.
  // Without this ordering, two variants both clamped to the $2.99 minimum would get
  // bumped to $3.49 / etc by monotonic but rounding back up could erode the step;
  // by rounding first, the partial-order sweep guarantees rounded[B] ≥ rounded[A] + step.
  for (const [, group] of groups) {
    for (const v of group) {
      if (!v.priceLocked) v.price = roundPrice(v.price, params.roundingMode);
    }
    enforceMonotonicPricing(group, params.monotonicStep);
    for (const v of group) {
      if (v.priceLocked) continue;
      await prisma.shopifyProductTemplateVariant.update({
        where: { id: v.id },
        data: { proposedPrice: v.price },
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
/* v8 ignore stop */
