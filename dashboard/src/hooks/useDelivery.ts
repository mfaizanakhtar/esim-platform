import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import type { DeliveryDetail } from '@/lib/types';

export function useDelivery(id: string) {
  return useQuery({
    queryKey: ['delivery', id],
    queryFn: () => apiClient.get<DeliveryDetail>(`/deliveries/${id}`),
    enabled: Boolean(id),
  });
}
