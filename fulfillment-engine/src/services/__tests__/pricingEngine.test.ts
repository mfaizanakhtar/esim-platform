import { describe, it, expect } from 'vitest';
import {
  calculateFloors,
  calculateSuggestedPrice,
  roundTo99,
  enforceMonotonicPricing,
  DEFAULT_PRICING_PARAMS,
  DEFAULT_MARGIN_TIERS,
  DEFAULT_COST_FLOOR_PARAMS,
  type PricingParams,
  type CostFloorParams,
} from '~/services/pricingEngine';

// ---------------------------------------------------------------------------
// Constants / defaults
// ---------------------------------------------------------------------------
describe('DEFAULT_PRICING_PARAMS', () => {
  it('has expected default values', () => {
    expect(DEFAULT_PRICING_PARAMS).toEqual({
      survivalMargin: 0.15,
      undercutPercent: 0.1,
      minimumPrice: 2.99,
      monotonicStep: 1.0,
      noDataBuffer: 1.0,
    });
  });
});

describe('DEFAULT_MARGIN_TIERS', () => {
  it('has 7 tiers sorted by maxCost ascending', () => {
    expect(DEFAULT_MARGIN_TIERS).toHaveLength(7);
    for (let i = 1; i < DEFAULT_MARGIN_TIERS.length; i++) {
      expect(DEFAULT_MARGIN_TIERS[i].maxCost).toBeGreaterThan(DEFAULT_MARGIN_TIERS[i - 1].maxCost);
    }
  });

  it('last tier has Infinity maxCost', () => {
    expect(DEFAULT_MARGIN_TIERS[DEFAULT_MARGIN_TIERS.length - 1].maxCost).toBe(Infinity);
  });

  it('multipliers decrease as cost increases', () => {
    for (let i = 1; i < DEFAULT_MARGIN_TIERS.length; i++) {
      expect(DEFAULT_MARGIN_TIERS[i].multiplier).toBeLessThan(
        DEFAULT_MARGIN_TIERS[i - 1].multiplier,
      );
    }
  });
});

describe('DEFAULT_COST_FLOOR_PARAMS', () => {
  it('uses minimumPrice 2.99 and default tiers', () => {
    expect(DEFAULT_COST_FLOOR_PARAMS.minimumPrice).toBe(2.99);
    expect(DEFAULT_COST_FLOOR_PARAMS.marginTiers).toBe(DEFAULT_MARGIN_TIERS);
  });
});

