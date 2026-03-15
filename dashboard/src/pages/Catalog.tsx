import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCatalog, useSyncCatalog } from '@/hooks/useCatalog';
import { Pagination } from '@/components/Pagination';
import { RefreshCw } from 'lucide-react';

type Provider = 'firoam' | 'tgt';

const PAGE_SIZE = 25;

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

interface SyncButtonProps {
  provider: Provider;
}

function SyncButton({ provider }: SyncButtonProps) {
  const syncMutation = useSyncCatalog();
  const [lastResult, setLastResult] = useState<string | null>(null);

  function handleSync() {
    syncMutation.mutate(
      { provider, maxSkus: 500, pageSize: 100, maxPages: 20 },
      {
        onSuccess: (data) => {
          const count = data.processedPackages ?? data.processed ?? 0;
          setLastResult(`${provider === 'firoam' ? 'FiRoam' : 'TGT'} synced: ${count} packages`);
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

interface CatalogTabProps {
  provider: Provider;
}

function CatalogTab({ provider }: CatalogTabProps) {
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

  // Reset to page 0 when search changes, but not on initial mount
  // (preserves bookmarked ?page=N when navigating back)
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    setPage(0);
  }, [debouncedSearch, setPage]);

  const { data, isLoading } = useCatalog({
    provider,
    search: debouncedSearch || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, code, or region..."
          className="border rounded-md px-3 py-1.5 text-sm flex-1 max-w-sm"
        />
        <SyncButton provider={provider} />
        {data && (
          <span className="text-sm text-muted-foreground ml-auto">{data.total} items</span>
        )}
      </div>

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
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
            {isLoading &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 6 }).map((__, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 bg-muted animate-pulse rounded" />
                    </td>
                  ))}
                </tr>
              ))}

            {data?.items.map((item) => (
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

            {data?.items.length === 0 && (
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
  const [activeTab, setActiveTab] = useState<Provider>('firoam');

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Provider Catalog</h1>

      <div className="border-b">
        <div className="flex gap-0">
          {(['firoam', 'tgt'] as Provider[]).map((provider) => (
            <button
              key={provider}
              onClick={() => setActiveTab(provider)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === provider
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {provider === 'firoam' ? 'FiRoam' : 'TGT'}
            </button>
          ))}
        </div>
      </div>

      <CatalogTab provider={activeTab} />
    </div>
  );
}
