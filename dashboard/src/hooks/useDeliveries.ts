import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import type { Delivery, DeliveriesPage } from '@/lib/types';

interface UseDeliveriesParams {
  status?: string;
  limit?: number;
  offset?: number;
}

export function useDeliveries(params: UseDeliveriesParams = {}) {
  const { status, limit = 50, offset = 0 } = params;

  const searchParams = new URLSearchParams();
  if (status) searchParams.set('status', status);
  searchParams.set('limit', String(limit));
  searchParams.set('offset', String(offset));

  return useQuery({
    queryKey: ['deliveries', { status, limit, offset }],
    queryFn: () => apiClient.get<DeliveriesPage<Delivery>>(`/deliveries?${searchParams.toString()}`),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const hasActive = data.deliveries.some(
        (d) => d.status === 'pending' || d.status === 'provisioning' || d.status === 'polling',
      );
      return hasActive ? 10_000 : false;
    },
  });
}
