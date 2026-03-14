import { ApiError } from '@/lib/queryClient';

// apiKey is accessed lazily to avoid circular imports
function getApiKey(): string | null {
  try {
    return sessionStorage.getItem('esim-admin-api-key');
  } catch {
    return null;
  }
}

function clearApiKey(): void {
  try {
    sessionStorage.removeItem('esim-admin-api-key');
  } catch {
    // ignore
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const apiKey = getApiKey();
  const baseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/admin';

  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'x-admin-key': apiKey } : {}),
      ...options?.headers,
    },
  });

  if (res.status === 401) {
    clearApiKey();
    // Trigger page reload to redirect to login
    window.location.href = '/login';
    throw new ApiError(401, 'Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export const apiClient = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
