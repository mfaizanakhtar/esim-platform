import * as Dialog from '@radix-ui/react-dialog';
import { Link } from 'react-router-dom';
import { X, ExternalLink, RefreshCw, Mail, XCircle } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { useDelivery } from '@/hooks/useDelivery';
import { useRetryDelivery, useResendEmail, useCancelDelivery } from '@/hooks/useDeliveryMutations';
import { StatusBadge } from '@/components/deliveries/StatusBadge';
import { EsimPayloadCard } from '@/components/deliveries/EsimPayloadCard';

interface Props {
  deliveryId: string | null;
  onClose: () => void;
}

function SlideOverContent({ deliveryId, onClose }: { deliveryId: string; onClose: () => void }) {
  const { data: delivery, isLoading, isError } = useDelivery(deliveryId);
  const retryMutation = useRetryDelivery(deliveryId);
  const resendMutation = useResendEmail(deliveryId);
  const cancelMutation = useCancelDelivery(deliveryId);

  return (
    <div className="flex flex-col h-full">
      {/* Sticky header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b sticky top-0 bg-white z-10 shrink-0">
        {delivery ? (
          <>
            <span className="font-semibold text-sm">{delivery.orderName}</span>
            <StatusBadge status={delivery.status} />
            <Link
              to={`/deliveries/${deliveryId}`}
              onClick={onClose}
              className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Full page
              <ExternalLink className="h-3 w-3" />
            </Link>
          </>
        ) : (
          <span className="font-semibold text-sm text-muted-foreground">Loading…</span>
        )}
        <Dialog.Close asChild>
          <button
            aria-label="Close"
            className="ml-2 p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </Dialog.Close>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-5 bg-muted animate-pulse rounded" />
            ))}
          </div>
        )}

        {isError && (
          <p className="text-sm text-red-600">Failed to load delivery.</p>
        )}

        {delivery && (
          <>
            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => retryMutation.mutate()}
                disabled={retryMutation.isPending || delivery.status === 'delivered' || delivery.status === 'cancelled'}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${retryMutation.isPending ? 'animate-spin' : ''}`} />
                {retryMutation.isPending ? 'Retrying…' : 'Retry'}
              </button>
              <button
                onClick={() => resendMutation.mutate()}
                disabled={resendMutation.isPending || delivery.status !== 'delivered'}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
              >
                <Mail className="h-3.5 w-3.5" />
                {resendMutation.isPending ? 'Sending…' : 'Resend Email'}
              </button>
              <button
                onClick={() => {
                  if (window.confirm('Cancel this eSIM delivery? The eSIM will be cancelled with the vendor. No refund will be issued.')) {
                    cancelMutation.mutate({ refund: false });
                  }
                }}
                disabled={cancelMutation.isPending || delivery.status === 'cancelled'}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-red-300 text-red-600 rounded-md hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                <XCircle className="h-3.5 w-3.5" />
                {cancelMutation.isPending ? 'Cancelling…' : 'Cancel'}
              </button>
              <button
                onClick={() => {
                  if (window.confirm('Cancel this eSIM delivery AND issue a full refund to the customer in Shopify? This cannot be undone.')) {
                    cancelMutation.mutate({ refund: true });
                  }
                }}
                disabled={cancelMutation.isPending || delivery.status === 'cancelled'}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-red-400 text-red-700 rounded-md hover:bg-red-50 disabled:opacity-50 transition-colors font-medium"
              >
                <XCircle className="h-3.5 w-3.5" />
                {cancelMutation.isPending ? 'Cancelling…' : 'Cancel + Refund'}
              </button>
            </div>

            {/* Mutation feedback */}
            {retryMutation.isSuccess && <p className="text-xs text-green-600">Delivery queued for retry.</p>}
            {retryMutation.isError && <p className="text-xs text-red-600">Retry failed: {(retryMutation.error as Error).message}</p>}
            {resendMutation.isSuccess && <p className="text-xs text-green-600">Email resent successfully.</p>}
            {resendMutation.isError && <p className="text-xs text-red-600">Resend failed: {(resendMutation.error as Error).message}</p>}
            {cancelMutation.isSuccess && <p className="text-xs text-green-600">Cancellation queued. Status will update shortly.</p>}
            {cancelMutation.isError && <p className="text-xs text-red-600">Cancel failed: {(cancelMutation.error as Error).message}</p>}

            {/* Meta grid */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Customer</p>
                <p className="font-medium text-xs mt-0.5">{delivery.customerEmail ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Created</p>
                <p className="font-medium text-xs mt-0.5">{format(new Date(delivery.createdAt), 'PPpp')}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Order ID</p>
                <p className="font-mono text-xs mt-0.5 break-all">{delivery.orderId}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Variant ID</p>
                <p className="font-mono text-xs mt-0.5 break-all">{delivery.variantId}</p>
              </div>
              {delivery.vendorReferenceId && (
                <div className="col-span-2">
                  <p className="text-xs text-muted-foreground">Vendor Reference</p>
                  <p className="font-mono text-xs mt-0.5 break-all">{delivery.vendorReferenceId}</p>
                </div>
              )}
            </div>

            {/* Last error */}
            {delivery.lastError && (
              <div className="border border-red-200 bg-red-50 rounded-lg px-3 py-2 text-xs text-red-700">
                <p className="font-medium">Last Error</p>
                <p className="mt-1 font-mono">{delivery.lastError}</p>
              </div>
            )}

            {/* eSIM Payload */}
            {delivery.esimPayload && <EsimPayloadCard payload={delivery.esimPayload} />}

            {/* Attempts */}
            {delivery.attempts.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Attempts</h3>
                <div className="space-y-2">
                  {delivery.attempts.map((attempt) => (
                    <div key={attempt.id} className="border rounded-lg px-3 py-2 text-xs space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-medium capitalize">{attempt.channel}</span>
                        <span className="text-muted-foreground">
                          {formatDistanceToNow(new Date(attempt.createdAt), { addSuffix: true })}
                        </span>
                      </div>
                      {attempt.result && (
                        <p className="text-muted-foreground font-mono">{attempt.result}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Vendor Orders */}
            {delivery.esimOrders.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Vendor Orders</h3>
                <div className="space-y-2">
                  {delivery.esimOrders.map((order) => (
                    <div key={order.id} className="border rounded-lg px-3 py-2 text-xs space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-mono">{order.vendorReferenceId}</span>
                        <StatusBadge status={order.status} />
                      </div>
                      {order.lastError && (
                        <p className="text-red-600">{order.lastError}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function DeliverySlideOver({ deliveryId, onClose }: Props) {
  return (
    <Dialog.Root open={deliveryId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30 z-40" />
        <Dialog.Content
          className="fixed right-0 inset-y-0 z-50 w-full max-w-lg bg-white shadow-xl flex flex-col data-[state=open]:[animation:slide-in-right_200ms_ease-out] data-[state=closed]:[animation:slide-out-right_150ms_ease-in]"
        >
          <Dialog.Title className="sr-only">Delivery details</Dialog.Title>
          {deliveryId && <SlideOverContent deliveryId={deliveryId} onClose={onClose} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
