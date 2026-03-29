import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useSkuMappings } from '@/hooks/useSkuMappings';
import {
  useCreateSkuMapping,
  useUpdateSkuMapping,
  useToggleSkuMapping,
  useDeleteSkuMapping,
  useReorderMappings,
  useSmartPricing,
} from '@/hooks/useSkuMappingMutations';
import { MappingForm } from '@/components/sku-mappings/MappingForm';
import type { SkuMapping } from '@/lib/types';
import {
  Plus,
  Pencil,
  Trash2,
  ChevronUp,
  ChevronDown,
  Lock,
  Unlock,
  Sparkles,
  Brain,
} from 'lucide-react';
import { useProviders, providerLabel } from '@/hooks/useProviders';

const PAGE_SIZE = 500; // load all — grouped display doesn't use pagination

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/** Group and sort mappings by shopifySku then by priority */
function groupBySku(mappings: SkuMapping[]): Map<string, SkuMapping[]> {
  const map = new Map<string, SkuMapping[]>();
  for (const m of mappings) {
    const group = map.get(m.shopifySku) ?? [];
    group.push(m);
    map.set(m.shopifySku, group);
  }
  // Sort each group by priority
  for (const [key, group] of map) {
    map.set(
      key,
      group.slice().sort((a, b) => a.priority - b.priority),
    );
  }
  return map;
}

