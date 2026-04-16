import { useQueryClient } from '@tanstack/react-query';
import { X, RefreshCw, XCircle } from 'lucide-react';
import { apiClient } from '@/lib/api';
import type { Delivery } from '@/lib/types';

interface Props {
  selectedIds: string[];
  selectedDeliveries: Delivery[];
  onClear: () => void;
}

export function BulkActionBar({ selectedIds, selectedDeliveries, onClear }: Props) {
  const qc = useQueryClient();
  const visible = selectedIds.length > 0;

  const retryableIds = selectedDeliveries
    .filter((d) => d.status !== 'delivered' && d.status !== 'cancelled')
    .map((d) => d.id);

  const cancellableIds = selectedDeliveries
    .filter((d) => d.status !== 'cancelled')
    .map((d) => d.id);

  async function handleBulkRetry() {
    await Promise.allSettled(retryableIds.map((id) => apiClient.post(`/deliveries/${id}/retry`)));
    void qc.invalidateQueries({ queryKey: ['deliveries'] });
    onClear();
  }

  async function handleBulkCancel() {
    if (!window.confirm(`Cancel ${cancellableIds.length} delivery(ies)? No refunds will be issued.`)) return;
    await Promise.allSettled(
      cancellableIds.map((id) => apiClient.post(`/deliveries/${id}/cancel`, { refund: false })),
    );
    void qc.invalidateQueries({ queryKey: ['deliveries'] });
    onClear();
  }

  return (
    <div
      className={`fixed bottom-0 left-0 right-0 z-30 flex items-center gap-3 px-6 py-3 bg-gray-900 text-white text-sm shadow-lg transition-transform duration-200 ${
        visible ? 'translate-y-0' : 'translate-y-full'
      }`}
    >
      <span className="font-medium">{selectedIds.length} selected</span>
      <button
        onClick={onClear}
        className="flex items-center gap-1 px-2.5 py-1 rounded border border-white/30 hover:bg-white/10 transition-colors text-xs"
      >
        <X className="h-3.5 w-3.5" />
        Clear
      </button>
      {retryableIds.length > 0 && (
        <button
          onClick={() => void handleBulkRetry()}
          className="flex items-center gap-1 px-2.5 py-1 rounded border border-white/30 hover:bg-white/10 transition-colors text-xs"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry ({retryableIds.length})
        </button>
      )}
      {cancellableIds.length > 0 && (
        <button
          onClick={() => void handleBulkCancel()}
          className="flex items-center gap-1 px-2.5 py-1 rounded bg-red-600 hover:bg-red-700 transition-colors text-xs"
        >
          <XCircle className="h-3.5 w-3.5" />
          Cancel ({cancellableIds.length})
        </button>
      )}
    </div>
  );
}
