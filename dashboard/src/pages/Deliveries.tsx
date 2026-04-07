import { useSearchParams, Link } from 'react-router-dom';
import { useDeliveries } from '@/hooks/useDeliveries';
import { StatusBadge } from '@/components/deliveries/StatusBadge';
import { format } from 'date-fns';

const PAGE_SIZE = 50;

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'provisioning', label: 'Provisioning' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'failed', label: 'Failed' },
  { value: 'awaiting_callback', label: 'Awaiting Callback' },
  { value: 'polling', label: 'Polling' },
];

export function Deliveries() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') ?? '';
  const page = Number(searchParams.get('page') ?? '1');
  const offset = (page - 1) * PAGE_SIZE;

  const { data, isLoading, isFetching, isError } = useDeliveries({
    status: status || undefined,
    limit: PAGE_SIZE,
    offset,
  });

  function setStatus(value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set('status', value);
      else next.delete('status');
      next.set('page', '1');
      return next;
    });
  }

  function setPage(p: number) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('page', String(p));
      return next;
    });
  }

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;

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

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm min-w-[560px]">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Order</th>
              <th className="text-left px-4 py-3 font-medium">Customer</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Created</th>
              <th className="text-left px-4 py-3 font-medium">SKU</th>
            </tr>
          </thead>
          <tbody className={`divide-y transition-opacity duration-150 ${isFetching && !isLoading ? 'opacity-40 pointer-events-none' : 'opacity-100'}`}>
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

            {isError && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  Failed to load deliveries. Check your connection or API key.
                </td>
              </tr>
            )}

            {data?.deliveries.map((delivery) => (
              <tr key={delivery.id} className="hover:bg-muted/30 transition-colors">
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
              </tr>
            ))}

            {data?.deliveries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
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
    </div>
  );
}
