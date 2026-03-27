import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import type { SkuMapping, SkuMappingsPage, SkuMappingProvider, SkuMappingPackageType } from '@/lib/types';

interface CreateSkuMappingInput {
  shopifySku: string;
  provider: SkuMappingProvider;
  providerCatalogId?: string;
  providerSku?: string;
  name?: string;
  region?: string;
  dataAmount?: string;
  validity?: string;
  packageType?: SkuMappingPackageType;
  daysCount?: number;
  providerConfig?: Record<string, unknown>;
  isActive?: boolean;
  priority?: number;
  priorityLocked?: boolean;
  mappingLocked?: boolean;
}

interface UpdateSkuMappingInput extends Partial<CreateSkuMappingInput> {
  id: string;
}

export function useCreateSkuMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateSkuMappingInput) =>
      apiClient.post<SkuMapping>('/sku-mappings', data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sku-mappings'] });
    },
  });
}

export function useUpdateSkuMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: UpdateSkuMappingInput) =>
      apiClient.put<SkuMapping>(`/sku-mappings/${id}`, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sku-mappings'] });
    },
  });
}

export function useToggleSkuMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiClient.put<SkuMapping>(`/sku-mappings/${id}`, { isActive }),
    onMutate: async ({ id, isActive }) => {
      await qc.cancelQueries({ queryKey: ['sku-mappings'] });
      const prevData = qc.getQueriesData({ queryKey: ['sku-mappings'] });
      qc.setQueriesData({ queryKey: ['sku-mappings'] }, (old: unknown) => {
        if (!old || typeof old !== 'object') return old;
        const data = old as SkuMappingsPage<SkuMapping>;
        return {
          ...data,
          mappings: data.mappings.map((m) => (m.id === id ? { ...m, isActive } : m)),
        };
      });
      return { prevData };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prevData) {
        ctx.prevData.forEach(([queryKey, data]) => {
          qc.setQueryData(queryKey, data);
        });
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['sku-mappings'] });
    },
  });
}

export function useDeleteSkuMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete<{ ok: boolean }>(`/sku-mappings/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sku-mappings'] });
    },
  });
}

export function useReorderMappings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ shopifySku, orderedIds }: { shopifySku: string; orderedIds: string[] }) =>
      apiClient.put<{ ok: boolean }>('/sku-mappings/reorder', { shopifySku, orderedIds }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sku-mappings'] });
    },
  });
}

export function useSmartPricing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shopifySku?: string) =>
      apiClient.post<{ updated: number; skipped: number; changes: unknown[] }>(
        '/sku-mappings/smart-pricing',
        shopifySku ? { shopifySku } : {},
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sku-mappings'] });
    },
  });
}

export function useBulkCreateMappings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (inputs: CreateSkuMappingInput[]) => {
      const results: SkuMapping[] = [];
      for (const input of inputs) {
        const result = await apiClient.post<SkuMapping>('/sku-mappings', input);
        results.push(result);
      }
      return results;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sku-mappings'] });
    },
  });
}
