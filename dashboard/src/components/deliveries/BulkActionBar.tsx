import { useState } from 'react';
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
  const [isPending, setIsPending] = useState(false);
  const visible = selectedIds.length > 0;

  const retryableIds = selectedDeliveries
    .filter((d) => d.status !== 'delivered' && d.status !== 'cancelled')
    .map((d) => d.id);

  const cancellableIds = selectedDeliveries
    .filter((d) => d.status !== 'cancelled')
    .map((d) => d.id);

  async function handleBulkRetry() {
    setIsPending(true);
    try {
      const results = await Promise.allSettled(
        retryableIds.map((id) => apiClient.post(`/deliveries/${id}/retry`)),
      );
      void qc.invalidateQueries({ queryKey: ['deliveries'] });
      retryableIds.forEach((id) => void qc.invalidateQueries({ queryKey: ['delivery', id] }));
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) window.alert(`${failed} retry request(s) failed.`);
      onClear();
    } finally {
      setIsPending(false);
    }
  }

  async function handleBulkCancel() {
    if (!window.confirm(`Cancel ${cancellableIds.length} delivery(ies)? No refunds will be issued.`)) return;
    setIsPending(true);
    try {
      const results = await Promise.allSettled(
        cancellableIds.map((id) => apiClient.post(`/deliveries/${id}/cancel`, { refund: false })),
      );
      void qc.invalidateQueries({ queryKey: ['deliveries'] });
      cancellableIds.forEach((id) => void qc.invalidateQueries({ queryKey: ['delivery', id] }));
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) window.alert(`${failed} cancel request(s) failed.`);
      onClear();
    } finally {
      setIsPending(false);
    }
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
        disabled={isPending}
        className="flex items-center gap-1 px-2.5 py-1 rounded border border-white/30 hover:bg-white/10 disabled:opacity-50 transition-colors text-xs"
      >
        <X className="h-3.5 w-3.5" />
        Clear
      </button>
      {retryableIds.length > 0 && (
        <button
          onClick={() => void handleBulkRetry()}
          disabled={isPending}
          className="flex items-center gap-1 px-2.5 py-1 rounded border border-white/30 hover:bg-white/10 disabled:opacity-50 transition-colors text-xs"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isPending ? 'animate-spin' : ''}`} />
          Retry ({retryableIds.length})
        </button>
      )}
      {cancellableIds.length > 0 && (
        <button
          onClick={() => void handleBulkCancel()}
          disabled={isPending}
          className="flex items-center gap-1 px-2.5 py-1 rounded bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors text-xs"
        >
          <XCircle className="h-3.5 w-3.5" />
          Cancel ({cancellableIds.length})
        </button>
      )}
    </div>
  );
}
