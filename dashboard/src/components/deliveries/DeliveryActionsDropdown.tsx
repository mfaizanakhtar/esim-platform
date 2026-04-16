import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, RefreshCw, Mail, XCircle } from 'lucide-react';
import { useRetryDelivery, useResendEmail, useCancelDelivery } from '@/hooks/useDeliveryMutations';
import type { DeliveryStatus } from '@/lib/types';

interface Props {
  id: string;
  status: DeliveryStatus;
}

export function DeliveryActionsDropdown({ id, status }: Props) {
  const retryMutation = useRetryDelivery(id);
  const resendMutation = useResendEmail(id);
  const cancelMutation = useCancelDelivery(id);

  const canRetry = status !== 'delivered' && status !== 'cancelled';
  const canResend = status === 'delivered';
  const canCancel = status !== 'cancelled';

  const isPending = retryMutation.isPending || resendMutation.isPending || cancelMutation.isPending;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="flex items-center gap-1 px-2.5 py-1 text-xs border rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
          disabled={isPending}
        >
          {isPending ? 'Working…' : 'Actions'}
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-[160px] rounded-md border bg-white shadow-md py-1 text-sm"
        >
          <DropdownMenu.Item
            disabled={!canRetry || retryMutation.isPending}
            onSelect={(e) => {
              e.preventDefault();
              retryMutation.mutate();
            }}
            className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-muted data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed data-[disabled]:pointer-events-none outline-none"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </DropdownMenu.Item>

          <DropdownMenu.Item
            disabled={!canResend || resendMutation.isPending}
            onSelect={(e) => {
              e.preventDefault();
              resendMutation.mutate();
            }}
            className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-muted data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed data-[disabled]:pointer-events-none outline-none"
          >
            <Mail className="h-3.5 w-3.5" />
            Resend Email
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="my-1 border-t" />

          <DropdownMenu.Item
            disabled={!canCancel || cancelMutation.isPending}
            onSelect={(e) => {
              e.preventDefault();
              if (window.confirm('Cancel this eSIM delivery? The eSIM will be cancelled with the vendor. No refund will be issued.')) {
                cancelMutation.mutate({ refund: false });
              }
            }}
            className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-red-600 hover:bg-red-50 data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed data-[disabled]:pointer-events-none outline-none"
          >
            <XCircle className="h-3.5 w-3.5" />
            Cancel
          </DropdownMenu.Item>

          <DropdownMenu.Item
            disabled={!canCancel || cancelMutation.isPending}
            onSelect={(e) => {
              e.preventDefault();
              if (window.confirm('Cancel this eSIM delivery AND issue a full refund to the customer in Shopify? This cannot be undone.')) {
                cancelMutation.mutate({ refund: true });
              }
            }}
            className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-red-700 hover:bg-red-50 data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed data-[disabled]:pointer-events-none outline-none font-medium"
          >
            <XCircle className="h-3.5 w-3.5" />
            Cancel + Refund
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
