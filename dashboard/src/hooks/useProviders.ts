import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => apiClient.get<{ providers: string[] }>('/providers'),
    staleTime: Infinity, // provider list only changes on backend deploy
  });
}

/** Capitalize first letter for display: "firoam" → "Firoam", "airalo" → "Airalo" */
export function providerLabel(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