// ---------------------------------------------------------------------------
// calculateFloors (also tests getMultiplier indirectly)
// ---------------------------------------------------------------------------
describe('calculateFloors', () => {
  const params = DEFAULT_PRICING_PARAMS;

  it('tier 1: cost < $1 uses 3.0x multiplier', () => {
    const { standardFloor, survivalFloor } = calculateFloors(0.5, params);
    // 0.5 * 3.0 = 1.5, but minimum is 2.99
    expect(standardFloor).toBe(2.99);
    expect(survivalFloor).toBe(2.99); // 0.5 * 1.15 = 0.575 < 2.99
  });

  it('tier 2: cost $1-$3 uses 2.5x multiplier', () => {
    const { standardFloor } = calculateFloors(2, params);
    // 2 * 2.5 = 5.0 > 2.99
    expect(standardFloor).toBe(5.0);
  });

  it('tier 3: cost $3-$5 uses 2.0x multiplier', () => {
    const { standardFloor } = calculateFloors(4, params);
    // 4 * 2.0 = 8.0
    expect(standardFloor).toBe(8.0);
  });

  it('tier 4: cost $5-$10 uses 1.8x multiplier', () => {
    const { standardFloor } = calculateFloors(7, params);
    // 7 * 1.8 = 12.6
    expect(standardFloor).toBe(12.6);
  });

  it('tier 5: cost $10-$20 uses 1.5x multiplier', () => {
    const { standardFloor } = calculateFloors(15, params);
    // 15 * 1.5 = 22.5
    expect(standardFloor).toBe(22.5);
  });

  it('tier 6: cost $20-$40 uses 1.35x multiplier', () => {
    const { standardFloor } = calculateFloors(30, params);
    // 30 * 1.35 = 40.5
    expect(standardFloor).toBe(40.5);
  });

  it('tier 7: cost >= $40 uses 1.25x multiplier', () => {
    const { standardFloor } = calculateFloors(50, params);
    // 50 * 1.25 = 62.5
    expect(standardFloor).toBe(62.5);
  });

  it('enforces minimum price on standard floor', () => {
    const { standardFloor } = calculateFloors(0.1, params);
    // 0.1 * 3.0 = 0.3, clamped to 2.99
    expect(standardFloor).toBe(2.99);
  });

  it('enforces minimum price on survival floor', () => {
    const { survivalFloor } = calculateFloors(0.5, params);
    // 0.5 * 1.15 = 0.575, clamped to 2.99
    expect(survivalFloor).toBe(2.99);
  });

  it('calculates survival floor correctly for higher costs', () => {
    const { survivalFloor } = calculateFloors(10, params);
    // 10 * 1.15 = 11.5 > 2.99
    expect(survivalFloor).toBe(11.5);
  });

  it('uses custom costFloorParams when provided', () => {
    const customCfp: CostFloorParams = {
      minimumPrice: 5.0,
      marginTiers: [{ maxCost: Infinity, multiplier: 2.0 }],
    };
    const { standardFloor } = calculateFloors(2, params, customCfp);
    // 2 * 2.0 = 4.0 < 5.0 minimum
    expect(standardFloor).toBe(5.0);
  });

  it('uses custom costFloorParams multiplier', () => {
    const customCfp: CostFloorParams = {
      minimumPrice: 1.0,
      marginTiers: [{ maxCost: Infinity, multiplier: 4.0 }],
    };
    const { standardFloor } = calculateFloors(5, params, customCfp);
    // 5 * 4.0 = 20.0
    expect(standardFloor).toBe(20.0);
  });

  it('tier boundary: cost exactly at boundary uses next tier', () => {
    // cost = 1 is NOT < 1, so it falls to the next tier (maxCost: 3, multiplier 2.5)
    const { standardFloor } = calculateFloors(1, params);
    expect(standardFloor).toBe(2.99); // 1 * 2.5 = 2.5, clamped to 2.99
  });

  it('tier boundary: cost exactly at $3 uses tier 3 (2.0x)', () => {
    const { standardFloor } = calculateFloors(3, params);
    // 3 is NOT < 3, so falls to next tier: maxCost 5, multiplier 2.0
    expect(standardFloor).toBe(6.0);
  });

  it('tier boundary: cost exactly at $5 uses tier 4 (1.8x)', () => {
    const { standardFloor } = calculateFloors(5, params);
    expect(standardFloor).toBe(9.0); // 5 * 1.8
  });

  it('tier boundary: cost exactly at $10 uses tier 5 (1.5x)', () => {
    const { standardFloor } = calculateFloors(10, params);
    expect(standardFloor).toBe(15.0); // 10 * 1.5
  });

  it('tier boundary: cost exactly at $20 uses tier 6 (1.35x)', () => {
    const { standardFloor } = calculateFloors(20, params);
    expect(standardFloor).toBe(27.0); // 20 * 1.35
  });

  it('tier boundary: cost exactly at $40 uses tier 7 (1.25x)', () => {
    const { standardFloor } = calculateFloors(40, params);
    expect(standardFloor).toBe(50.0); // 40 * 1.25
  });
});

