import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import type { CatalogItem, CatalogPage } from '@/lib/types';

interface UseCatalogParams {
  provider?: string;
  search?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

interface SyncInput {
  provider: string;
  pageSize?: number;
  maxPages?: number;
  maxSkus?: number;
}

interface SyncResult {
  ok: boolean;
  provider: string;
  processed?: number;
  processedPackages?: number;
  total?: number;
}

export function useCatalog(params: UseCatalogParams = {}) {
  const { provider, search, isActive, limit = 100, offset = 0 } = params;

  const searchParams = new URLSearchParams();
  if (provider) searchParams.set('provider', provider);
  if (search) searchParams.set('search', search);
  if (isActive !== undefined) searchParams.set('isActive', String(isActive));
  searchParams.set('limit', String(limit));
  searchParams.set('offset', String(offset));

  return useQuery({
    queryKey: ['catalog', { provider, search, isActive, limit, offset }],
    queryFn: () => apiClient.get<CatalogPage<CatalogItem>>(`/provider-catalog?${searchParams.toString()}`),
    placeholderData: (prev) => prev,
  });
}

export function useSyncCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SyncInput) =>
      apiClient.post<SyncResult>('/provider-catalog/sync', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['catalog'] });
    },
  });
}