export function SkuMappings() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<SkuMapping | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
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
  const provider = providers.includes(providerParam ?? '') ? (providerParam ?? '') : '';

  const statusParam = searchParams.get('status');
  const status: '' | 'active' | 'inactive' =
    statusParam === 'active' || statusParam === 'inactive' ? statusParam : '';

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
        return next;
      });
    },
    [setSearchParams],
  );

  const { data, isLoading } = useSkuMappings({
    limit: PAGE_SIZE,
    offset: 0,
    provider: provider || undefined,
    isActive: status === 'active' ? true : status === 'inactive' ? false : undefined,
    search: debouncedSearch || undefined,
  });

  const grouped = data ? groupBySku(data.mappings) : new Map<string, SkuMapping[]>();

  const createMutation = useCreateSkuMapping();
  const updateMutation = useUpdateSkuMapping();
  const toggleMutation = useToggleSkuMapping();
  const deleteMutation = useDeleteSkuMapping();
  const reorderMutation = useReorderMappings();
  const smartPricingMutation = useSmartPricing();

  function openCreate() {
    setEditing(null);
    setSheetOpen(true);
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

  function moveUp(sku: string, index: number) {
    const group = grouped.get(sku);
    if (!group || index === 0) return;
    const reordered = [...group];
    [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
    reorderMutation.mutate({ shopifySku: sku, orderedIds: reordered.map((m) => m.id) });
  }

  function moveDown(sku: string, index: number) {
    const group = grouped.get(sku);
    if (!group || index === group.length - 1) return;
    const reordered = [...group];
    [reordered[index], reordered[index + 1]] = [reordered[index + 1], reordered[index]];
    reorderMutation.mutate({ shopifySku: sku, orderedIds: reordered.map((m) => m.id) });
  }

  function togglePriorityLock(mapping: SkuMapping) {
    updateMutation.mutate({ id: mapping.id, priorityLocked: !mapping.priorityLocked });
  }

  function toggleMappingLock(mapping: SkuMapping) {
    updateMutation.mutate({ id: mapping.id, mappingLocked: !mapping.mappingLocked });
  }

  function handleSmartPricing() {
    setSmartPricingResult(null);
    smartPricingMutation.mutate(undefined, {
      onSuccess: (result) => setSmartPricingResult({ updated: result.updated, skipped: result.skipped }),
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">SKU Mappings</h1>
        <div className="flex items-center gap-3 ml-auto flex-wrap">
          <select
            aria-label="Filter by provider"
            value={provider}
            onChange={(e) => setFilter('provider', e.target.value)}
            className="border rounded-md px-3 py-1.5 text-sm"
          >
            <option value="">All Providers</option>
            {providers.map((p) => (
              <option key={p} value={p}>{providerLabel(p)}</option>
            ))}
          </select>
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setFilter('status', e.target.value)}
            className="border rounded-md px-3 py-1.5 text-sm"
          >
            <option value="">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by SKU or name..."
            className="border rounded-md px-3 py-1.5 text-sm w-56"
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
            AI Auto-Map
          </button>
          <button
            onClick={openCreate}
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
            Smart pricing complete: {smartPricingResult.updated} updated, {smartPricingResult.skipped} skipped.
          </span>
          <button onClick={() => setSmartPricingResult(null)} className="text-green-600 hover:text-green-800">
            &times;
          </button>
        </div>
      )}

      {smartPricingMutation.isError && (
        <div className="px-4 py-2 bg-red-50 border border-red-200 rounded-md text-sm text-red-800">
          Smart pricing failed: {smartPricingMutation.error instanceof Error ? smartPricingMutation.error.message : 'Unknown error'}
        </div>
      )}

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-4 py-3 font-medium w-8">Pri</th>
              <th className="text-left px-4 py-3 font-medium">Shopify SKU / Provider</th>
              <th className="text-left px-4 py-3 font-medium">Product</th>
              <th className="text-left px-4 py-3 font-medium">Active</th>
              <th className="text-left px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 5 }).map((__, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 bg-muted animate-pulse rounded" />
                    </td>
                  ))}
                </tr>
              ))}

            {Array.from(grouped.entries()).map(([sku, group]) => (
              <Fragment key={sku}>
                {/* SKU group header */}
                <tr className="bg-muted/30">
                  <td colSpan={5} className="px-4 py-2">
                    <span className="font-mono text-xs font-semibold text-foreground">{sku}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {group.length} provider{group.length !== 1 ? 's' : ''}
                    </span>
                  </td>
                </tr>

                {/* Provider rows */}
                {group.map((mapping, idx) => (
                  <tr key={mapping.id} className="hover:bg-muted/20 transition-colors">
                    {/* Priority number + up/down */}
                    <td className="px-4 py-2">
                      <div className="flex flex-col items-center gap-0.5">
                        <button
                          onClick={() => moveUp(sku, idx)}
                          disabled={idx === 0 || reorderMutation.isPending}
                          className="p-0.5 rounded hover:bg-muted disabled:opacity-20 transition-colors"
                          title="Move up (higher priority)"
                        >
                          <ChevronUp className="h-3 w-3" />
                        </button>
                        <span className="text-xs text-muted-foreground tabular-nums">{mapping.priority}</span>
                        <button
                          onClick={() => moveDown(sku, idx)}
                          disabled={idx === group.length - 1 || reorderMutation.isPending}
                          className="p-0.5 rounded hover:bg-muted disabled:opacity-20 transition-colors"
                          title="Move down (lower priority)"
                        >
                          <ChevronDown className="h-3 w-3" />
                        </button>
                      </div>
                    </td>

                    {/* Provider name (indented under SKU) */}
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2 pl-4">
                        <span className="capitalize text-sm">{mapping.provider}</span>
                        {mapping.priorityLocked && (
                          <Lock className="h-3 w-3 text-amber-500" aria-label="Priority locked" />
                        )}
                      </div>
                    </td>

                    <td className="px-4 py-2 text-sm max-w-xs truncate">
                      {mapping.name ?? (
                        <span className="font-mono text-xs text-muted-foreground">
                          {mapping.providerSku}
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-2">
                      <button
                        onClick={() =>
                          toggleMutation.mutate({ id: mapping.id, isActive: !mapping.isActive })
                        }
                        disabled={mapping.mappingLocked}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                          mapping.isActive ? 'bg-green-500' : 'bg-gray-300'
                        } ${mapping.mappingLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                        title={mapping.mappingLocked ? 'Mapping is locked' : undefined}
                      >
                        <span
                          className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                            mapping.isActive ? 'translate-x-5' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </td>

                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1">
                        {/* Priority lock toggle — always available */}
                        <button
                          onClick={() => togglePriorityLock(mapping)}
                          className={`p-1 rounded hover:bg-muted transition-colors ${
                            mapping.priorityLocked ? 'text-amber-500' : 'text-muted-foreground'
                          }`}
                          title={mapping.priorityLocked ? 'Unlock priority' : 'Lock priority'}
                        >
                          {mapping.priorityLocked ? (
                            <Lock className="h-4 w-4" />
                          ) : (
                            <Unlock className="h-4 w-4" />
                          )}
                        </button>

                        {/* Mapping lock toggle — always available (only way to unlock) */}
                        <button
                          onClick={() => toggleMappingLock(mapping)}
                          className={`p-1 rounded hover:bg-muted transition-colors ${
                            mapping.mappingLocked ? 'text-red-500' : 'text-muted-foreground'
                          }`}
                          title={mapping.mappingLocked ? 'Unlock mapping (allow edits)' : 'Lock mapping (prevent edits)'}
                        >
                          {mapping.mappingLocked ? (
                            <Lock className="h-4 w-4" />
                          ) : (
                            <Unlock className="h-4 w-4" />
                          )}
                        </button>

                        <button
                          onClick={() => openEdit(mapping)}
                          disabled={mapping.mappingLocked}
                          className={`p-1 rounded hover:bg-muted transition-colors ${
                            mapping.mappingLocked ? 'opacity-40 cursor-not-allowed' : ''
                          }`}
                          title={mapping.mappingLocked ? 'Unlock mapping to edit' : 'Edit'}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>

                        <button
                          onClick={() => setDeleteConfirm(mapping.id)}
                          disabled={mapping.mappingLocked}
                          className={`p-1 rounded hover:bg-muted text-red-500 transition-colors ${
                            mapping.mappingLocked ? 'opacity-40 cursor-not-allowed' : ''
                          }`}
                          title={mapping.mappingLocked ? 'Unlock mapping to deactivate' : 'Deactivate'}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}

            {data?.mappings.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  No SKU mappings found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Sheet (slide-in form) */}
      {sheetOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/40" onClick={() => setSheetOpen(false)} />
          <div className="w-full max-w-md bg-white shadow-xl p-6 overflow-y-auto">
            <h2 className="text-lg font-semibold mb-4">
              {editing ? 'Edit Mapping' : 'Create Mapping'}
            </h2>
            <MappingForm
              initial={editing ?? undefined}
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
          <div className="absolute inset-0 bg-black/40" onClick={() => setDeleteConfirm(null)} />
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
    </div>
  );
}