// ---------------------------------------------------------------------------
// calculateSuggestedPrice
// ---------------------------------------------------------------------------
describe('calculateSuggestedPrice', () => {
  const params = DEFAULT_PRICING_PARAMS;

  describe('no competitor data', () => {
    it('returns standardFloor * noDataBuffer with cost_floor source', () => {
      const result = calculateSuggestedPrice(10, 6, null, params);
      expect(result).toEqual({
        price: 10, // 10 * 1.0
        source: 'cost_floor',
        position: 'no_data',
      });
    });

    it('applies noDataBuffer multiplier', () => {
      const customParams: PricingParams = { ...params, noDataBuffer: 1.2 };
      const result = calculateSuggestedPrice(10, 6, null, customParams);
      expect(result.price).toBeCloseTo(12.0);
      expect(result.position).toBe('no_data');
    });

    it('handles noDataBuffer of 0 gracefully (falls back to 1.0)', () => {
      const customParams: PricingParams = { ...params, noDataBuffer: 0 };
      const result = calculateSuggestedPrice(10, 6, null, customParams);
      // noDataBuffer || 1.0 => 1.0 when noDataBuffer is 0
      expect(result.price).toBe(10);
    });
  });

  describe('Scenario A: competitor > standardFloor', () => {
    it('undercuts competitor by undercutPercent', () => {
      // standardFloor=10, competitor=20 => 20 * 0.9 = 18
      const result = calculateSuggestedPrice(10, 6, 20, params);
      expect(result).toEqual({
        price: 18,
        source: 'competitor',
        position: 'competitive',
      });
    });

    it('uses custom undercutPercent', () => {
      const customParams: PricingParams = { ...params, undercutPercent: 0.2 };
      const result = calculateSuggestedPrice(10, 6, 20, customParams);
      expect(result.price).toBe(16); // 20 * 0.8
    });
  });

  describe('Scenario B: competitor between survivalFloor and standardFloor', () => {
    it('squeezes margin at 97% of competitor', () => {
      // standardFloor=10, survivalFloor=6, competitor=8
      // competitor is not > 10 (not A), but > 6 (B)
      const result = calculateSuggestedPrice(10, 6, 8, params);
      expect(result.price).toBeCloseTo(7.76); // 8 * 0.97
      expect(result.source).toBe('competitor');
      expect(result.position).toBe('competitive');
    });

    it('works at survivalFloor boundary (just above)', () => {
      // competitor = 6.01, survivalFloor = 6
      const result = calculateSuggestedPrice(10, 6, 6.01, params);
      expect(result.price).toBeCloseTo(5.8297); // 6.01 * 0.97
      expect(result.source).toBe('competitor');
    });
  });

  describe('Scenario C: competitor <= survivalFloor', () => {
    it('returns standardFloor as price (cannot compete)', () => {
      // standardFloor=10, survivalFloor=6, competitor=5
      const result = calculateSuggestedPrice(10, 6, 5, params);
      expect(result).toEqual({
        price: 10,
        source: 'cost_floor',
        position: 'above_market',
      });
    });

    it('returns standardFloor when competitor equals survivalFloor', () => {
      const result = calculateSuggestedPrice(10, 6, 6, params);
      expect(result).toEqual({
        price: 10,
        source: 'cost_floor',
        position: 'above_market',
      });
    });

    it('returns standardFloor when competitor is very low', () => {
      const result = calculateSuggestedPrice(10, 6, 0.5, params);
      expect(result.price).toBe(10);
      expect(result.position).toBe('above_market');
    });
  });

  describe('edge cases', () => {
    it('competitor exactly equals standardFloor triggers Scenario B', () => {
      // competitor=10, standardFloor=10 => NOT > 10, so not A
      // competitor=10 > survivalFloor=6 => B
      const result = calculateSuggestedPrice(10, 6, 10, params);
      expect(result.price).toBeCloseTo(9.7); // 10 * 0.97
      expect(result.source).toBe('competitor');
    });

    it('standardFloor equals survivalFloor', () => {
      // Both floors are same — any competitor > floor is Scenario A
      const result = calculateSuggestedPrice(10, 10, 15, params);
      expect(result.price).toBe(13.5); // 15 * 0.9
      expect(result.position).toBe('competitive');
    });
  });
});

