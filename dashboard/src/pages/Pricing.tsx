import { useState } from 'react';
import {
  usePricingOverview,
  usePricingCountry,
  useCompetitorPrices,
  usePricingRuns,
  useScrapeCompetitors,
  useCalculateCostFloors,
  useGenerateSuggestions,
  useApprovePricing,
  useApproveAndPush,
  useBulkLockVariants,
  DEFAULT_PRICING_PARAMS,
  type PricingCountryOverview,
  type PricingVariant,
  type PricingParams,
} from '@/hooks/usePricing';
import {
  Search,
  X,
  Eye,
  Lock,
  Unlock,
  TrendingDown,
  BarChart3,
  Zap,
  Check,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

// ─── Toast ────────────────────────────────────────────────────────────

type ToastType = 'success' | 'error' | 'info';

function Toast({ message, type, onClose }: { message: string; type: ToastType; onClose: () => void }) {
  const bg =
    type === 'success'
      ? 'bg-green-50 border-green-200 text-green-800'
      : type === 'error'
        ? 'bg-red-50 border-red-200 text-red-800'
        : 'bg-blue-50 border-blue-200 text-blue-800';
  return (
    <div className={`flex items-center gap-2 px-4 py-2.5 text-sm border rounded-md ${bg}`}>
      <span className="flex-1">{message}</span>
      <button onClick={onClose} className="shrink-0 hover:opacity-70">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ─── Confirm Dialog ───────────────────────────────────────────────────

function ConfirmDialog({
  title,
  message,
  children,
  actions,
  onClose,
}: {
  title: string;
  message: string;
  children?: React.ReactNode;
  actions: Array<{ label: string; onClick: () => void; variant?: 'primary' | 'danger' | 'default' }>;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-lg max-w-md w-full mx-4 p-6 space-y-4">
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-sm text-muted-foreground">{message}</p>
        {children}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded-md hover:bg-muted">
            Cancel
          </button>
          {actions.map((a) => {
            const cls =
              a.variant === 'primary'
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : a.variant === 'danger'
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'border hover:bg-muted';
            return (
              <button key={a.label} onClick={() => { a.onClick(); onClose(); }} className={`px-3 py-1.5 text-sm rounded-md ${cls}`}>
                {a.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Market Position Indicator ─────────────────────────────────────

function MarketBadge({ position }: { position: string }) {
  switch (position) {
    case 'competitive':
      return <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-800">Competitive</span>;
    case 'above_market':
      return <span className="px-2 py-0.5 text-xs rounded-full bg-yellow-100 text-yellow-800">Above Market</span>;
    case 'no_data':
      return <span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-500">No Data</span>;
    default:
      return <span className="px-2 py-0.5 text-xs rounded-full bg-gray-50 text-gray-400">—</span>;
  }
}

// ─── Competitor Modal ─────────────────────────────────────────────

function CompetitorModal({
  countryCode,
  variant,
  onClose,
}: {
  countryCode: string;
  variant: PricingVariant;
  onClose: () => void;
}) {
  const parsed = variant.sku.match(/(\d+)(GB|MB)/);
  const dataMb = parsed ? (parsed[2] === 'GB' ? parseInt(parsed[1]) * 1024 : parseInt(parsed[1])) : 0;
  const validMatch = variant.sku.match(/(\d+)D/);
  const validityDays = validMatch ? parseInt(validMatch[1]) : 0;

  const { data } = useCompetitorPrices({ countryCode, dataMb, validityDays });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-lg max-w-lg w-full mx-4 max-h-[70vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between">
          <div>
            <h3 className="font-semibold">
              {countryCode} — {variant.volume} / {variant.validity}
            </h3>
            <div className="text-sm text-muted-foreground mt-1">
              Our cost: ${variant.providerCost ?? '—'} · Floor: ${variant.costFloor ?? '—'} · Proposed:{' '}
              <span className="font-medium">${variant.proposedPrice ?? '—'}</span>
            </div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-6">
          {!data?.prices.length ? (
            <p className="text-sm text-muted-foreground">No competitor data for this combination.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 font-medium">Provider</th>
                  <th className="text-right py-2 font-medium">Price</th>
                  <th className="text-right py-2 font-medium">Data</th>
                  <th className="text-right py-2 font-medium">Days</th>
                </tr>
              </thead>
              <tbody>
                {data.prices.slice(0, 15).map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="py-2">{p.brand}</td>
                    <td className="py-2 text-right font-medium">${parseFloat(p.price).toFixed(2)}</td>
                    <td className="py-2 text-right text-muted-foreground">
                      {p.dataMb >= 1024 ? `${(p.dataMb / 1024).toFixed(0)}GB` : `${p.dataMb}MB`}
                    </td>
                    <td className="py-2 text-right text-muted-foreground">{p.validityDays}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Country Drill-Down ───────────────────────────────────────────

function CountryDrillDown({
  countryCode,
  onApprove,
  onReject,
}: {
  countryCode: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { data, isLoading } = usePricingCountry(countryCode);
  const lockMutation = useBulkLockVariants();
  const [competitorVariant, setCompetitorVariant] = useState<PricingVariant | null>(null);

  if (isLoading) return <div className="p-4"><div className="h-8 bg-muted animate-pulse rounded" /></div>;
  if (!data) return null;

  const pendingCount = data.variants.filter((v) => v.proposedPrice && !v.priceLocked).length;

  return (
    <div className="border-t bg-muted/10 p-4">
      {competitorVariant && (
        <CompetitorModal
          countryCode={countryCode}
          variant={competitorVariant}
          onClose={() => setCompetitorVariant(null)}
        />
      )}

      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium">{data.title} — {pendingCount} pending changes</span>
        <div className="flex gap-2">
          <button
            onClick={onApprove}
            disabled={pendingCount === 0}
            className="flex items-center gap-1.5 px-2.5 py-1 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" /> Approve
          </button>
          <button
            onClick={onReject}
            className="px-2.5 py-1 text-sm border rounded-md hover:bg-muted"
          >
            Reject
          </button>
        </div>
      </div>

      <div className="overflow-x-auto border rounded-md bg-white">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-3 py-1.5 text-left font-medium">SKU</th>
              <th className="px-3 py-1.5 text-left font-medium">Type</th>
              <th className="px-3 py-1.5 text-right font-medium">Cost</th>
              <th className="px-3 py-1.5 text-right font-medium">Floor</th>
              <th className="px-3 py-1.5 text-left font-medium">Cheapest Competitor</th>
              <th className="px-3 py-1.5 text-right font-medium">Proposed</th>
              <th className="px-3 py-1.5 text-right font-medium">Current</th>
              <th className="px-3 py-1.5 text-center font-medium">Market</th>
              <th className="px-3 py-1.5 text-center font-medium">Lock</th>
              <th className="px-3 py-1.5 w-8" />
            </tr>
          </thead>
          <tbody>
            {data.variants.map((v) => {
              const proposed = v.proposedPrice ? parseFloat(v.proposedPrice) : null;
              const current = parseFloat(v.price);
              const diff = proposed ? ((proposed - current) / current * 100).toFixed(0) : null;

              return (
                <tr key={v.id} className={`border-b last:border-0 ${v.priceLocked ? 'bg-yellow-50/50' : ''}`}>
                  <td className="px-3 py-1.5 font-mono">{v.sku}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{v.planType}</td>
                  <td className="px-3 py-1.5 text-right text-muted-foreground">
                    {v.providerCost ? `$${parseFloat(v.providerCost).toFixed(2)}` : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right text-muted-foreground">
                    {v.costFloor ? `$${parseFloat(v.costFloor).toFixed(2)}` : '—'}
                  </td>
                  <td className="px-3 py-1.5">
                    {v.competitorBrand ? (
                      <span>
                        {v.competitorBrand}{' '}
                        <span className="text-muted-foreground">
                          ${v.competitorPrice ? parseFloat(v.competitorPrice).toFixed(2) : '—'}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right font-medium">
                    {proposed ? (
                      <span>
                        ${proposed.toFixed(2)}{' '}
                        {diff && (
                          <span className={`text-xs ${parseInt(diff) > 0 ? 'text-red-500' : 'text-green-600'}`}>
                            {parseInt(diff) > 0 ? '+' : ''}{diff}%
                          </span>
                        )}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right">${current.toFixed(2)}</td>
                  <td className="px-3 py-1.5 text-center">
                    <MarketBadge position={v.marketPosition ?? ''} />
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <button
                      onClick={() =>
                        lockMutation.mutate({ variantIds: [v.id], priceLocked: !v.priceLocked })
                      }
                      className={`p-0.5 rounded transition-colors ${v.priceLocked ? 'text-yellow-600' : 'text-muted-foreground hover:text-foreground'}`}
                      title={v.priceLocked ? 'Unlock price' : 'Lock price'}
                    >
                      {v.priceLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                    </button>
                  </td>
                  <td className="px-3 py-1.5">
                    <button
                      onClick={() => setCompetitorVariant(v)}
                      className="p-0.5 text-muted-foreground hover:text-foreground"
                      title="View competitors"
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────

export function Pricing() {
  const { data: overview, isLoading } = usePricingOverview();
  const { data: runsData } = usePricingRuns();
  const scrapeMutation = useScrapeCompetitors();
  const costFloorMutation = useCalculateCostFloors();
  const suggestMutation = useGenerateSuggestions();
  const approveMutation = useApprovePricing();
  const approveAndPushMutation = useApproveAndPush();

  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    message: string;
    children?: React.ReactNode;
    actions: Array<{ label: string; onClick: () => void; variant?: 'primary' | 'danger' | 'default' }>;
  } | null>(null);
  const [expandedCountry, setExpandedCountry] = useState<string | null>(null);
  const [selectedCountries, setSelectedCountries] = useState<Set<string>>(() => new Set());
  const [showRuns, setShowRuns] = useState(false);
  const [pricingParams, setPricingParams] = useState<PricingParams>(DEFAULT_PRICING_PARAMS);

  const countries = overview?.countries ?? [];
  const filtered = search
    ? countries.filter(
        (c) =>
          c.title.toLowerCase().includes(search.toLowerCase()) ||
          c.countryCode.toLowerCase().includes(search.toLowerCase()),
      )
    : countries;

  const totalPending = overview?.totalPending ?? 0;
  const approvedCountries = [...selectedCountries].filter((code) =>
    countries.find((c) => c.countryCode === code && c.pendingChanges > 0),
  );

  function showToast(message: string, type: ToastType = 'info') {
    setToast({ message, type });
    if (type !== 'error') setTimeout(() => setToast(null), 8000);
  }

  const anyPending =
    scrapeMutation.isPending ||
    costFloorMutation.isPending ||
    suggestMutation.isPending ||
    approveMutation.isPending ||
    approveAndPushMutation.isPending;

  // ─── Handlers ─────────────────────────────────────────────────

  function handleScrape() {
    setConfirm({
      title: 'Scrape Competitors',
      message:
        'Scrape competitor prices from esims.io for all countries? Countries scraped within 24h will be skipped. This runs in the background (~5 min).',
      actions: [
        {
          label: 'Scrape',
          variant: 'primary',
          onClick: () =>
            scrapeMutation.mutate(
              {},
              {
                onSuccess: () => showToast('Scraping competitor prices in background', 'info'),
                onError: (e) => showToast(`Failed: ${(e as Error).message}`, 'error'),
              },
            ),
        },
      ],
    });
  }

  function handleCostFloors() {
    setConfirm({
      title: 'Calculate Cost Floors',
      message:
        'Calculate minimum prices for all variants based on provider catalog costs? This runs in the background.',
      actions: [
        {
          label: 'Calculate',
          variant: 'primary',
          onClick: () =>
            costFloorMutation.mutate(
              {},
              {
                onSuccess: () => showToast('Calculating cost floors in background', 'info'),
                onError: (e) => showToast(`Failed: ${(e as Error).message}`, 'error'),
              },
            ),
        },
      ],
    });
  }

  function handleGenerateSuggestions() {
    setConfirm({
      title: 'Generate Suggested Prices',
      message:
        'Generate proposed prices based on cost floors and competitor data. Locked variants will be skipped.',
      children: (
        <div className="space-y-3 pt-2">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Survival Margin (%)</label>
              <input
                type="number"
                value={pricingParams.survivalMargin * 100}
                onChange={(e) =>
                  setPricingParams((p) => ({ ...p, survivalMargin: parseFloat(e.target.value) / 100 }))
                }
                className="w-full mt-1 px-2 py-1 text-sm border rounded-md"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Undercut (%)</label>
              <input
                type="number"
                value={pricingParams.undercutPercent * 100}
                onChange={(e) =>
                  setPricingParams((p) => ({ ...p, undercutPercent: parseFloat(e.target.value) / 100 }))
                }
                className="w-full mt-1 px-2 py-1 text-sm border rounded-md"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Min Price ($)</label>
              <input
                type="number"
                step="0.01"
                value={pricingParams.minimumPrice}
                onChange={(e) =>
                  setPricingParams((p) => ({ ...p, minimumPrice: parseFloat(e.target.value) }))
                }
                className="w-full mt-1 px-2 py-1 text-sm border rounded-md"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Monotonic Step ($)</label>
              <input
                type="number"
                step="0.01"
                value={pricingParams.monotonicStep}
                onChange={(e) =>
                  setPricingParams((p) => ({ ...p, monotonicStep: parseFloat(e.target.value) }))
                }
                className="w-full mt-1 px-2 py-1 text-sm border rounded-md"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground italic">
            This generates PROPOSED prices only. Review and approve before applying.
          </p>
        </div>
      ),
      actions: [
        {
          label: 'Generate',
          variant: 'primary',
          onClick: () =>
            suggestMutation.mutate(
              { params: pricingParams },
              {
                onSuccess: () => showToast('Generating suggested prices in background', 'info'),
                onError: (e) => showToast(`Failed: ${(e as Error).message}`, 'error'),
              },
            ),
        },
      ],
    });
  }

  function handleApproveCountry(code: string) {
    approveMutation.mutate(
      { countryCodes: [code] },
      {
        onSuccess: (d) => showToast(`Applied ${d.updated} price changes for ${code}`, 'success'),
        onError: (e) => showToast(`Failed: ${(e as Error).message}`, 'error'),
      },
    );
  }

  function handleRejectCountry(code: string) {
    // Clear proposed prices for this country
    setExpandedCountry(null);
    showToast(`Rejected price changes for ${code}`, 'info');
  }

  function handleApproveSelected() {
    if (approvedCountries.length === 0) return;
    setConfirm({
      title: 'Apply Approved Prices',
      message: `Apply proposed price changes for ${approvedCountries.length} country(ies)? Current prices will be overwritten.`,
      actions: [
        {
          label: 'Apply',
          variant: 'primary',
          onClick: () =>
            approveMutation.mutate(
              { countryCodes: approvedCountries },
              {
                onSuccess: (d) => {
                  showToast(`Applied ${d.updated} price changes`, 'success');
                  setSelectedCountries(new Set());
                },
                onError: (e) => showToast(`Failed: ${(e as Error).message}`, 'error'),
              },
            ),
        },
      ],
    });
  }

  function handleApproveAndPushSelected() {
    if (approvedCountries.length === 0) return;
    setConfirm({
      title: 'Apply & Push to Shopify',
      message: `Apply ${approvedCountries.length} country price changes and push to Shopify? This updates products in the background.`,
      actions: [
        {
          label: 'Apply & Push',
          variant: 'primary',
          onClick: () =>
            approveAndPushMutation.mutate(
              { countryCodes: approvedCountries },
              {
                onSuccess: (d) => {
                  showToast(`Applied ${d.updated} changes, pushing to Shopify`, 'info');
                  setSelectedCountries(new Set());
                },
                onError: (e) => showToast(`Failed: ${(e as Error).message}`, 'error'),
              },
            ),
        },
      ],
    });
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Pricing Engine</h1>
        <p className="text-muted-foreground mt-1">
          Analyze costs, monitor competitors, and optimize prices.
        </p>
      </div>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}

      {/* Zone 1: Data Collection */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={handleScrape}
          disabled={anyPending}
          className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md hover:bg-muted disabled:opacity-50"
        >
          <TrendingDown className={`h-4 w-4 ${scrapeMutation.isPending ? 'animate-pulse' : ''}`} />
          {scrapeMutation.isPending ? 'Scraping...' : 'Scrape Competitors'}
        </button>

        <button
          onClick={handleCostFloors}
          disabled={anyPending}
          className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md hover:bg-muted disabled:opacity-50"
        >
          <BarChart3 className={`h-4 w-4 ${costFloorMutation.isPending ? 'animate-pulse' : ''}`} />
          {costFloorMutation.isPending ? 'Calculating...' : 'Calculate Cost Floors'}
        </button>

        <button
          onClick={handleGenerateSuggestions}
          disabled={anyPending}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
        >
          <Zap className={`h-4 w-4 ${suggestMutation.isPending ? 'animate-pulse' : ''}`} />
          {suggestMutation.isPending ? 'Generating...' : 'Generate Suggested Prices'}
        </button>
      </div>

      {/* Zone 2: Stats + Search */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative max-w-sm flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search countries..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        {overview && (
          <div className="flex gap-3 text-sm text-muted-foreground">
            <span><span className="font-medium text-foreground">{overview.totalCountries}</span> countries</span>
            <span>·</span>
            <span><span className="font-medium text-foreground">{totalPending}</span> pending</span>
            <span>·</span>
            <span><span className="font-medium text-foreground">{overview.totalLocked}</span> locked</span>
          </div>
        )}
      </div>

      {/* Zone 3: Apply bar */}
      {totalPending > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 bg-green-50 border border-green-200 rounded-md">
          <span className="text-sm font-medium text-green-800 mr-2">
            {approvedCountries.length > 0 ? `${approvedCountries.length} selected with pending changes` : `${totalPending} total pending changes`}
          </span>
          <button
            onClick={handleApproveSelected}
            disabled={anyPending || approvedCountries.length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" /> Apply Prices
          </button>
          <button
            onClick={handleApproveAndPushSelected}
            disabled={anyPending || approvedCountries.length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1 text-sm border border-green-300 text-green-800 rounded-md hover:bg-green-100 disabled:opacity-50"
          >
            Apply & Push to Shopify
          </button>
          {selectedCountries.size > 0 && (
            <button
              onClick={() => setSelectedCountries(new Set())}
              className="ml-auto text-sm text-green-700 hover:text-green-900"
            >
              Clear selection
            </button>
          )}
        </div>
      )}

      {/* Zone 4: Country table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 bg-muted animate-pulse rounded-md" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {search ? 'No countries match your search' : 'No pricing data yet. Scrape competitors and calculate cost floors first.'}
        </div>
      ) : (
        <div className="border rounded-md">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-3 py-2 w-10">
                  <input
                    type="checkbox"
                    checked={filtered.length > 0 && filtered.every((c) => selectedCountries.has(c.countryCode))}
                    onChange={() => {
                      const allSelected = filtered.every((c) => selectedCountries.has(c.countryCode));
                      setSelectedCountries((prev) => {
                        const next = new Set(prev);
                        for (const c of filtered) {
                          if (allSelected) next.delete(c.countryCode);
                          else next.add(c.countryCode);
                        }
                        return next;
                      });
                    }}
                    className="rounded"
                  />
                </th>
                <th className="px-3 py-2 w-8" />
                <th className="text-left px-3 py-2 font-medium">Country</th>
                <th className="text-right px-3 py-2 font-medium">Variants</th>
                <th className="text-right px-3 py-2 font-medium">Pending</th>
                <th className="text-right px-3 py-2 font-medium">Avg Cost</th>
                <th className="text-right px-3 py-2 font-medium">Avg Suggested</th>
                <th className="text-center px-3 py-2 font-medium">Market</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <CountryRow
                  key={c.countryCode}
                  country={c}
                  isExpanded={expandedCountry === c.countryCode}
                  isSelected={selectedCountries.has(c.countryCode)}
                  onToggleExpand={() =>
                    setExpandedCountry(expandedCountry === c.countryCode ? null : c.countryCode)
                  }
                  onToggleSelect={() =>
                    setSelectedCountries((prev) => {
                      const next = new Set(prev);
                      if (next.has(c.countryCode)) next.delete(c.countryCode);
                      else next.add(c.countryCode);
                      return next;
                    })
                  }
                  onApprove={() => handleApproveCountry(c.countryCode)}
                  onReject={() => handleRejectCountry(c.countryCode)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Zone 5: Recent Runs */}
      {runsData && runsData.runs.length > 0 && (
        <div>
          <button
            onClick={() => setShowRuns(!showRuns)}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            {showRuns ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Recent Runs ({runsData.runs.length})
          </button>
          {showRuns && (
            <div className="mt-2 border rounded-md overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-1.5 text-left font-medium">Type</th>
                    <th className="px-3 py-1.5 text-left font-medium">Status</th>
                    <th className="px-3 py-1.5 text-right font-medium">Updated</th>
                    <th className="px-3 py-1.5 text-right font-medium">Skipped</th>
                    <th className="px-3 py-1.5 text-right font-medium">Errors</th>
                    <th className="px-3 py-1.5 text-left font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {runsData.runs.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="px-3 py-1.5">{r.type.replace('_', ' ')}</td>
                      <td className="px-3 py-1.5">
                        <span
                          className={`px-1.5 py-0.5 rounded-full ${r.status === 'done' ? 'bg-green-100 text-green-800' : r.status === 'error' ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800'}`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right">{r.totalUpdated}</td>
                      <td className="px-3 py-1.5 text-right">{r.totalSkipped}</td>
                      <td className="px-3 py-1.5 text-right">{r.totalErrors}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">
                        {new Date(r.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Country Row (with expand) ────────────────────────────────────

function CountryRow({
  country,
  isExpanded,
  isSelected,
  onToggleExpand,
  onToggleSelect,
  onApprove,
  onReject,
}: {
  country: PricingCountryOverview;
  isExpanded: boolean;
  isSelected: boolean;
  onToggleExpand: () => void;
  onToggleSelect: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <>
      <tr
        className={`border-b hover:bg-muted/30 cursor-pointer transition-colors ${isSelected ? 'bg-primary/5' : ''}`}
        onClick={onToggleExpand}
      >
        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={isSelected} onChange={onToggleSelect} className="rounded" />
        </td>
        <td className="px-3 py-2">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </td>
        <td className="px-3 py-2 font-medium">
          <span className="flex items-center gap-2">
            <img
              src={`https://flagcdn.com/w20/${country.countryCode.toLowerCase()}.png`}
              alt=""
              className="h-4 rounded-sm"
            />
            {country.title}
            <span className="text-muted-foreground font-normal">({country.countryCode})</span>
          </span>
        </td>
        <td className="px-3 py-2 text-right">{country.variantCount}</td>
        <td className="px-3 py-2 text-right">
          {country.pendingChanges > 0 ? (
            <span className="px-1.5 py-0.5 text-xs bg-blue-100 text-blue-800 rounded-full">
              {country.pendingChanges}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-3 py-2 text-right text-muted-foreground">
          {country.avgCost ? `$${country.avgCost.toFixed(2)}` : '—'}
        </td>
        <td className="px-3 py-2 text-right font-medium">
          {country.avgProposed ? `$${country.avgProposed.toFixed(2)}` : '—'}
        </td>
        <td className="px-3 py-2 text-center">
          <MarketBadge position={country.marketPosition} />
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={8} className="p-0">
            <CountryDrillDown
              countryCode={country.countryCode}
              onApprove={onApprove}
              onReject={onReject}
            />
          </td>
        </tr>
      )}
    </>
  );
}
