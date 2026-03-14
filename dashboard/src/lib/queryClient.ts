import { QueryClient } from '@tanstack/react-query';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export { ApiError };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status === 401) return false;
        if (error instanceof ApiError && error.status === 404) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: true,
    },
  },
});
