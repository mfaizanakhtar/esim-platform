import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';

export interface ProductTemplateSummary {
  countryCode: string;
  title: string;
  handle: string;
  status: string;
  vendor: string;
  tags: string[];
  hasSeo: boolean;
  shopifyProductId: string | null;
  shopifyPushedAt: string | null;
  variantCount: number;
  updatedAt: string;
}

interface TemplateListResponse {
  total: number;
  templates: ProductTemplateSummary[];
}

interface GenerateInput {
  countries?: string[];
  overwrite?: boolean;
  dryRun?: boolean;
}

interface GenerateResult {
  ok: boolean;
  generated: number;
  skippedExisting: number;
  skippedInvalid: number;
  errors: string[];
}

interface GenerateSeoInput {
  countries?: string[];
  force?: boolean;
}

interface GenerateSeoResult {
  ok: boolean;
  queued: number;
  background?: string;
  message?: string;
}

interface PushInput {
  countries?: string[];
  force?: boolean;
  dryRun?: boolean;
}

interface PushResult {
  ok: boolean;
  total: number;
  background?: string;
  message?: string;
}

interface DeleteResult {
  ok: boolean;
  deleted: string;
}

export function useProductTemplates(params: { status?: string; pushed?: string } = {}) {
  const searchParams = new URLSearchParams();
  if (params.status) searchParams.set('status', params.status);
  if (params.pushed) searchParams.set('pushed', params.pushed);
  const qs = searchParams.toString();

  return useQuery({
    queryKey: ['product-templates', params],
    queryFn: () => apiClient.get<TemplateListResponse>(`/product-templates${qs ? `?${qs}` : ''}`),
  });
}

export function useGenerateTemplates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GenerateInput) =>
      apiClient.post<GenerateResult>('/product-templates/generate', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['product-templates'] });
    },
  });
}

function delayedRefetch(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['product-templates'] });
  // Background tasks finish after the HTTP response — refetch periodically to pick up changes
  setTimeout(() => void qc.invalidateQueries({ queryKey: ['product-templates'] }), 10_000);
  setTimeout(() => void qc.invalidateQueries({ queryKey: ['product-templates'] }), 30_000);
  setTimeout(() => void qc.invalidateQueries({ queryKey: ['product-templates'] }), 60_000);
}

export function useGenerateSeo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GenerateSeoInput) =>
      apiClient.post<GenerateSeoResult>('/product-templates/generate-seo', input),
    onSuccess: () => delayedRefetch(qc),
  });
}

export function usePushToShopify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PushInput) =>
      apiClient.post<PushResult>('/product-templates/push-to-shopify', input),
    onSuccess: () => delayedRefetch(qc),
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (countryCode: string) =>
      apiClient.delete<DeleteResult>(`/product-templates/${countryCode}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['product-templates'] });
    },
  });
}
