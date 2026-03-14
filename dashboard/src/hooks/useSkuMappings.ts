import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import type { SkuMapping, PaginatedResponse } from '@/lib/types';

interface SkuMappingsResponse extends PaginatedResponse<SkuMapping> {
  mappings: SkuMapping[];
}

interface UseSkuMappingsParams {
  provider?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

export function useSkuMappings(params: UseSkuMappingsParams = {}) {
  const { provider, isActive, limit = 100, offset = 0 } = params;

  const searchParams = new URLSearchParams();
  if (provider) searchParams.set('provider', provider);
  if (isActive !== undefined) searchParams.set('isActive', String(isActive));
  searchParams.set('limit', String(limit));
  searchParams.set('offset', String(offset));

  return useQuery({
    queryKey: ['sku-mappings', { provider, isActive, limit, offset }],
    queryFn: () => apiClient.get<SkuMappingsResponse>(`/sku-mappings?${searchParams.toString()}`),
  });
}
