import { useState, useEffect } from 'react';
import { X, CheckSquare, Square, Loader2 } from 'lucide-react';
import type { ShopifySku, SkuMapping, AiMappingDraft } from '@/lib/types';
import { MappingForm } from './MappingForm';
import { useCreateSkuMapping, useBulkCreateMappings } from '@/hooks/useSkuMappingMutations';
import { useAiMapJob } from '@/hooks/useAiMapJob';
import { apiClient } from '@/lib/api';

type Tab = 'manual' | 'structured' | 'ai';

interface StructuredRelaxOptions {
  relaxValidity: boolean;
  relaxData: boolean;
}

interface DraftRow extends AiMappingDraft {
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

interface SkuMappingModalProps {
  sku: ShopifySku;
  existingMappings: SkuMapping[];
  onClose: () => void;
  onSaved: () => void;
}

export function SkuMappingModal({ sku, existingMappings, onClose, onSaved }: SkuMappingModalProps) {
  const [tab, setTab] = useState<Tab>('structured');

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-xl bg-white shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
          <div>
            <h2 className="text-base font-semibold">Map SKU</h2>
            <p className="text-xs font-mono text-muted-foreground mt-0.5">{sku.sku}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Existing mappings */}
        {existingMappings.length > 0 && (
          <div className="px-5 py-2 bg-muted/30 border-b text-xs text-muted-foreground">
            Already mapped to:{' '}
            {existingMappings.map((m) => (
              <span
                key={m.id}
                className="inline-block mr-1 px-1.5 py-0.5 bg-white border rounded font-medium capitalize"
              >
                {m.provider}
              </span>
            ))}
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b shrink-0">
          {(['structured', 'ai', 'manual'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors capitalize ${
                tab === t
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t === 'structured' ? 'Structured' : t === 'ai' ? 'AI' : 'Manual'}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'manual' && (
            <ManualTab sku={sku} existingMappings={existingMappings} onSaved={onSaved} onClose={onClose} />
          )}
          {tab === 'structured' && (
            <StructuredTab sku={sku} onSaved={onSaved} />
          )}
          {tab === 'ai' && (
            <AiTab sku={sku} onSaved={onSaved} />
          )}
        </div>
      </div>
    </div>
  );
}

function ManualTab({
  sku,
  existingMappings,
  onSaved,
  onClose,
}: {
  sku: ShopifySku;
  existingMappings: SkuMapping[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const createMutation = useCreateSkuMapping();

  function handleSubmit(values: Parameters<typeof createMutation.mutate>[0]) {
    createMutation.mutate(values, { onSuccess: onSaved });
  }

  return (
    <MappingForm
      lockedSku={sku.sku}
      existingMappings={existingMappings}
      onSubmit={handleSubmit}
      onCancel={onClose}
      isPending={createMutation.isPending}
    />
  );
}

function StructuredTab({ sku, onSaved }: { sku: ShopifySku; onSaved: () => void }) {
  const [relaxOptions, setRelaxOptions] = useState<StructuredRelaxOptions>({
    relaxValidity: false,
    relaxData: false,
  });
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bulkCreate = useBulkCreateMappings();

  async function fetchMatches(opts: StructuredRelaxOptions) {
    setLoading(true);
    setError(null);
    try {
      const result = await apiClient.post<{ drafts: AiMappingDraft[] }>(
        '/sku-mappings/structured-match',
        {
          sku: sku.sku,
          relaxOptions: { relaxValidity: opts.relaxValidity, relaxData: opts.relaxData },
        },
      );
      setDrafts((result.drafts ?? []).map((d) => ({ ...d, selected: d.confidence >= 1.0 })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch matches');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchMatches(relaxOptions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleRelax(key: keyof StructuredRelaxOptions) {
    const next = { ...relaxOptions, [key]: !relaxOptions[key] };
    setRelaxOptions(next);
    void fetchMatches(next);
  }

  function handleSave() {
    const selected = drafts.filter((d) => d.selected);
    bulkCreate.mutate(
      {
        inputs: selected.map((d) => ({
          shopifySku: d.shopifySku,
          provider: d.provider,
          providerCatalogId: d.catalogId,
          name: d.productName,
          region: d.region ?? undefined,
          dataAmount: d.dataAmount ?? undefined,
          validity: d.validity ?? undefined,
          isActive: true,
        })),
        forceReplace: false,
      },
      { onSuccess: onSaved },
    );
  }

  const selectedCount = drafts.filter((d) => d.selected).length;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Region match is always required.</p>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={relaxOptions.relaxData}
            onChange={() => toggleRelax('relaxData')}
          />
          Relax data amount (accept any data size)
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={relaxOptions.relaxValidity}
            onChange={() => toggleRelax('relaxValidity')}
          />
          Relax validity (accept any validity period)
        </label>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          Finding matches…
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {!loading && drafts.length === 0 && !error && (
        <p className="text-sm text-muted-foreground py-4">
          No structured matches found. Try relaxing the options above, or use the AI tab.
        </p>
      )}

      {!loading && drafts.length > 0 && (
        <>
          <div className="border rounded overflow-x-auto">
            <table className="w-full text-sm min-w-[420px]">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 w-8"></th>
                  <th className="text-left px-3 py-2 font-medium">Provider</th>
                  <th className="text-left px-3 py-2 font-medium">Product</th>
                  <th className="text-left px-3 py-2 font-medium">Data</th>
                  <th className="text-left px-3 py-2 font-medium">Validity</th>
                  <th className="text-left px-3 py-2 font-medium">Confidence</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {drafts.map((draft, idx) => (
                  <tr
                    key={`${draft.catalogId}-${draft.provider}`}
                    role="checkbox"
                    aria-checked={draft.selected}
                    tabIndex={0}
                    className={`cursor-pointer transition-colors ${
                      draft.selected ? 'bg-primary/5' : 'hover:bg-muted/20'
                    }`}
                    onClick={() =>
                      setDrafts((prev) =>
                        prev.map((d, i) => (i === idx ? { ...d, selected: !d.selected } : d)),
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault();
                        setDrafts((prev) =>
                          prev.map((d, i) => (i === idx ? { ...d, selected: !d.selected } : d)),
                        );
                      }
                    }}
                  >
                    <td className="px-3 py-2" aria-hidden="true">
                      {draft.selected ? (
                        <CheckSquare className="h-4 w-4 text-primary" />
                      ) : (
                        <Square className="h-4 w-4 text-muted-foreground" />
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs capitalize">{draft.provider}</td>
                    <td className="px-3 py-2 max-w-[180px] truncate text-xs" title={draft.productName}>
                      {draft.productName}
                    </td>
                    <td className="px-3 py-2 text-xs">{draft.dataAmount ?? '—'}</td>
                    <td className="px-3 py-2 text-xs">{draft.validity ?? '—'}</td>
                    <td className="px-3 py-2">
                      <ConfidenceBadge confidence={draft.confidence} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={selectedCount === 0 || bulkCreate.isPending}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {bulkCreate.isPending
                ? 'Saving…'
                : `Save ${selectedCount} mapping${selectedCount !== 1 ? 's' : ''}`}
            </button>
          </div>

          {bulkCreate.isError && (
            <p className="text-sm text-red-600">
              {bulkCreate.error instanceof Error ? bulkCreate.error.message : 'Save failed'}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function AiTab({ sku, onSaved }: { sku: ShopifySku; onSaved: () => void }) {
  const job = useAiMapJob();
  const bulkCreate = useBulkCreateMappings();
  const [drafts, setDrafts] = useState<DraftRow[]>([]);

  useEffect(() => {
    if (job.status === 'done') {
      setDrafts(job.drafts.map((d) => ({ ...d, selected: d.confidence >= 0.8 })));
    }
  }, [job.status, job.drafts]);

  function handleSave() {
    const selected = drafts.filter((d) => d.selected);
    bulkCreate.mutate(
      {
        inputs: selected.map((d) => ({
          shopifySku: d.shopifySku,
          provider: d.provider,
          providerCatalogId: d.catalogId,
          name: d.productName,
          region: d.region ?? undefined,
          dataAmount: d.dataAmount ?? undefined,
          validity: d.validity ?? undefined,
          isActive: true,
        })),
        forceReplace: false,
      },
      { onSuccess: onSaved },
    );
  }

  const selectedCount = drafts.filter((d) => d.selected).length;

  if (job.status === 'idle') {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-muted-foreground">
        <p className="text-sm">AI will search for the best catalog match for this SKU.</p>
        <button
          onClick={() => void job.start({ shopifySkus: [sku.sku], unmappedOnly: false })}
          className="flex items-center gap-2 px-4 py-2 text-sm border rounded-md hover:bg-muted transition-colors"
        >
          Run AI Match
        </button>
      </div>
    );
  }

  if (job.status === 'starting' || job.status === 'running') {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p className="text-sm">
          {job.progress
            ? `Batch ${job.progress.batch} / ${job.progress.totalBatches} — ${job.progress.found} matches`
            : 'Starting AI match…'}
        </p>
      </div>
    );
  }

  if (job.status === 'error') {
    return (
      <div className="py-6 space-y-3">
        <p className="text-sm text-red-600">AI matching failed: {job.error}</p>
        {drafts.length > 0 && (
          <p className="text-xs text-muted-foreground">Partial results below.</p>
        )}
        <button
          onClick={() => void job.start({ shopifySkus: [sku.sku], unmappedOnly: false })}
          className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md"
        >
          Retry
        </button>
      </div>
    );
  }

  if (job.status === 'done' && drafts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-6">
        AI found no catalog matches for this SKU. Try the Structured tab with relaxed options.
      </p>
    );
  }

  if (job.status === 'done') {
    return (
      <div className="space-y-4">
        <div className="border rounded overflow-x-auto">
          <table className="w-full text-sm min-w-[420px]">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-3 py-2 w-8"></th>
                <th className="text-left px-3 py-2 font-medium">Provider</th>
                <th className="text-left px-3 py-2 font-medium">Product</th>
                <th className="text-left px-3 py-2 font-medium">Data</th>
                <th className="text-left px-3 py-2 font-medium">Validity</th>
                <th className="text-left px-3 py-2 font-medium">Confidence</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {drafts.map((draft, idx) => (
                <tr
                  key={`${draft.catalogId}-${draft.provider}`}
                  role="checkbox"
                  aria-checked={draft.selected}
                  tabIndex={0}
                  className={`cursor-pointer transition-colors ${
                    draft.selected ? 'bg-primary/5' : 'hover:bg-muted/20'
                  }`}
                  onClick={() =>
                    setDrafts((prev) =>
                      prev.map((d, i) => (i === idx ? { ...d, selected: !d.selected } : d)),
                    )
                  }
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault();
                      setDrafts((prev) =>
                        prev.map((d, i) => (i === idx ? { ...d, selected: !d.selected } : d)),
                      );
                    }
                  }}
                >
                  <td className="px-3 py-2" aria-hidden="true">
                    {draft.selected ? (
                      <CheckSquare className="h-4 w-4 text-primary" />
                    ) : (
                      <Square className="h-4 w-4 text-muted-foreground" />
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs capitalize">{draft.provider}</td>
                  <td className="px-3 py-2 max-w-[180px] truncate text-xs" title={draft.productName}>
                    {draft.productName}
                  </td>
                  <td className="px-3 py-2 text-xs">{draft.dataAmount ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">{draft.validity ?? '—'}</td>
                  <td className="px-3 py-2">
                    <ConfidenceBadge confidence={draft.confidence} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={selectedCount === 0 || bulkCreate.isPending}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {bulkCreate.isPending
              ? 'Saving…'
              : `Save ${selectedCount} mapping${selectedCount !== 1 ? 's' : ''}`}
          </button>
        </div>

        {bulkCreate.isError && (
          <p className="text-sm text-red-600">
            {bulkCreate.error instanceof Error ? bulkCreate.error.message : 'Save failed'}
          </p>
        )}
      </div>
    );
  }

  return null;
}
