import { useState } from 'react';
import { useSkuMappings } from '@/hooks/useSkuMappings';
import {
  useCreateSkuMapping,
  useUpdateSkuMapping,
  useToggleSkuMapping,
  useDeleteSkuMapping,
} from '@/hooks/useSkuMappingMutations';
import { MappingForm } from '@/components/sku-mappings/MappingForm';
import { Pagination } from '@/components/Pagination';
import type { SkuMapping } from '@/lib/types';
import { Plus, Pencil, Trash2 } from 'lucide-react';

const PAGE_SIZE = 25;

export function SkuMappings() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<SkuMapping | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const { data, isLoading } = useSkuMappings({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const createMutation = useCreateSkuMapping();
  const updateMutation = useUpdateSkuMapping();
  const toggleMutation = useToggleSkuMapping();
  const deleteMutation = useDeleteSkuMapping();

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">SKU Mappings</h1>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add Mapping
        </button>
      </div>

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Shopify SKU</th>
              <th className="text-left px-4 py-3 font-medium">Provider</th>
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

            {data?.mappings.map((mapping) => (
              <tr key={mapping.id} className="hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 font-mono text-xs">{mapping.shopifySku}</td>
                <td className="px-4 py-3 capitalize">{mapping.provider}</td>
                <td className="px-4 py-3 text-sm max-w-xs truncate">
                  {mapping.name ?? (
                    <span className="font-mono text-xs text-muted-foreground">{mapping.providerSku}</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() =>
                      toggleMutation.mutate({ id: mapping.id, isActive: !mapping.isActive })
                    }
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      mapping.isActive ? 'bg-green-500' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                        mapping.isActive ? 'translate-x-5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => openEdit(mapping)}
                      className="p-1 rounded hover:bg-muted transition-colors"
                      title="Edit"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setDeleteConfirm(mapping.id)}
                      className="p-1 rounded hover:bg-muted text-red-500 transition-colors"
                      title="Deactivate"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
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
        {data && (
          <div className="border-t px-4">
            <Pagination
              total={data.total}
              page={page}
              pageSize={PAGE_SIZE}
              onChange={setPage}
            />
          </div>
        )}
      </div>

      {/* Sheet (slide-in form) */}
      {sheetOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div
            className="flex-1 bg-black/40"
            onClick={() => setSheetOpen(false)}
          />
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
