import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCatalog, useSyncCatalog } from '@/hooks/useCatalog';
import { useProviders, providerLabel } from '@/hooks/useProviders';
import { Pagination } from '@/components/Pagination';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { RefreshCw, Cpu } from 'lucide-react';

const PAGE_SIZE = 25;

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function SyncButton({ provider }: { provider: string }) {
  const syncMutation = useSyncCatalog();
  const [lastResult, setLastResult] = useState<string | null>(null);

  function handleSync() {
    syncMutation.mutate(
      { provider, maxSkus: 500, pageSize: 100, maxPages: 20 },
      {
        onSuccess: (data) => {
          const count = data.processedPackages ?? data.processed ?? 0;
          setLastResult(`${providerLabel(provider)} synced: ${count} packages`);
        },
        onError: (err) => {
          setLastResult(`Sync failed: ${(err as Error).message}`);
        },
      },
    );
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleSync}
        disabled={syncMutation.isPending}
        className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
      >
        <RefreshCw className={`h-4 w-4 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
        {syncMutation.isPending ? 'Syncing...' : 'Sync'}
      </button>
      {lastResult && <span className="text-sm text-muted-foreground">{lastResult}</span>}
    </div>
  );
}

function EmbedBackfillButton({ provider }: { provider: string }) {
  const mutation = useMutation({
    mutationFn: () =>
      apiClient.post<{ ok: boolean; embedded: number }>('/provider-catalog/embed-backfill', { provider }),
  });
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
      >
        <Cpu className={`h-4 w-4 ${mutation.isPending ? 'animate-pulse' : ''}`} />
        {mutation.isPending ? 'Embedding...' : 'Embed Backfill'}
      </button>
      {mutation.isSuccess && (
        <span className="text-sm text-muted-foreground">{mutation.data.embedded} embeddings stored</span>
      )}
      {mutation.isError && (
        <span className="text-sm text-red-600">{(mutation.error as Error).message}</span>
      )}
    </div>
  );
}

function ParseAllButton({ provider }: { provider: string }) {
  const mutation = useMutation({
    mutationFn: () =>
      apiClient.post<{ ok: boolean; parsed: number }>('/provider-catalog/parse-all', { provider }),
  });
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
      >
        <Cpu className={`h-4 w-4 ${mutation.isPending ? 'animate-pulse' : ''}`} />
        {mutation.isPending ? 'Parsing...' : 'Parse All'}
      </button>
      {mutation.isSuccess && (
        <span className="text-sm text-muted-foreground">{mutation.data.parsed} entries parsed</span>
      )}
      {mutation.isError && (
        <span className="text-sm text-red-600">{(mutation.error as Error).message}</span>
      )}
    </div>
  );
}

function CatalogTab({ provider }: { provider: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const isInitialMount = useRef(true);

  const page = Number(searchParams.get('page') ?? 0);
  const setPage = useCallback(
    (p: number) => {
      setSearchParams((prev) => {
        if (p === 0) prev.delete('page');
        else prev.set('page', String(p));
        return prev;
      });
    },
    [setSearchParams],
  );

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    setPage(0);
  }, [debouncedSearch, setPage]);

  const { data, isFetching } = useCatalog({
    provider,
    search: debouncedSearch || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, code, or region..."
          className="border rounded-md px-3 py-1.5 text-sm flex-1 min-w-[160px] max-w-sm"
        />
        <SyncButton provider={provider} />
        <EmbedBackfillButton provider={provider} />
        <ParseAllButton provider={provider} />
        {data && (
          <span className="text-sm text-muted-foreground">{data.total} items</span>
        )}
      </div>

      <div className="border rounded-lg overflow-x-auto relative">
        {isFetching && (
          <div className="absolute top-0 left-0 right-0 h-0.5 overflow-hidden z-10 bg-gray-200">
            <div className="h-full w-1/3 bg-gray-900" style={{ animation: 'slideProgress 1.2s ease-in-out infinite' }} />
          </div>
        )}
        <table className="w-full text-sm min-w-[560px]">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Product Code</th>
              <th className="text-left px-4 py-3 font-medium">Name</th>
              <th className="text-left px-4 py-3 font-medium">Data</th>
              <th className="text-left px-4 py-3 font-medium">Validity</th>
              <th className="text-left px-4 py-3 font-medium">Price</th>
              <th className="text-left px-4 py-3 font-medium">Region</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isFetching &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 6 }).map((__, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 bg-muted animate-pulse rounded" />
                    </td>
                  ))}
                </tr>
              ))}

            {!isFetching && data?.items.map((item) => (
              <tr key={item.id} className="hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 font-mono text-xs">{item.productCode}</td>
                <td className="px-4 py-3">{item.productName}</td>
                <td className="px-4 py-3 text-muted-foreground">{item.dataAmount ?? '—'}</td>
                <td className="px-4 py-3 text-muted-foreground">{item.validity ?? '—'}</td>
                <td className="px-4 py-3 text-muted-foreground">
                  {item.netPrice ? `$${item.netPrice}` : '—'}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{item.region ?? '—'}</td>
              </tr>
            ))}

            {!isFetching && data?.items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  No catalog items. Click Sync to fetch from the provider.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {data && (
          <div className="border-t px-4">
            <Pagination
              total={data.total}
              page={page}
              pageSize={PAGE_SIZE}
              onChange={setPage}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function Catalog() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: providersData } = useProviders();
  const providers = providersData?.providers ?? [];

  const tabParam = searchParams.get('tab') ?? '';
  const activeTab = providers.includes(tabParam) ? tabParam : (providers[0] ?? '');

  // Set default tab in URL once providers load
  useEffect(() => {
    if (providers.length > 0 && !searchParams.get('tab')) {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('tab', providers[0]);
        return next;
      }, { replace: true });
    }
  }, [providers, searchParams, setSearchParams]);

  function setActiveTab(provider: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', provider);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Provider Catalog</h1>

      <div className="border-b">
        <div className="flex gap-0">
          {providers.map((provider) => (
            <button
              key={provider}
              onClick={() => setActiveTab(provider)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === provider
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {providerLabel(provider)}
            </button>
          ))}
        </div>
      </div>

      {/* key={activeTab} forces CatalogTab to remount when provider changes, resetting page/search state */}
      {activeTab && <CatalogTab key={activeTab} provider={activeTab} />}
    </div>
  );
}
