import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAllSkuMappings, useShopifySkus } from '@/hooks/useSkuMappings';
import {
  useCreateSkuMapping,
  useUpdateSkuMapping,
  useToggleSkuMapping,
  useDeleteSkuMapping,
  useSmartPricing,
  useReorderMappings,
} from '@/hooks/useSkuMappingMutations';
import { MappingForm } from '@/components/sku-mappings/MappingForm';
import { SkuMappingModal } from '@/components/sku-mappings/SkuMappingModal';
import type { SkuMapping, ShopifySku } from '@/lib/types';
import { parseShopifySku } from '@/utils/parseShopifySku';
import { Plus, Pencil, Trash2, Sparkles, Brain, ChevronUp, ChevronDown } from 'lucide-react';
import { useProviders, providerLabel } from '@/hooks/useProviders';
import { useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';

type TabFilter = 'all' | 'mapped' | 'unmapped';

const PAGE_SIZE = 25;
const EMPTY_MAPPINGS: SkuMapping[] = [];

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

interface SkuRow {
  shopifySku: ShopifySku;
  parsed: ReturnType<typeof parseShopifySku>;
  mappings: SkuMapping[];
}

export function SkuMappings() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<SkuMapping | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [modalSku, setModalSku] = useState<ShopifySku | null>(null);
  const [shopifyDeleteConfirm, setShopifyDeleteConfirm] = useState<ShopifySku | null>(null);
  const [shopifyDeleteLoading, setShopifyDeleteLoading] = useState(false);
  const [shopifyDeleteError, setShopifyDeleteError] = useState<string | null>(null);
  const [smartPricingResult, setSmartPricingResult] = useState<{
    updated: number;
    skipped: number;
  } | null>(null);
  const urlSearch = searchParams.get('search') ?? '';
  const [search, setSearch] = useState(urlSearch);
  const debouncedSearch = useDebounce(search, 300);
  const isInitialMount = useRef(true);

  const { data: providersData } = useProviders();
  const providers = providersData?.providers ?? [];

  const providerParam = searchParams.get('provider');
  const provider = !providersData
    ? (providerParam ?? '')
    : providers.includes(providerParam ?? '')
      ? (providerParam ?? '')
      : '';

  const tabParam = searchParams.get('tab') as TabFilter | null;
  const tab: TabFilter = tabParam === 'mapped' || tabParam === 'unmapped' ? tabParam : 'all';

  const pageParam = parseInt(searchParams.get('page') ?? '1', 10);
  const page = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;

  useEffect(() => {
    setSearch(urlSearch);
  }, [urlSearch]);

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (debouncedSearch) next.set('search', debouncedSearch);
      else next.delete('search');
      next.delete('page');
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  const setFilter = useCallback(
    (key: string, value: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        next.delete('page');
        return next;
      });
    },
    [setSearchParams],
  );

  const setPage = useCallback(
    (p: number) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (p <= 1) next.delete('page');
        else next.set('page', String(p));
        return next;
      });
    },
    [setSearchParams],
  );

  const { data: shopifySkusData, isFetching: skusFetching } = useShopifySkus({
    page,
    pageSize: PAGE_SIZE,
    search: debouncedSearch || undefined,
    status: tab,
    provider: provider || undefined,
  });
  const { data: mappingsData, isFetching: mappingsFetching } = useAllSkuMappings({
    provider: provider || undefined,
  });

  const isFetching = skusFetching || mappingsFetching;
  const total = shopifySkusData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);

  // Build mapping lookup for chip display (all mappings from DB)
  const mappingsBySku = useMemo(() => {
    const map = new Map<string, SkuMapping[]>();
    for (const m of mappingsData?.mappings ?? []) {
      const arr = map.get(m.shopifySku) ?? [];
      arr.push(m);
      map.set(m.shopifySku, arr);
    }
    return map;
  }, [mappingsData]);

  // Current page rows (server already filtered + paginated)
  const skuRows = useMemo<SkuRow[]>(
    () =>
      (shopifySkusData?.skus ?? []).map((s) => ({
        shopifySku: s,
        parsed: parseShopifySku(s.sku),
        mappings: (mappingsBySku.get(s.sku) ?? EMPTY_MAPPINGS).sort(
          (a, b) => a.priority - b.priority,
        ),
      })),
    [shopifySkusData, mappingsBySku],
  );

  const createMutation = useCreateSkuMapping();
  const updateMutation = useUpdateSkuMapping();
  const toggleMutation = useToggleSkuMapping();
  const deleteMutation = useDeleteSkuMapping();
  const smartPricingMutation = useSmartPricing();
  const reorderMutation = useReorderMappings();

  function moveMapping(shopifySku: string, mappings: SkuMapping[], fromIdx: number, toIdx: number) {
    const reordered = [...mappings];
    [reordered[fromIdx], reordered[toIdx]] = [reordered[toIdx], reordered[fromIdx]];
    reorderMutation.mutate({ shopifySku, orderedIds: reordered.map((m) => m.id) });
  }

  function openEdit(mapping: SkuMapping) {
    setEditing(mapping);
    setSheetOpen(true);
  }

  function handleSubmit(values: Parameters<typeof createMutation.mutate>[0]) {
    if (editing) {
      updateMutation.mutate(
        { id: editing.id, ...values },
        { onSuccess: () => setSheetOpen(false) },
      );
    } else {
      createMutation.mutate(values, { onSuccess: () => setSheetOpen(false) });
    }
  }

  function handleDelete(id: string) {
    deleteMutation.mutate(id, { onSuccess: () => setDeleteConfirm(null) });
  }

  async function handleShopifyDelete() {
    if (!shopifyDeleteConfirm) return;
    setShopifyDeleteLoading(true);
    setShopifyDeleteError(null);
    try {
      await apiClient.post('/shopify-skus/bulk-delete', { skus: [shopifyDeleteConfirm.sku] });
      void queryClient.invalidateQueries({ queryKey: ['shopify-skus'] });
      setShopifyDeleteConfirm(null);
    } catch (err) {
      setShopifyDeleteError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setShopifyDeleteLoading(false);
    }
  }

  function handleSmartPricing() {
    setSmartPricingResult(null);
    smartPricingMutation.mutate(undefined, {
      onSuccess: (result) =>
        setSmartPricingResult({ updated: result.updated, skipped: result.skipped }),
    });
  }


  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:flex-wrap">
        <h1 className="text-2xl font-bold">SKU Mappings</h1>
        <div className="flex items-center gap-2 flex-wrap sm:ml-auto">
          <select
            aria-label="Filter by provider"
            value={provider}
            onChange={(e) => setFilter('provider', e.target.value)}
            className="border rounded-md px-3 py-1.5 text-sm"
          >
            <option value="">All Providers</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {providerLabel(p)}
              </option>
            ))}
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by SKU or product..."
            className="border rounded-md px-3 py-1.5 text-sm w-40 sm:w-56"
          />
          <button
            onClick={handleSmartPricing}
            disabled={smartPricingMutation.isPending}
            className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md hover:bg-muted transition-colors disabled:opacity-50"
            title="Reorder priorities by cheapest price"
          >
            <Sparkles className="h-4 w-4" />
            {smartPricingMutation.isPending ? 'Running...' : 'Smart Pricing'}
          </button>
          <button
            onClick={() => navigate('/sku-mappings/ai-map')}
            className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md hover:bg-muted transition-colors"
          >
            <Brain className="h-4 w-4" />
            Auto-Map
          </button>
          <button
            onClick={() => {
              setEditing(null);
              setSheetOpen(true);
            }}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Add Mapping
          </button>
        </div>
      </div>

      {smartPricingResult && (
        <div className="flex items-center justify-between px-4 py-2 bg-green-50 border border-green-200 rounded-md text-sm text-green-800">
          <span>
            Smart pricing complete: {smartPricingResult.updated} updated,{' '}
            {smartPricingResult.skipped} skipped.
          </span>
          <button
            onClick={() => setSmartPricingResult(null)}
            className="text-green-600 hover:text-green-800"
          >
            &times;
          </button>
        </div>
      )}

      {smartPricingMutation.isError && (
        <div className="px-4 py-2 bg-red-50 border border-red-200 rounded-md text-sm text-red-800">
          Smart pricing failed:{' '}
          {smartPricingMutation.error instanceof Error
            ? smartPricingMutation.error.message
            : 'Unknown error'}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-1 border-b">
        {(['all', 'mapped', 'unmapped'] as TabFilter[]).map((t) => (
          <button
            key={t}
            onClick={() => setFilter('tab', t === 'all' ? '' : t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize ${
              tab === t
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="border rounded-lg overflow-x-auto relative">
        {isFetching && (
          <div className="absolute top-0 left-0 right-0 h-0.5 overflow-hidden z-10 bg-gray-200">
            <div className="h-full w-1/3 bg-gray-900" style={{ animation: 'slideProgress 1.2s ease-in-out infinite' }} />
          </div>
        )}
        <table className="w-full text-sm min-w-[600px]">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Shopify SKU</th>
              <th className="text-left px-4 py-3 font-medium">Parsed</th>
              <th className="text-left px-4 py-3 font-medium">Mappings</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isFetching &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 5 }).map((__, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 bg-muted animate-pulse rounded" />
                    </td>
                  ))}
                </tr>
              ))}

            {!isFetching && skuRows.map((row) => (
              <tr key={row.shopifySku.sku} className="hover:bg-muted/20 transition-colors">
                {/* SKU */}
                <td className="px-4 py-3">
                  <p className="font-mono text-xs font-semibold">{row.shopifySku.sku}</p>
                  {row.shopifySku.productTitle && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {row.shopifySku.productTitle}
                      {row.shopifySku.variantTitle && ` · ${row.shopifySku.variantTitle}`}
                    </p>
                  )}
                </td>

                {/* Parsed */}
                <td className="px-4 py-3">
                  {row.parsed ? (
                    <div className="text-xs space-y-0.5">
                      <span className="inline-block px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded text-xs font-medium">
                        {row.parsed.regionCode}
                      </span>
                      <p className="text-muted-foreground">
                        {row.parsed.dataMb >= 1024
                          ? `${row.parsed.dataMb / 1024}GB`
                          : `${row.parsed.dataMb}MB`}{' '}
                        · {row.parsed.validityDays}D
                      </p>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>

                {/* Mappings */}
                <td className="px-4 py-3">
                  {row.mappings.length === 0 ? (
                    <span className="inline-block px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full text-xs">
                      Unmapped
                    </span>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {row.mappings.map((m, idx) => {
                        const prev = row.mappings[idx - 1];
                        const next = row.mappings[idx + 1];
                        const canMoveUp =
                          idx > 0 &&
                          !m.priorityLocked && !m.mappingLocked &&
                          !prev.priorityLocked && !prev.mappingLocked &&
                          !reorderMutation.isPending;
                        const canMoveDown =
                          idx < row.mappings.length - 1 &&
                          !m.priorityLocked && !m.mappingLocked &&
                          !next.priorityLocked && !next.mappingLocked &&
                          !reorderMutation.isPending;
                        return (
                        <div key={m.id} className="flex items-center gap-1">
                          {/* Priority up/down */}
                          <div className="flex flex-col">
                            <button
                              onClick={() => moveMapping(row.shopifySku.sku, row.mappings, idx, idx - 1)}
                              disabled={!canMoveUp}
                              className="p-0.5 rounded hover:bg-muted transition-colors disabled:opacity-30"
                              title="Higher priority"
                            >
                              <ChevronUp className="h-3 w-3" />
                            </button>
                            <button
                              onClick={() => moveMapping(row.shopifySku.sku, row.mappings, idx, idx + 1)}
                              disabled={!canMoveDown}
                              className="p-0.5 rounded hover:bg-muted transition-colors disabled:opacity-30"
                              title="Lower priority"
                            >
                              <ChevronDown className="h-3 w-3" />
                            </button>
                          </div>
                          <span className="inline-block px-2 py-0.5 bg-muted border rounded-full text-xs capitalize">
                            {m.provider}
                          </span>
                          <button
                            onClick={() => openEdit(m)}
                            disabled={m.mappingLocked}
                            className="p-0.5 rounded hover:bg-muted transition-colors disabled:opacity-40"
                            title={m.mappingLocked ? 'Unlock mapping to edit' : 'Edit mapping'}
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => toggleMutation.mutate({ id: m.id, isActive: !m.isActive })}
                            disabled={m.mappingLocked}
                            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                              m.isActive ? 'bg-green-500' : 'bg-gray-300'
                            } ${m.mappingLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                            title={m.isActive ? 'Active' : 'Inactive'}
                          >
                            <span
                              className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white transition-transform ${
                                m.isActive ? 'translate-x-3.5' : 'translate-x-0.5'
                              }`}
                            />
                          </button>
                          <button
                            onClick={() => setDeleteConfirm(m.id)}
                            disabled={m.mappingLocked}
                            className="p-0.5 rounded hover:bg-muted text-red-500 transition-colors disabled:opacity-40"
                            title={m.mappingLocked ? 'Unlock mapping to deactivate' : 'Deactivate'}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                        );
                      })}
                    </div>
                  )}
                </td>

                {/* Status */}
                <td className="px-4 py-3">
                  {row.mappings.length > 0 ? (
                    <span className="inline-block px-2 py-0.5 bg-green-100 text-green-800 rounded-full text-xs font-medium">
                      Mapped
                    </span>
                  ) : (
                    <span className="inline-block px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full text-xs font-medium">
                      Unmapped
                    </span>
                  )}
                </td>

                {/* Actions */}
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setModalSku(row.shopifySku)}
                      className="px-2 py-1 text-xs border rounded-md hover:bg-muted transition-colors"
                    >
                      Map
                    </button>
                    <button
                      onClick={() => {
                        setShopifyDeleteError(null);
                        setShopifyDeleteConfirm(row.shopifySku);
                      }}
                      className="p-1 rounded hover:bg-red-50 text-red-500 transition-colors"
                      title="Delete from Shopify"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}

            {!isFetching && skuRows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  {debouncedSearch || provider
                    ? tab === 'unmapped'
                      ? 'No unmapped SKUs match the current filter.'
                      : tab === 'mapped'
                        ? 'No mapped SKUs match the current filter.'
                        : 'No SKUs match the current filter.'
                    : tab === 'unmapped'
                      ? 'All SKUs are mapped!'
                      : tab === 'mapped'
                        ? 'No mapped SKUs yet.'
                        : 'No Shopify SKUs found. Make sure Shopify is connected.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Showing {(clampedPage - 1) * PAGE_SIZE + 1}–{Math.min(clampedPage * PAGE_SIZE, total)}{' '}
            of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(clampedPage - 1)}
              disabled={clampedPage <= 1}
              className="px-3 py-1.5 border rounded-md hover:bg-muted transition-colors disabled:opacity-40"
            >
              ← Prev
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === totalPages || Math.abs(p - clampedPage) <= 2)
              .reduce<(number | '…')[]>((acc, p, idx, arr) => {
                if (idx > 0 && p - (arr[idx - 1] as number) > 1) acc.push('…');
                acc.push(p);
                return acc;
              }, [])
              .map((p, i) =>
                p === '…' ? (
                  <span key={`ellipsis-${i}`} className="px-2">
                    …
                  </span>
                ) : (
                  <button
                    key={p}
                    onClick={() => setPage(p as number)}
                    className={`px-3 py-1.5 border rounded-md transition-colors ${
                      p === clampedPage
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'hover:bg-muted'
                    }`}
                  >
                    {p}
                  </button>
                ),
              )}
            <button
              onClick={() => setPage(clampedPage + 1)}
              disabled={clampedPage >= totalPages}
              className="px-3 py-1.5 border rounded-md hover:bg-muted transition-colors disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* Per-SKU mapping modal */}
      {modalSku && (
        <SkuMappingModal
          sku={modalSku}
          existingMappings={mappingsBySku.get(modalSku.sku) ?? EMPTY_MAPPINGS}
          onClose={() => setModalSku(null)}
          onSaved={() => {
            setModalSku(null);
            void queryClient.invalidateQueries({ queryKey: ['sku-mappings'] });
          }}
        />
      )}

      {/* Sheet (slide-in form for editing existing mappings) */}
      {sheetOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/40" onClick={() => setSheetOpen(false)} />
          <div className="w-full max-w-md bg-white shadow-xl p-6 overflow-y-auto">
            <h2 className="text-lg font-semibold mb-4">
              {editing ? 'Edit Mapping' : 'Create Mapping'}
            </h2>
            <MappingForm
              initial={editing ?? undefined}
              existingMappings={
                editing
                  ? (mappingsData?.mappings ?? []).filter(
                      (m) => m.shopifySku === editing.shopifySku && m.id !== editing.id,
                    )
                  : undefined
              }
              onSubmit={handleSubmit}
              onCancel={() => setSheetOpen(false)}
              isPending={createMutation.isPending || updateMutation.isPending}
            />
          </div>
        </div>
      )}

      {/* Delete confirm dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setDeleteConfirm(null)}
          />
          <div className="relative bg-white rounded-lg shadow-xl p-6 w-full max-w-sm space-y-4">
            <h2 className="text-lg font-semibold">Deactivate Mapping?</h2>
            <p className="text-sm text-muted-foreground">
              This will set the mapping to inactive. It can be re-activated at any time.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm border rounded-md hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                disabled={deleteMutation.isPending}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {deleteMutation.isPending ? 'Deactivating...' : 'Deactivate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete from Shopify confirm dialog */}
      {shopifyDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => !shopifyDeleteLoading && setShopifyDeleteConfirm(null)}
          />
          <div className="relative bg-white rounded-lg shadow-xl p-6 w-full max-w-sm space-y-4">
            <h2 className="text-lg font-semibold">Delete from Shopify?</h2>
            <p className="text-sm text-muted-foreground">
              This will permanently delete{' '}
              <span className="font-mono font-medium">{shopifyDeleteConfirm.sku}</span> from your
              Shopify store. This cannot be undone.
            </p>
            {shopifyDeleteError && (
              <p className="text-sm text-red-600">{shopifyDeleteError}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShopifyDeleteConfirm(null)}
                disabled={shopifyDeleteLoading}
                className="px-4 py-2 text-sm border rounded-md hover:bg-muted transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleShopifyDelete()}
                disabled={shopifyDeleteLoading}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {shopifyDeleteLoading ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
