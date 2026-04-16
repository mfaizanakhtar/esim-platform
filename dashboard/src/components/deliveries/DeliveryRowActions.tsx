import { RefreshCw, XCircle } from 'lucide-react';
import { useRetryDelivery, useCancelDelivery } from '@/hooks/useDeliveryMutations';
import type { DeliveryStatus } from '@/lib/types';

interface Props {
  id: string;
  status: DeliveryStatus;
}

export function DeliveryRowActions({ id, status }: Props) {
  const retryMutation = useRetryDelivery(id);
  const cancelMutation = useCancelDelivery(id);

  const canRetry = status !== 'delivered' && status !== 'cancelled';
  const canCancel = status !== 'cancelled';

  return (
    <div className="flex items-center gap-1">
      <button
        title="Retry"
        onClick={(e) => {
          e.preventDefault();
          retryMutation.mutate();
        }}
        disabled={!canRetry || retryMutation.isPending}
        className="p-1 rounded hover:bg-muted disabled:opacity-30 text-muted-foreground hover:text-foreground transition-colors"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${retryMutation.isPending ? 'animate-spin' : ''}`} />
      </button>
      <button
        title="Cancel"
        onClick={(e) => {
          e.preventDefault();
          if (window.confirm('Cancel this eSIM delivery? The eSIM will be cancelled with the vendor.')) {
            cancelMutation.mutate({ refund: false });
          }
        }}
        disabled={!canCancel || cancelMutation.isPending}
        className="p-1 rounded hover:bg-red-50 disabled:opacity-30 text-muted-foreground hover:text-red-600 transition-colors"
      >
        <XCircle className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
