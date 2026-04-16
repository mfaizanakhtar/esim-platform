import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';

export function useRetryDelivery(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post<{ ok: boolean; message: string }>(`/deliveries/${id}/retry`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['deliveries'] });
      void qc.invalidateQueries({ queryKey: ['delivery', id] });
    },
  });
}

export function useResendEmail(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient.post<{ ok: boolean; messageId: string }>(`/deliveries/${id}/resend-email`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['delivery', id] });
    },
  });
}

export function useCancelDelivery(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { refund: boolean }) =>
      apiClient.post<{ ok: boolean; message: string }>(`/deliveries/${id}/cancel`, vars),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['deliveries'] });
      void qc.invalidateQueries({ queryKey: ['delivery', id] });
      // Poll every 2s for ~14s to catch the async cancel job completing.
      // Stops early if no active observers remain (e.g. user navigated away).
      let ticks = 0;
      const timer = setInterval(() => {
        ticks++;
        const observed = qc.getQueryCache().find({ queryKey: ['deliveries'] });
        if (!observed || observed.getObserversCount() === 0 || ticks >= 7) {
          clearInterval(timer);
          return;
        }
        void qc.invalidateQueries({ queryKey: ['deliveries'] });
        void qc.invalidateQueries({ queryKey: ['delivery', id] });
      }, 2000);
    },
  });
}