// ---------------------------------------------------------------------------
// roundTo99
// ---------------------------------------------------------------------------
describe('roundTo99', () => {
  it('returns 0.99 for values less than 1', () => {
    expect(roundTo99(0.5)).toBe(0.99);
    expect(roundTo99(0.01)).toBe(0.99);
    expect(roundTo99(0.99)).toBe(0.99);
  });

  it('rounds normal values to floor + 0.99', () => {
    expect(roundTo99(5.5)).toBe(5.99);
    expect(roundTo99(10.0)).toBe(10.99);
    expect(roundTo99(10.01)).toBe(10.99);
    expect(roundTo99(10.99)).toBe(10.99);
    expect(roundTo99(99.5)).toBe(99.99);
  });

  it('handles exact integers', () => {
    expect(roundTo99(1)).toBe(1.99);
    expect(roundTo99(5)).toBe(5.99);
    expect(roundTo99(100)).toBe(100.99);
  });

  it('handles value just below 1', () => {
    expect(roundTo99(0.999)).toBe(0.99);
  });

  it('handles value exactly 1', () => {
    expect(roundTo99(1.0)).toBe(1.99);
  });

  it('handles large values', () => {
    expect(roundTo99(999.12)).toBe(999.99);
  });
});

// ---------------------------------------------------------------------------
// enforceMonotonicPricing
// ---------------------------------------------------------------------------
describe('enforceMonotonicPricing', () => {
  const step = 1.0;

  describe('within-validity enforcement (more data = more expensive)', () => {
    it('bumps price when smaller-data variant is more expensive', () => {
      const variants = [
        { id: '1', dataMb: 1024, validityDays: 7, price: 10, priceLocked: false },
        { id: '2', dataMb: 3072, validityDays: 7, price: 8, priceLocked: false },
        { id: '3', dataMb: 5120, validityDays: 7, price: 12, priceLocked: false },
      ];
      enforceMonotonicPricing(variants, step);
      // variant 2 (3GB) should be bumped: 10 + 1 = 11
      expect(variants[1].price).toBe(11);
      // variant 3 (5GB) was 12 > 11 so stays
      expect(variants[2].price).toBe(12);
    });

    it('cascades bumps through multiple variants', () => {
      const variants = [
        { id: '1', dataMb: 1024, validityDays: 7, price: 10, priceLocked: false },
        { id: '2', dataMb: 2048, validityDays: 7, price: 5, priceLocked: false },
        { id: '3', dataMb: 3072, validityDays: 7, price: 6, priceLocked: false },
      ];
      enforceMonotonicPricing(variants, step);
      expect(variants[1].price).toBe(11); // 10 + 1
      expect(variants[2].price).toBe(12); // 11 + 1
    });

    it('does not modify correctly ordered variants', () => {
      const variants = [
        { id: '1', dataMb: 1024, validityDays: 7, price: 5, priceLocked: false },
        { id: '2', dataMb: 3072, validityDays: 7, price: 10, priceLocked: false },
        { id: '3', dataMb: 5120, validityDays: 7, price: 15, priceLocked: false },
      ];
      enforceMonotonicPricing(variants, step);
      expect(variants[0].price).toBe(5);
      expect(variants[1].price).toBe(10);
      expect(variants[2].price).toBe(15);
    });
  });

  describe('within-data enforcement (more validity = more expensive)', () => {
    it('bumps price when shorter-validity variant is more expensive', () => {
      const variants = [
        { id: '1', dataMb: 1024, validityDays: 7, price: 10, priceLocked: false },
        { id: '2', dataMb: 1024, validityDays: 14, price: 8, priceLocked: false },
        { id: '3', dataMb: 1024, validityDays: 30, price: 15, priceLocked: false },
      ];
      enforceMonotonicPricing(variants, step);
      // variant 2 (14d) should be bumped: 10 + 1 = 11
      expect(variants[1].price).toBe(11);
      expect(variants[2].price).toBe(15);
    });
  });

  describe('locked variants', () => {
    it('does not modify locked variants', () => {
      const variants = [
        { id: '1', dataMb: 1024, validityDays: 7, price: 10, priceLocked: false },
        { id: '2', dataMb: 3072, validityDays: 7, price: 5, priceLocked: true },
        { id: '3', dataMb: 5120, validityDays: 7, price: 3, priceLocked: false },
      ];
      enforceMonotonicPricing(variants, step);
      // Locked variant stays at 5, even though it should be >= 11
      expect(variants[1].price).toBe(5);
      // Unlocked variant 3 gets bumped relative to variant 2 (locked at 5): 5 + 1 = 6
      expect(variants[2].price).toBe(6);
    });

    it('locked variant acts as a fixed point for subsequent variants', () => {
      const variants = [
        { id: '1', dataMb: 1024, validityDays: 7, price: 20, priceLocked: true },
        { id: '2', dataMb: 2048, validityDays: 7, price: 10, priceLocked: false },
      ];
      enforceMonotonicPricing(variants, step);
      // variant 2 should be bumped: 20 + 1 = 21
      expect(variants[1].price).toBe(21);
    });
  });

  describe('custom step', () => {
    it('uses provided step value', () => {
      const variants = [
        { id: '1', dataMb: 1024, validityDays: 7, price: 10, priceLocked: false },
        { id: '2', dataMb: 2048, validityDays: 7, price: 8, priceLocked: false },
      ];
      enforceMonotonicPricing(variants, 2.0);
      expect(variants[1].price).toBe(12); // 10 + 2
    });
  });

  describe('mixed data and validity groups', () => {
    it('enforces both dimensions', () => {
      const variants = [
        { id: '1', dataMb: 1024, validityDays: 7, price: 10, priceLocked: false },
        { id: '2', dataMb: 1024, validityDays: 14, price: 8, priceLocked: false },
        { id: '3', dataMb: 2048, validityDays: 7, price: 5, priceLocked: false },
        { id: '4', dataMb: 2048, validityDays: 14, price: 6, priceLocked: false },
      ];
      enforceMonotonicPricing(variants, step);

      // Pass 1 (by validity):
      //   validity=7: [1024@10, 2048@5] => 2048 bumped to 11
      //   validity=14: [1024@8, 2048@6] => 2048 bumped to 9
      // Pass 2 (by data):
      //   data=1024: [7d@10, 14d@8] => 14d bumped to 11
      //   data=2048: [7d@11, 14d@9] => 14d bumped to 12

      // variant 1: 1024/7d stays at 10
      expect(variants[0].price).toBe(10);
      // variant 2: 1024/14d bumped to 11 (by data pass)
      expect(variants[1].price).toBe(11);
      // variant 3: 2048/7d bumped to 11 (by validity pass)
      expect(variants[2].price).toBe(11);
      // variant 4: 2048/14d bumped to 12 (by data pass: 11 + 1)
      expect(variants[3].price).toBe(12);
    });
  });

  describe('edge cases', () => {
    it('handles single variant', () => {
      const variants = [{ id: '1', dataMb: 1024, validityDays: 7, price: 10, priceLocked: false }];
      enforceMonotonicPricing(variants, step);
      expect(variants[0].price).toBe(10);
    });

    it('handles empty array', () => {
      const variants: Array<{
        id: string;
        dataMb: number;
        validityDays: number;
        price: number;
        priceLocked: boolean;
      }> = [];
      enforceMonotonicPricing(variants, step);
      expect(variants).toHaveLength(0);
    });

    it('handles equal prices (bumps when equal)', () => {
      const variants = [
        { id: '1', dataMb: 1024, validityDays: 7, price: 10, priceLocked: false },
        { id: '2', dataMb: 2048, validityDays: 7, price: 10, priceLocked: false },
      ];
      enforceMonotonicPricing(variants, step);
      // Equal prices trigger a bump (<=)
      expect(variants[1].price).toBe(11);
    });
  });
});
