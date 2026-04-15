import { useParams, Link } from 'react-router-dom';
import { useDelivery } from '@/hooks/useDelivery';
import { useRetryDelivery, useResendEmail, useCancelDelivery } from '@/hooks/useDeliveryMutations';
import { StatusBadge } from '@/components/deliveries/StatusBadge';
import { EsimPayloadCard } from '@/components/deliveries/EsimPayloadCard';
import { formatDistanceToNow, format } from 'date-fns';
import { ArrowLeft, RefreshCw, Mail, XCircle } from 'lucide-react';

export function DeliveryDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: delivery, isLoading, isError } = useDelivery(id ?? '');
  const retryMutation = useRetryDelivery(id ?? '');
  const resendMutation = useResendEmail(id ?? '');
  const cancelMutation = useCancelDelivery(id ?? '');

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 bg-muted animate-pulse rounded w-48" />
        <div className="h-32 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  if (isError || !delivery) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        Delivery not found or failed to load.
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Link
          to="/deliveries"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        <h1 className="text-2xl font-bold">{delivery.orderName}</h1>
        <StatusBadge status={delivery.status} />
      </div>

      {/* Meta info */}
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-muted-foreground">Customer</p>
          <p className="font-medium">{delivery.customerEmail ?? '—'}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Created</p>
          <p className="font-medium">{format(new Date(delivery.createdAt), 'PPpp')}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Order ID</p>
          <p className="font-mono text-xs">{delivery.orderId}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Variant ID</p>
          <p className="font-mono text-xs">{delivery.variantId}</p>
        </div>
        {delivery.vendorReferenceId && (
          <div>
            <p className="text-muted-foreground">Vendor Reference</p>
            <p className="font-mono text-xs">{delivery.vendorReferenceId}</p>
          </div>
        )}
      </div>

      {/* Error */}
      {delivery.lastError && (
        <div className="border border-red-200 bg-red-50 rounded-lg px-4 py-3 text-sm text-red-700">
          <p className="font-medium">Last Error</p>
          <p className="mt-1 font-mono text-xs">{delivery.lastError}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => retryMutation.mutate()}
          disabled={
            retryMutation.isPending ||
            delivery.status === 'delivered' ||
            delivery.status === 'cancelled'
          }
          className="flex items-center gap-2 px-4 py-2 text-sm border rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
          {retryMutation.isPending ? 'Retrying...' : 'Retry'}
        </button>
        <button
          onClick={() => resendMutation.mutate()}
          disabled={resendMutation.isPending || delivery.status !== 'delivered'}
          className="flex items-center gap-2 px-4 py-2 text-sm border rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
        >
          <Mail className="h-4 w-4" />
          {resendMutation.isPending ? 'Sending...' : 'Resend Email'}
        </button>
        <button
          onClick={() => {
            if (window.confirm('Cancel this eSIM delivery? The eSIM will be cancelled with the vendor. No refund will be issued.')) {
              cancelMutation.mutate({ refund: false });
            }
          }}
          disabled={cancelMutation.isPending || delivery.status === 'cancelled'}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-red-300 text-red-600 rounded-md hover:bg-red-50 disabled:opacity-50 transition-colors"
        >
          <XCircle className="h-4 w-4" />
          {cancelMutation.isPending ? 'Cancelling...' : 'Cancel'}
        </button>
        <button
          onClick={() => {
            if (window.confirm('Cancel this eSIM delivery AND issue a full refund to the customer in Shopify? This cannot be undone.')) {
              cancelMutation.mutate({ refund: true });
            }
          }}
          disabled={cancelMutation.isPending || delivery.status === 'cancelled'}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-red-400 text-red-700 rounded-md hover:bg-red-50 disabled:opacity-50 transition-colors"
        >
          <XCircle className="h-4 w-4" />
          {cancelMutation.isPending ? 'Cancelling...' : 'Cancel + Refund'}
        </button>
      </div>

      {retryMutation.isSuccess && (
        <p className="text-sm text-green-600">Delivery queued for retry.</p>
      )}
      {retryMutation.isError && (
        <p className="text-sm text-red-600">
          Retry failed: {(retryMutation.error as Error).message}
        </p>
      )}
      {resendMutation.isSuccess && (
        <p className="text-sm text-green-600">Email resent successfully.</p>
      )}
      {resendMutation.isError && (
        <p className="text-sm text-red-600">
          Resend failed: {(resendMutation.error as Error).message}
        </p>
      )}
      {cancelMutation.isSuccess && (
        <p className="text-sm text-green-600">Cancellation queued. Refresh in a moment to see the updated status.</p>
      )}
      {cancelMutation.isError && (
        <p className="text-sm text-red-600">
          Cancel failed: {(cancelMutation.error as Error).message}
        </p>
      )}

      {/* eSIM Payload */}
      {delivery.esimPayload && <EsimPayloadCard payload={delivery.esimPayload} />}

      {/* Attempts */}
      {delivery.attempts.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Attempts</h2>
          <div className="space-y-2">
            {delivery.attempts.map((attempt) => (
              <div key={attempt.id} className="border rounded-lg px-4 py-3 text-sm space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-medium capitalize">{attempt.channel}</span>
                  <span className="text-muted-foreground text-xs">
                    {formatDistanceToNow(new Date(attempt.createdAt), { addSuffix: true })}
                  </span>
                </div>
                {attempt.result && (
                  <p className="text-xs text-muted-foreground font-mono">{attempt.result}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* eSIM Orders */}
      {delivery.esimOrders.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Vendor Orders</h2>
          <div className="space-y-2">
            {delivery.esimOrders.map((order) => (
              <div key={order.id} className="border rounded-lg px-4 py-3 text-sm space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs">{order.vendorReferenceId}</span>
                  <StatusBadge status={order.status} />
                </div>
                {order.lastError && (
                  <p className="text-xs text-red-600">{order.lastError}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
