import type { DeliveryStatus } from '@/lib/types';

const STATUS_CONFIG: Record<DeliveryStatus, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
  provisioning: { label: 'Provisioning', className: 'bg-blue-100 text-blue-800 border-blue-200' },
  delivered: { label: 'Delivered', className: 'bg-green-100 text-green-800 border-green-200' },
  failed: { label: 'Failed', className: 'bg-red-100 text-red-800 border-red-200' },
  awaiting_callback: {
    label: 'Awaiting Callback',
    className: 'bg-orange-100 text-orange-800 border-orange-200',
  },
  polling: { label: 'Polling', className: 'bg-purple-100 text-purple-800 border-purple-200' },
  cancelled: { label: 'Cancelled', className: 'bg-gray-100 text-gray-600 border-gray-200' },
};

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status as DeliveryStatus] ?? {
    label: status,
    className: 'bg-gray-100 text-gray-800 border-gray-200',
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${config.className}`}
    >
      {config.label}
    </span>
  );
}
