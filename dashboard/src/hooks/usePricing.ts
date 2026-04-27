import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────

export interface PricingCountryOverview {
  countryCode: string;
  title: string;
  variantCount: number;
  pendingChanges: number;
  lockedCount: number;
  avgCost: number | null;
  avgProposed: number | null;
  marketPosition: string;
  lastPricedAt: string | null;
  lastScrapedAt: string | null;
}

interface OverviewResponse {
  totalCountries: number;
  totalPending: number;
  totalLocked: number;
  countries: PricingCountryOverview[];
}

export interface PricingVariant {
  id: string;
  sku: string;
  planType: string;
  validity: string;
  volume: string;
  price: string;
  priceLocked: boolean;
  providerCost: string | null;
  costFloor: string | null;
  competitorPrice: string | null;
  competitorBrand: string | null;
  proposedPrice: string | null;
  priceSource: string | null;
  marketPosition: string | null;
  lastPricedAt: string | null;
}

interface CountryDetailResponse {
  countryCode: string;
  title: string;
  variants: PricingVariant[];
}

interface CompetitorPriceEntry {
  id: string;
  countryCode: string;
  brand: string;
  price: string;
  dataMb: number;
  validityDays: number;
  coverageType: string | null;
  promoCode: string | null;
  scrapedAt: string;
}

export interface PricingRunEntry {
  id: string;
  type: string;
  status: string;
  scope: string | null;
  params: Record<string, number> | null;
  totalProcessed: number;
  totalUpdated: number;
  totalSkipped: number;
  totalErrors: number;
  createdAt: string;
  completedAt: string | null;
}

export interface MarginTier {
  maxCost: number;
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
  minimumPrice: number;
  marginTiers: MarginTier[];
}

export const DEFAULT_COST_FLOOR_PARAMS: CostFloorParams = {
  minimumPrice: 2.99,
  marginTiers: DEFAULT_MARGIN_TIERS,
};

export type RoundingMode = '99' | '49_99';

export interface PricingParams {
  survivalMargin: number;
  undercutPercent: number;
  minimumPrice: number;
  monotonicStep: number;
  noDataBuffer: number;
  roundingMode: RoundingMode;
  paymentFeePercent: number;
  paymentFeeFixed: number;
}

export const DEFAULT_PRICING_PARAMS: PricingParams = {
  survivalMargin: 0.15,
  undercutPercent: 0.1,
  minimumPrice: 2.99,
  monotonicStep: 0.5,
  noDataBuffer: 1.0,
  roundingMode: '49_99',
  paymentFeePercent: 0.029,
  paymentFeeFixed: 0.3,
};

// ─── Delayed refetch for background tasks ────────────────────────────

function delayedRefetch(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['pricing'] });
  setTimeout(() => void qc.invalidateQueries({ queryKey: ['pricing'] }), 10_000);
  setTimeout(() => void qc.invalidateQueries({ queryKey: ['pricing'] }), 30_000);
  setTimeout(() => void qc.invalidateQueries({ queryKey: ['pricing'] }), 60_000);
}

// ─── Queries ──────────────────────────────────────────────────────────

export function usePricingOverview() {
  return useQuery({
    queryKey: ['pricing', 'overview'],
    queryFn: () => apiClient.get<OverviewResponse>('/pricing/overview'),
  });
}

export function usePricingCountry(countryCode: string | null) {
  return useQuery({
    queryKey: ['pricing', 'country', countryCode],
    queryFn: () => apiClient.get<CountryDetailResponse>(`/pricing/country/${countryCode}`),
    enabled: !!countryCode,
  });
}

export function useCompetitorPrices(params: { countryCode: string; dataMb?: number; validityDays?: number }) {
  const qs = new URLSearchParams({ countryCode: params.countryCode });
  if (params.dataMb) qs.set('dataMb', String(params.dataMb));
  if (params.validityDays) qs.set('validityDays', String(params.validityDays));

  return useQuery({
    queryKey: ['pricing', 'competitors', params],
    queryFn: () =>
      apiClient.get<{ total: number; prices: CompetitorPriceEntry[] }>(
        `/pricing/competitor-prices?${qs.toString()}`,
      ),
    enabled: !!params.countryCode,
  });
}

export function usePricingRuns() {
  return useQuery({
    queryKey: ['pricing', 'runs'],
    queryFn: () => apiClient.get<{ runs: PricingRunEntry[] }>('/pricing/runs'),
  });
}

// ─── Mutations ────────────────────────────────────────────────────────

export function useScrapeCompetitors() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { countries?: string[] }) =>
      apiClient.post<{ ok: boolean; background: string }>('/pricing/scrape-competitors', input),
    onSuccess: () => delayedRefetch(qc),
  });
}

export function useCalculateCostFloors() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { countries?: string[]; costFloorParams?: Partial<CostFloorParams> }) =>
      apiClient.post<{ ok: boolean; background: string }>('/pricing/calculate-cost-floors', input),
    onSuccess: () => delayedRefetch(qc),
  });
}

export function useGenerateSuggestions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { countries?: string[]; params?: Partial<PricingParams> }) =>
      apiClient.post<{ ok: boolean; background: string; params: PricingParams }>(
        '/pricing/generate-suggestions',
        input,
      ),
    onSuccess: () => delayedRefetch(qc),
  });
}

export function useApprovePricing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { countryCodes: string[] }) =>
      apiClient.post<{ ok: boolean; updated: number }>('/pricing/approve', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pricing'] });
    },
  });
}

export function useApproveAndPush() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { countryCodes: string[] }) =>
      apiClient.post<{ ok: boolean; updated: number; background: string }>(
        '/pricing/approve-and-push',
        input,
      ),
    onSuccess: () => delayedRefetch(qc),
  });
}

export function useBulkLockVariants() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { variantIds: string[]; priceLocked: boolean }) =>
      apiClient.patch<{ ok: boolean; updated: number }>('/pricing/variants/bulk-lock', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pricing'] });
    },
  });
}
