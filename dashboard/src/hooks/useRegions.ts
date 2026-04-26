import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Region {
  id: string;
  code: string;
  parentCode: string;
  name: string;
  description: string | null;
  countryCodes: string[];
  isActive: boolean;
  sortOrder: number;
  templateCount?: number;
  createdAt: string;
  updatedAt: string;
}

interface RegionListResponse {
  total: number;
  regions: Region[];
}

export type SuggestionKind = 'INTERSECTION' | 'UNION';

export interface RegionSuggestion {
  code: string;
  parentCode: string;
  countryCodes: string[];
  kind: SuggestionKind;
  rationale: string;
  providersAvailable: string[];
}

export interface ProviderRegionCoverage {
  provider: string;
  countries: string[];
  skuCount: number;
}

export interface RegionGroup {
  label: string;
  parentCode: string;
  providers: ProviderRegionCoverage[];
  intersection: string[];
  union: string[];
  suggestions: RegionSuggestion[];
}

interface SuggestionsResponse {
  total: number;
  suggestionCount: number;
  groups: RegionGroup[];
}

// ── Queries ──────────────────────────────────────────────────────────────────

export function useRegions() {
  return useQuery({
    queryKey: ['regions'],
    queryFn: () => apiClient.get<RegionListResponse>('/regions'),
  });
}

/**
 * NOTE: disabled by default — the user must click a "Discover" button to fire
 * this. Discovery scans the whole catalog and aggregates per-provider coverage,
 * so we don't want to run it on every page mount.
 */
export function useRegionSuggestions() {
  return useQuery({
    queryKey: ['region-suggestions'],
    queryFn: () => apiClient.get<SuggestionsResponse>('/regions/suggestions'),
    enabled: false,
  });
}

// ── Mutations ────────────────────────────────────────────────────────────────

export function useAcceptSuggestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) =>
      apiClient.post<Region>('/regions/accept-suggestion', { code }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['regions'] });
      void qc.invalidateQueries({ queryKey: ['region-suggestions'] });
    },
  });
}

interface UpdateRegionInput {
  code: string;
  data: Partial<Pick<Region, 'name' | 'description' | 'isActive' | 'sortOrder'>> & {
    parentCode?: string;
    countryCodes?: string[];
  };
}

export function useUpdateRegion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ code, data }: UpdateRegionInput) =>
      apiClient.patch<Region>(`/regions/${code}`, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['regions'] });
    },
  });
}

export function useDeleteRegion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) =>
      apiClient.delete<{ ok: true; deleted: string }>(`/regions/${code}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['regions'] });
      void qc.invalidateQueries({ queryKey: ['region-suggestions'] });
    },
  });
}
