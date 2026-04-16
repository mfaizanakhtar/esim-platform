import { useState, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useDeliveries } from '@/hooks/useDeliveries';
import { StatusBadge } from '@/components/deliveries/StatusBadge';
import { DeliveryActionsDropdown } from '@/components/deliveries/DeliveryActionsDropdown';
import { DeliverySlideOver } from '@/components/deliveries/DeliverySlideOver';
import { BulkActionBar } from '@/components/deliveries/BulkActionBar';
import { format } from 'date-fns';
import type { Delivery } from '@/lib/types';

const PAGE_SIZE = 50;

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'provisioning', label: 'Provisioning' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'failed', label: 'Failed' },
  { value: 'awaiting_callback', label: 'Awaiting Callback' },
  { value: 'polling', label: 'Polling' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function Deliveries() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') ?? '';
  const page = Number(searchParams.get('page') ?? '1');
  const offset = (page - 1) * PAGE_SIZE;

  const [slideOverId, setSlideOverId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data, isFetching, isError } = useDeliveries({
    status: status || undefined,
    limit: PAGE_SIZE,
    offset,
  });

  function setStatus(value: string) {
    setSelectedIds(new Set());
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set('status', value);
      else next.delete('status');
      next.set('page', '1');
      return next;
    });
  }

  function setPage(p: number) {
    setSelectedIds(new Set());
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('page', String(p));
      return next;
    });
  }

  const deliveries = data?.deliveries ?? [];
  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;

  const allSelected = deliveries.length > 0 && deliveries.every((d) => selectedIds.has(d.id));
  const someSelected = !allSelected && deliveries.some((d) => selectedIds.has(d.id));

  const selectedDeliveries: Delivery[] = deliveries.filter((d) => selectedIds.has(d.id));
  const selectedIdsList = Array.from(selectedIds);

  // Select-all checkbox indeterminate via ref callback
  const selectAllRef = useCallback(
    (el: HTMLInputElement | null) => {
      if (el) el.indeterminate = someSelected;
    },
    [someSelected],
  );

  function toggleAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(deliveries.map((d) => d.id)));
    }
  }

  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold mr-auto">Deliveries</h1>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="border rounded-md px-3 py-1.5 text-sm"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {data && (
          <span className="text-sm text-muted-foreground">{data.total} total</span>
        )}
      </div>

      <div className="border rounded-lg overflow-x-auto relative">
        {isFetching && (
          <div className="absolute top-0 left-0 right-0 h-0.5 overflow-hidden z-10 bg-gray-200">
            <div className="h-full w-1/3 bg-gray-900" style={{ animation: 'slideProgress 1.2s ease-in-out infinite' }} />
          </div>
        )}
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 w-10">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all"
                  className="cursor-pointer"
                />
              </th>
              <th className="text-left px-4 py-3 font-medium">Order</th>
              <th className="text-left px-4 py-3 font-medium">Customer</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Created</th>
              <th className="text-left px-4 py-3 font-medium">SKU</th>
              <th className="px-4 py-3"><span className="sr-only">View</span></th>
              <th className="px-4 py-3"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isFetching &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 8 }).map((__, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 bg-muted animate-pulse rounded" />
                    </td>
                  ))}
                </tr>
              ))}

            {!isFetching && isError && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                  Failed to load deliveries. Check your connection or API key.
                </td>
              </tr>
            )}

            {!isFetching && deliveries.map((delivery) => {
              const isSelected = selectedIds.has(delivery.id);
              return (
                <tr
                  key={delivery.id}
                  className={`hover:bg-muted/30 transition-colors ${isSelected ? 'bg-muted/20' : ''}`}
                >
                  <td className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleRow(delivery.id)}
                      aria-label={`Select ${delivery.orderName}`}
                      className="cursor-pointer"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      to={`/deliveries/${delivery.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {delivery.orderName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {delivery.customerEmail ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={delivery.status} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {format(new Date(delivery.createdAt), 'MMM d, yyyy HH:mm')}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                    {delivery.variantId}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => setSlideOverId(delivery.id)}
                      className="px-2.5 py-1 text-xs border rounded-md hover:bg-muted transition-colors"
                    >
                      View
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <DeliveryActionsDropdown id={delivery.id} status={delivery.status} />
                  </td>
                </tr>
              );
            })}

            {!isFetching && deliveries.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                  No deliveries found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(page - 1)}
              disabled={page <= 1}
              className="px-3 py-1 text-sm border rounded-md disabled:opacity-50 hover:bg-muted transition-colors"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(page + 1)}
              disabled={page >= totalPages}
              className="px-3 py-1 text-sm border rounded-md disabled:opacity-50 hover:bg-muted transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}

      <DeliverySlideOver deliveryId={slideOverId} onClose={() => setSlideOverId(null)} />
      <BulkActionBar
        selectedIds={selectedIdsList}
        selectedDeliveries={selectedDeliveries}
        onClear={() => setSelectedIds(new Set())}
      />
    </div>
  );
}
