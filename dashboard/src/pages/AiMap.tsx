import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBulkCreateMappings } from '@/hooks/useSkuMappingMutations';
import { useProviders, providerLabel } from '@/hooks/useProviders';
import { useAiMapJob } from '@/hooks/useAiMapJob';
import { useStructuredMap } from '@/hooks/useStructuredMap';
import { apiClient } from '@/lib/api';
import type { AiMappingDraft, AiMapJob, UnmatchedSku } from '@/lib/types';
import { ArrowLeft, Brain, Cpu, CheckSquare, Square, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface DraftRow extends AiMappingDraft {
  selected: boolean;
}

interface UnmatchedRow extends UnmatchedSku {
  selected: boolean;
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const color =
    confidence >= 0.8
      ? 'bg-green-100 text-green-800'
      : confidence >= 0.5
        ? 'bg-yellow-100 text-yellow-800'
        : 'bg-red-100 text-red-800';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {pct}%
    </span>
  );
}

function JobStatusBadge({ status }: { status: AiMapJob['status'] }) {
  const map: Record<AiMapJob['status'], string> = {
    running: 'bg-blue-100 text-blue-800',
    done: 'bg-green-100 text-green-800',
    error: 'bg-red-100 text-red-800',
    interrupted: 'bg-yellow-100 text-yellow-800',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${map[status] ?? 'bg-muted text-muted-foreground'}`}>
      {status}
    </span>
  );
}

export function AiMap() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // Step 1 config
  const { data: providersData } = useProviders();
  const providers = providersData?.providers ?? [];

  const providerFilter = searchParams.get('provider') ?? '';
  const unmappedOnly = searchParams.get('unmapped') !== 'false';
  const [mode, setMode] = useState<'ai' | 'structured'>('ai');
  const [forceReplace, setForceReplace] = useState(false);
  const [requireData, setRequireData] = useState(true);
  const [requireValidity, setRequireValidity] = useState(true);
  const [requireExactRegion, setRequireExactRegion] = useState(true);

  function setProviderFilter(value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set('provider', value);
      else next.delete('provider');
      return next;
    });
  }

  function setUnmappedOnly(value: boolean) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (!value) next.set('unmapped', 'false');
      else next.delete('unmapped');
      return next;
    });
  }

  // Steps: configure | running | review | done
  const [step, setStep] = useState<'configure' | 'running' | 'review' | 'done'>('configure');
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [bulkResult, setBulkResult] = useState<{ created: number; updated: number; skipped: number; failed: number } | null>(null);
  const [pastJobsOpen, setPastJobsOpen] = useState(false);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [jobsActionError, setJobsActionError] = useState<string | null>(null);
  const [clearConfirming, setClearConfirming] = useState(false);
  const [clearLoading, setClearLoading] = useState(false);
  const [clearResult, setClearResult] = useState<{ deleted: number } | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(80);

  // Unmatched SKUs section
  const [unmatchedRows, setUnmatchedRows] = useState<UnmatchedRow[]>([]);
  const [unmatchedOpen, setUnmatchedOpen] = useState(false);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteResult, setDeleteResult] = useState<{ deleted: number; skipped: number; errors: string[] } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const aiJob = useAiMapJob();
  const structuredJob = useStructuredMap();
  // Unified interface — whichever mode is active
  const job = mode === 'ai' ? aiJob : structuredJob;
  const bulkCreate = useBulkCreateMappings();

  // Past jobs list — poll every 5s when panel is open
  const { data: pastJobsData, refetch: refetchJobs } = useQuery({
    queryKey: ['ai-map-jobs'],
    queryFn: () => apiClient.get<{ jobs: AiMapJob[] }>('/sku-mappings/ai-map/jobs'),
    refetchInterval: pastJobsOpen ? 5000 : false,
    enabled: pastJobsOpen,
  });
  const pastJobs = pastJobsData?.jobs ?? [];

  // Advance to review when job finishes
  useEffect(() => {
    if (step === 'running' && job.status === 'done') {
      const rows: DraftRow[] = job.drafts.map((d) => ({
        ...d,
        selected: d.confidence >= 0.8,
      }));
      setDrafts(rows);
      setUnmatchedRows(job.unmatchedSkus.map((v) => ({ ...v, selected: false })));
      setUnmatchedOpen(false);
      setDeleteConfirming(false);
      setDeleteLoading(false);
      setDeleteResult(null);
      setDeleteError(null);
      setStep('review');
      void queryClient.invalidateQueries({ queryKey: ['ai-map-jobs'] });
    }
  }, [step, job.status, job.drafts, job.unmatchedSkus, queryClient]);

  function resetUnmatchedState() {
    setUnmatchedRows([]);
    setUnmatchedOpen(false);
    setDeleteConfirming(false);
    setDeleteLoading(false);
    setDeleteResult(null);
    setDeleteError(null);
  }

  async function runAi() {
    setBulkResult(null);
    resetUnmatchedState();
    setStep('running');
    if (mode === 'ai') {
      await aiJob.start({
        provider: providerFilter || undefined,
        unmappedOnly: forceReplace ? false : unmappedOnly,
        relaxOptions: { requireData, requireValidity },
      });
    } else {
      await structuredJob.start({
        provider: providerFilter || undefined,
        unmappedOnly: forceReplace ? false : unmappedOnly,
        relaxOptions: {
          relaxData: !requireData,
          relaxValidity: !requireValidity,
          relaxRegion: !requireExactRegion,
        },
      });
    }
  }

  async function resumeJob(pastJob: AiMapJob) {
    setBulkResult(null);
    setJobsActionError(null);
    try {
      if (pastJob.status === 'done' || pastJob.status === 'error') {
        // Load drafts (may be partial for errored jobs) and go straight to review
        const result = await apiClient.get<{
          job: { draftsJson: AiMappingDraft[]; unmatchedSkusJson?: UnmatchedSku[] };
        }>(`/sku-mappings/ai-map/jobs/${pastJob.id}`);
        const rows: DraftRow[] = (result.job.draftsJson ?? []).map((d) => ({
          ...d,
          selected: d.confidence >= 0.8,
        }));
        setDrafts(rows);
        resetUnmatchedState();
        setUnmatchedRows((result.job.unmatchedSkusJson ?? []).map((v) => ({ ...v, selected: false })));
        setStep('review');
      } else if (pastJob.status === 'running') {
        // Reconnect to the live stream
        setStep('running');
        await job.connectToStream(pastJob.id);
      }
    } catch (err) {
      setJobsActionError(err instanceof Error ? err.message : 'Failed to resume job');
    }
  }

  async function dismissJob(id: string) {
    setDismissingId(id);
    setJobsActionError(null);
    try {
      await apiClient.delete(`/sku-mappings/ai-map/jobs/${id}`);
      void refetchJobs();
    } catch (err) {
      setJobsActionError(err instanceof Error ? err.message : 'Failed to dismiss job');
    } finally {
      setDismissingId(null);
    }
  }

  function toggleAll(select: boolean) {
    setDrafts((prev) => prev.map((d) => ({ ...d, selected: select })));
  }

  function toggleRow(idx: number) {
    setDrafts((prev) =>
      prev.map((d, i) => (i === idx ? { ...d, selected: !d.selected } : d)),
    );
  }

  function handleApprove() {
    const selected = drafts.filter((d) => d.selected);
    const inputs = selected.map((d) => {
      const packageType = d.packageType ?? 'fixed';
      return {
        shopifySku: d.shopifySku,
        provider: d.provider,
        providerCatalogId: d.catalogId,
        name: d.productName,
        region: d.region ?? undefined,
        dataAmount: d.dataAmount ?? undefined,
        validity: d.validity ?? undefined,
        packageType,
        daysCount: packageType === 'daypass' ? (d.daysCount ?? undefined) : undefined,
        isActive: true,
      };
    });
    bulkCreate.mutate(
      { inputs, forceReplace },
      {
        onSuccess: (result) => {
          setBulkResult({
            created: result.created,
            updated: result.updated ?? 0,
            skipped: result.skipped ?? 0,
            failed: result.failed,
          });
          if (result.failed === 0) {
            setStep('done');
          }
        },
      },
    );
  }

  async function handleBulkDelete() {
    const skus = unmatchedRows.filter((r) => r.selected).map((r) => r.sku);
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      const result = await apiClient.post<{
        deleted: number;
        skipped: number;
        deletedVariantIds: string[];
        errors: string[];
      }>('/shopify-skus/bulk-delete', { skus });
      setDeleteResult(result);
      const deletedIdSet = new Set(result.deletedVariantIds ?? []);
      setUnmatchedRows((prev) => prev.filter((r) => !deletedIdSet.has(r.variantId)));
      setDeleteConfirming(false);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleteLoading(false);
    }
  }

  async function handleClearMappings() {
    setClearLoading(true);
    setClearError(null);
    setClearResult(null);
    try {
      const url = providerFilter ? `/sku-mappings?provider=${providerFilter}` : '/sku-mappings';
      const result = await apiClient.delete<{ deleted: number }>(url);
      setClearResult(result);
      setClearConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ['sku-mappings'] });
      void queryClient.invalidateQueries({ queryKey: ['shopify-skus'] });
    } catch (err) {
      setClearError(err instanceof Error ? err.message : 'Failed to clear mappings');
    } finally {
      setClearLoading(false);
    }
  }

  const selectedCount = drafts.filter((d) => d.selected).length;
  const highConfidenceCount = drafts.filter((d) => d.confidence >= threshold / 100).length;
  const selectedUnmatchedCount = unmatchedRows.filter((r) => r.selected).length;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate('/sku-mappings')}
          className="p-1 rounded hover:bg-muted transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          {mode === 'ai' ? <Brain className="h-6 w-6" /> : <Cpu className="h-6 w-6" />}
          {mode === 'ai' ? 'AI Auto-Map' : 'Structured Auto-Map'}
        </h1>
      </div>

      {/* Step 1: Configure */}
      {step === 'configure' && (
        <div className="space-y-4">
          <div className="border rounded-lg p-6 space-y-5 max-w-md">
              <div className="flex rounded-md border overflow-hidden text-sm font-medium">
              <button
                onClick={() => setMode('ai')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-4 py-2 transition-colors ${mode === 'ai' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              >
                <Brain className="h-4 w-4" />
                AI
              </button>
              <button
                onClick={() => setMode('structured')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-4 py-2 transition-colors ${mode === 'structured' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              >
                <Cpu className="h-4 w-4" />
                Structured
              </button>
            </div>

            <p className="text-sm text-muted-foreground">
              {mode === 'ai'
                ? 'AI will match your Shopify SKU names to provider catalog entries based on region, data amount, and validity. Review and approve suggestions before they are saved.'
                : 'Structured matching parses SKU attributes deterministically using the catalog\'s parsed data — no AI cost, instant results. Best used after a catalog sync with parsed attributes.'}
            </p>

            <div className="space-y-1">
              <label className="text-sm font-medium">Provider</label>
              <select
                value={providerFilter}
                onChange={(e) => setProviderFilter(e.target.value)}
                className="w-full border rounded-md px-3 py-2 text-sm"
              >
                <option value="">All providers</option>
                {providers.map((p) => (
                  <option key={p} value={p}>{providerLabel(p)} only</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <input
                id="unmappedOnly"
                type="checkbox"
                checked={unmappedOnly}
                onChange={(e) => setUnmappedOnly(e.target.checked)}
              />
              <label htmlFor="unmappedOnly" className="text-sm font-medium">
                {providerFilter
                  ? `Skip SKUs already mapped to ${providerLabel(providerFilter)}`
                  : 'Skip SKUs already mapped to any provider'}
              </label>
            </div>
            {providerFilter && unmappedOnly && (
              <p className="text-xs text-muted-foreground">
                SKUs with existing {providerLabel(providerFilter)} mappings will be skipped, but SKUs
                mapped only to other providers will still be included.
              </p>
            )}

            <div className="flex items-center gap-2">
              <input
                id="forceReplace"
                type="checkbox"
                checked={forceReplace}
                onChange={(e) => setForceReplace(e.target.checked)}
              />
              <label htmlFor="forceReplace" className="text-sm font-medium">
                Replace existing mappings (re-map / fix wrong ones)
              </label>
            </div>
            {forceReplace && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                Existing mappings for the matched (SKU, provider) will be overwritten with the AI
                suggestion. Priority and lock settings are preserved.
              </p>
            )}

            <div className="space-y-2 border-t pt-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Match Requirements
              </p>
              <p className="text-xs text-muted-foreground">Region match is always required.</p>
              {mode === 'structured' && (
                <p className="text-xs text-muted-foreground">Structured mode defaults to exact country-only matches.</p>
              )}
              <div className="flex items-center gap-2">
                <input
                  id="requireData"
                  type="checkbox"
                  checked={requireData}
                  onChange={(e) => setRequireData(e.target.checked)}
                />
                <label htmlFor="requireData" className="text-sm font-medium">
                  Data amount must match
                </label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="requireValidity"
                  type="checkbox"
                  checked={requireValidity}
                  onChange={(e) => setRequireValidity(e.target.checked)}
                />
                <label htmlFor="requireValidity" className="text-sm font-medium">
                  Validity must match
                </label>
              </div>
              {mode === 'structured' && (
                <div className="flex items-center gap-2">
                  <input
                    id="requireExactRegion"
                    type="checkbox"
                    checked={requireExactRegion}
                    onChange={(e) => setRequireExactRegion(e.target.checked)}
                  />
                  <label htmlFor="requireExactRegion" className="text-sm font-medium">
                    Exact country match only (no regional/global)
                  </label>
                </div>
              )}
            </div>

            <button
              onClick={() => void runAi()}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
            >
              {mode === 'ai' ? <Brain className="h-4 w-4" /> : <Cpu className="h-4 w-4" />}
              {mode === 'ai' ? 'Run AI Mapping' : 'Run Structured Mapping'}
            </button>

            <div className="border-t pt-4 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Danger Zone
              </p>
              {!clearConfirming ? (
                <button
                  onClick={() => { setClearConfirming(true); setClearResult(null); setClearError(null); }}
                  className="text-sm text-red-600 hover:text-red-700 underline underline-offset-2"
                >
                  {providerFilter
                    ? `Clear all ${providerLabel(providerFilter)} mappings`
                    : 'Clear all mappings'}
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                    This will permanently delete{' '}
                    <strong>
                      {providerFilter ? `all ${providerLabel(providerFilter)} mappings` : 'every mapping across all providers'}
                    </strong>
                    . This cannot be undone.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void handleClearMappings()}
                      disabled={clearLoading}
                      className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 transition-colors"
                    >
                      {clearLoading ? 'Clearing...' : 'Yes, delete all'}
                    </button>
                    <button
                      onClick={() => setClearConfirming(false)}
                      disabled={clearLoading}
                      className="px-3 py-1.5 text-sm border rounded-md hover:bg-muted transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                  {clearError && <p className="text-sm text-red-600">{clearError}</p>}
                </div>
              )}
              {clearResult && (
                <p className="text-sm text-muted-foreground">
                  Cleared {clearResult.deleted} mapping{clearResult.deleted !== 1 ? 's' : ''}.
                </p>
              )}
            </div>
          </div>

          {/* Past Jobs panel */}
          <div className="border rounded-lg overflow-hidden">
            <button
              onClick={() => setPastJobsOpen((v) => !v)}
              className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors text-left"
            >
              {pastJobsOpen ? (
                <ChevronDown className="h-4 w-4 shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0" />
              )}
              Past Jobs
            </button>

            {pastJobsOpen && (
              <div className="border-t">
                {pastJobs.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-center text-muted-foreground">
                    No past jobs found.
                  </p>
                ) : (
                  <div className="divide-y">
                    {pastJobs.map((j) => (
                      <div key={j.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                        <div className="flex-1 min-w-0 space-y-0.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <JobStatusBadge status={j.status} />
                            <span className="text-muted-foreground text-xs">
                              {formatDistanceToNow(new Date(j.createdAt), { addSuffix: true })}
                            </span>
                            {j.provider && (
                              <span className="text-xs capitalize text-muted-foreground">
                                · {providerLabel(j.provider)}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {j.status === 'running' ? (
                              <>
                                Batch {j.completedBatches}
                                {j.totalBatches ? ` / ${j.totalBatches}` : ''} — {j.foundSoFar} matches
                              </>
                            ) : (
                              <>{j.foundSoFar} matches</>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {(j.status === 'done' || j.status === 'running') && (
                            <button
                              onClick={() => void resumeJob(j)}
                              className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
                            >
                              {j.status === 'done' ? 'Review' : 'View Progress'}
                            </button>
                          )}
                          {j.status === 'error' && j.foundSoFar > 0 && (
                            <button
                              onClick={() => void resumeJob(j)}
                              className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
                            >
                              Review partial
                            </button>
                          )}
                          {(j.status === 'error' || j.status === 'interrupted') && (
                            <button
                              onClick={() => void dismissJob(j.id)}
                              disabled={dismissingId === j.id}
                              className="px-3 py-1 text-xs border rounded-md hover:bg-muted transition-colors disabled:opacity-50"
                            >
                              Dismiss
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {jobsActionError && (
            <p className="text-sm text-red-600 px-1">{jobsActionError}</p>
          )}
        </div>
      )}

      {/* Step 2: Running */}
      {step === 'running' && (
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground">
          {mode === 'ai' ? <Brain className="h-10 w-10 animate-pulse" /> : <Cpu className="h-10 w-10 animate-pulse" />}
          {job.progress ? (
            <div className="text-center space-y-2">
              <p className="text-sm font-medium text-foreground">
                Batch {job.progress.batch} / {job.progress.totalBatches} — {job.progress.found} matches found
              </p>
              <div className="w-64 bg-muted rounded-full h-2">
                <div
                  className="bg-primary h-2 rounded-full transition-all"
                  style={{
                    width: job.progress.totalBatches > 0
                      ? `${Math.round((job.progress.batch / job.progress.totalBatches) * 100)}%`
                      : '0%',
                  }}
                />
              </div>
            </div>
          ) : (
            <p className="text-sm">
              {job.status === 'starting'
                ? 'Starting job…'
                : 'AI is analyzing your SKUs and matching to catalog entries…'}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            You can leave this page — the job will continue in the background.
          </p>
          <button
            onClick={() => { job.cancel(); setStep('configure'); setPastJobsOpen(true); }}
            className="px-3 py-1.5 text-sm border rounded-md hover:bg-muted transition-colors"
          >
            Leave (job continues in background)
          </button>
          {job.status === 'error' && (
            <div className="text-red-600 text-sm mt-4">
              Error: {job.error ?? 'Unknown error'}
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => setStep('configure')}
                  className="px-3 py-1.5 text-sm border rounded-md hover:bg-muted"
                >
                  Back
                </button>
                {job.drafts.length > 0 && (
                  <button
                    onClick={() => {
                      resetUnmatchedState();
                      setDrafts(job.drafts.map((d) => ({ ...d, selected: d.confidence >= 0.8 })));
                      setStep('review');
                    }}
                    className="px-3 py-1.5 text-sm border rounded-md hover:bg-muted"
                  >
                    Review {job.drafts.length} partial results
                  </button>
                )}
                <button
                  onClick={() => void runAi()}
                  className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md"
                >
                  Retry
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 3: Review */}
      {step === 'review' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm text-muted-foreground mr-auto">
              {drafts.length} suggestions — {highConfidenceCount} at ≥{threshold}%,{' '}
              {selectedCount} selected
            </div>
            <button
              onClick={() => toggleAll(true)}
              className="flex items-center gap-1 px-3 py-1.5 text-xs border rounded-md hover:bg-muted"
            >
              <CheckSquare className="h-3 w-3" />
              Select all
            </button>
            <button
              onClick={() => toggleAll(false)}
              className="flex items-center gap-1 px-3 py-1.5 text-xs border rounded-md hover:bg-muted"
            >
              <Square className="h-3 w-3" />
              Deselect all
            </button>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={100}
                value={threshold}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (!Number.isNaN(val)) setThreshold(Math.max(0, Math.min(100, val)));
                }}
                className="w-14 border rounded px-2 py-1 text-xs"
              />
              <span className="text-xs text-muted-foreground">%</span>
              <button
                onClick={() =>
                  setDrafts((prev) =>
                    prev.map((d) => ({ ...d, selected: d.confidence >= threshold / 100 })),
                  )
                }
                className="px-3 py-1.5 text-xs border rounded-md hover:bg-muted"
              >
                Select ≥{threshold}%
              </button>
            </div>
          </div>

          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full text-sm min-w-[700px]">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 w-8"></th>
                  <th className="text-left px-3 py-2 font-medium">Shopify SKU</th>
                  <th className="text-left px-3 py-2 font-medium">Provider</th>
                  <th className="text-left px-3 py-2 font-medium">Matched Product</th>
                  <th className="text-left px-3 py-2 font-medium">Region</th>
                  <th className="text-left px-3 py-2 font-medium">Data</th>
                  <th className="text-left px-3 py-2 font-medium">Validity</th>
                  <th className="text-left px-3 py-2 font-medium">Price</th>
                  <th className="text-left px-3 py-2 font-medium">Confidence</th>
                  <th className="text-left px-3 py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {drafts.map((draft, idx) => (
                  <tr
                    key={idx}
                    role="checkbox"
                    aria-checked={draft.selected}
                    tabIndex={0}
                    className={`transition-colors cursor-pointer ${
                      draft.selected ? 'bg-primary/5' : 'hover:bg-muted/20'
                    }`}
                    onClick={() => toggleRow(idx)}
                    onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleRow(idx); } }}
                  >
                    <td className="px-3 py-2" aria-hidden="true">
                      {draft.selected ? (
                        <CheckSquare className="h-4 w-4 text-primary" />
                      ) : (
                        <Square className="h-4 w-4 text-muted-foreground" />
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{draft.shopifySku}</td>
                    <td className="px-3 py-2 text-xs capitalize">{draft.provider}</td>
                    <td className="px-3 py-2 max-w-xs truncate" title={draft.productName}>
                      {draft.productName}
                    </td>
                    <td className="px-3 py-2 text-xs">{draft.region || '—'}</td>
                    <td className="px-3 py-2 text-xs">{draft.dataAmount || '—'}</td>
                    <td className="px-3 py-2 text-xs">{draft.validity || '—'}</td>
                    <td className="px-3 py-2 text-xs">
                      {draft.netPrice != null ? `$${draft.netPrice}` : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <ConfidenceBadge confidence={draft.confidence} />
                    </td>
                    <td
                      className="px-3 py-2 text-xs text-muted-foreground max-w-xs truncate"
                      title={draft.reason}
                    >
                      {draft.reason}
                    </td>
                  </tr>
                ))}
                {drafts.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">
                      No suggestions returned. All SKUs may already be mapped.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Unmatched SKUs — collapsible section */}
          {unmatchedRows.length > 0 && (
            <div className="border rounded-lg overflow-hidden">
              <button
                onClick={() => setUnmatchedOpen((v) => !v)}
                className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors text-left"
              >
                {unmatchedOpen ? (
                  <ChevronDown className="h-4 w-4 shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0" />
                )}
                <span>
                  Unmatched SKUs ({unmatchedRows.length}) — AI found no catalog match for these SKUs
                </span>
              </button>

              {unmatchedOpen && (
                <div className="border-t space-y-3 p-4">
                  {/* Select controls */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setUnmatchedRows((prev) => prev.map((r) => ({ ...r, selected: true })))}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs border rounded-md hover:bg-muted"
                    >
                      <CheckSquare className="h-3 w-3" />
                      Select all
                    </button>
                    <button
                      onClick={() => setUnmatchedRows((prev) => prev.map((r) => ({ ...r, selected: false })))}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs border rounded-md hover:bg-muted"
                    >
                      <Square className="h-3 w-3" />
                      Deselect all
                    </button>
                  </div>

                  {/* Table */}
                  <div className="border rounded overflow-x-auto">
                    <table className="w-full text-sm min-w-[500px]">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="px-3 py-2 w-8"></th>
                          <th className="text-left px-3 py-2 font-medium">SKU</th>
                          <th className="text-left px-3 py-2 font-medium">Product</th>
                          <th className="text-left px-3 py-2 font-medium">Variant</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {unmatchedRows.map((row, idx) => (
                          <tr
                            key={row.sku}
                            role="checkbox"
                            aria-checked={row.selected}
                            tabIndex={0}
                            className={`cursor-pointer transition-colors ${row.selected ? 'bg-red-50' : 'hover:bg-muted/20'}`}
                            onClick={() =>
                              setUnmatchedRows((prev) =>
                                prev.map((r, i) => (i === idx ? { ...r, selected: !r.selected } : r)),
                              )
                            }
                            onKeyDown={(e) => {
                              if (e.key === ' ' || e.key === 'Enter') {
                                e.preventDefault();
                                setUnmatchedRows((prev) =>
                                  prev.map((r, i) => (i === idx ? { ...r, selected: !r.selected } : r)),
                                );
                              }
                            }}
                          >
                            <td className="px-3 py-2" aria-hidden="true">
                              {row.selected ? (
                                <CheckSquare className="h-4 w-4 text-red-600" />
                              ) : (
                                <Square className="h-4 w-4 text-muted-foreground" />
                              )}
                            </td>
                            <td className="px-3 py-2 font-mono text-xs">{row.sku}</td>
                            <td className="px-3 py-2 text-xs">{row.productTitle}</td>
                            <td className="px-3 py-2 text-xs">{row.variantTitle}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Delete footer */}
                  <div className="flex flex-wrap items-center gap-3">
                    {!deleteConfirming ? (
                      <button
                        onClick={() => setDeleteConfirming(true)}
                        disabled={selectedUnmatchedCount === 0}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 transition-colors"
                      >
                        <Trash2 className="h-3 w-3" />
                        Delete {selectedUnmatchedCount} from Shopify
                      </button>
                    ) : (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-red-700 font-medium">
                          This permanently deletes from Shopify. Confirm?
                        </span>
                        <button
                          onClick={() => void handleBulkDelete()}
                          disabled={deleteLoading}
                          className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 transition-colors"
                        >
                          {deleteLoading ? 'Deleting…' : 'Yes, delete'}
                        </button>
                        <button
                          onClick={() => setDeleteConfirming(false)}
                          disabled={deleteLoading}
                          className="px-3 py-1.5 text-xs border rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    )}

                    {deleteResult && (
                      <span className="text-xs text-green-700">
                        Deleted {deleteResult.deleted}
                        {deleteResult.skipped > 0 && `, ${deleteResult.skipped} not found in Shopify`}
                        {deleteResult.errors.length > 0 && ` (${deleteResult.errors.length} errors)`}
                      </span>
                    )}
                    {deleteError && (
                      <span className="text-xs text-red-600">{deleteError}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-between items-center">
            <button
              onClick={() => setStep('configure')}
              className="px-4 py-2 text-sm border rounded-md hover:bg-muted transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleApprove}
              disabled={selectedCount === 0 || bulkCreate.isPending}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {bulkCreate.isPending
                ? 'Creating mappings…'
                : `Create ${selectedCount} mapping${selectedCount !== 1 ? 's' : ''}`}
            </button>
          </div>

          {bulkResult && bulkResult.failed > 0 && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              {bulkResult.created + bulkResult.updated} succeeded, {bulkResult.failed} failed. Review the
              remaining rows above and try again.
            </p>
          )}

          {bulkCreate.isError && (
            <p className="text-sm text-red-600">
              Error creating mappings:{' '}
              {bulkCreate.error instanceof Error ? bulkCreate.error.message : 'Unknown error'}
            </p>
          )}
        </div>
      )}

      {/* Step 4: Done */}
      {step === 'done' && bulkResult && (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <div className="text-5xl">✓</div>
          <p className="text-lg font-semibold">
            {bulkResult.created} created
            {bulkResult.updated > 0 && `, ${bulkResult.updated} updated`}
            {bulkResult.skipped > 0 && `, ${bulkResult.skipped} skipped`}
          </p>
          <button
            onClick={() => navigate('/sku-mappings')}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            View SKU Mappings
          </button>
        </div>
      )}
    </div>
  );
}
