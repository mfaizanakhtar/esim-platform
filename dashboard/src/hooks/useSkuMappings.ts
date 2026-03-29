import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import type { SkuMapping, SkuMappingsPage, SkuMappingProvider } from '@/lib/types';

interface UseSkuMappingsParams {
  provider?: SkuMappingProvider;
  isActive?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

function buildUrl(params: UseSkuMappingsParams): string {
  const { provider, isActive, search, limit = 100, offset = 0 } = params;
  const sp = new URLSearchParams();
  if (provider) sp.set('provider', provider);
  if (isActive !== undefined) sp.set('isActive', String(isActive));
  if (search) sp.set('search', search);
  sp.set('limit', String(limit));
  sp.set('offset', String(offset));
  return `/sku-mappings?${sp.toString()}`;
}

export function useSkuMappings(params: UseSkuMappingsParams = {}) {
  const { provider, isActive, search, limit = 100, offset = 0 } = params;

  return useQuery({
    queryKey: ['sku-mappings', { provider, isActive, search, limit, offset }],
    queryFn: () => apiClient.get<SkuMappingsPage<SkuMapping>>(buildUrl(params)),
  });
}

/**
 * Load ALL mappings regardless of count.
 * Phase 1: fetch the first 500 to learn the total.
 * Phase 2: if total > 500, fetch with limit=total so every record is included.
 */
const INITIAL_BATCH = 500;

export function useAllSkuMappings(params: Omit<UseSkuMappingsParams, 'limit' | 'offset'> = {}) {
  const phase1 = useQuery({
    queryKey: ['sku-mappings', 'all-phase1', params],
    queryFn: () =>
      apiClient.get<SkuMappingsPage<SkuMapping>>(buildUrl({ ...params, limit: INITIAL_BATCH, offset: 0 })),
  });

  const needsMore = (phase1.data?.total ?? 0) > INITIAL_BATCH;

  const phase2 = useQuery({
    queryKey: ['sku-mappings', 'all-phase2', { ...params, total: phase1.data?.total }],
    queryFn: () =>
      apiClient.get<SkuMappingsPage<SkuMapping>>(
        buildUrl({ ...params, limit: phase1.data!.total, offset: 0 }),
      ),
    enabled: needsMore,
  });

  const data = needsMore
    ? (phase2.data ?? null)
    : (phase1.data ?? null);

  return {
    data,
    isLoading: phase1.isLoading || (needsMore && phase2.isLoading),
  };
}
