import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { useBulkCreateMappings } from '@/hooks/useSkuMappingMutations';
import { useProviders, providerLabel } from '@/hooks/useProviders';
import type { AiMappingDraft } from '@/lib/types';
import { ArrowLeft, Brain, CheckSquare, Square } from 'lucide-react';

interface AiMapResponse {
  drafts: AiMappingDraft[];
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

export function AiMap() {
  const navigate = useNavigate();

  // Step 1 config
  const { data: providersData } = useProviders();
  const providers = providersData?.providers ?? [];

  const [providerFilter, setProviderFilter] = useState('');
  const [forceReplace, setForceReplace] = useState(false);
  const [unmappedOnly, setUnmappedOnly] = useState(true);

  // Steps: configure | running | review | done
  const [step, setStep] = useState<'configure' | 'running' | 'review' | 'done'>('configure');
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [createdCount, setCreatedCount] = useState(0);

  const aiMapMutation = useMutation({
    mutationFn: () =>
      apiClient.post<AiMapResponse>('/sku-mappings/ai-map', {
        provider: providerFilter || undefined,
        // forceReplace implies we want to see all SKUs, including already-mapped ones
        unmappedOnly: forceReplace ? false : unmappedOnly,
      }),
    onSuccess: (data) => {
      const rows: DraftRow[] = data.drafts.map((d) => ({
        ...d,
        selected: d.confidence >= 0.8,
      }));
      setDrafts(rows);
      setStep('review');
    },
  });

  const bulkCreate = useBulkCreateMappings();

  function runAi() {
    setStep('running');
    aiMapMutation.mutate();
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
    const inputs = selected.map((d) => ({
      shopifySku: d.shopifySku,
      provider: d.provider, // each draft carries the provider from the matched catalog entry
      providerCatalogId: d.catalogId,
      name: d.productName,
      region: d.region,
      dataAmount: d.dataAmount,
      validity: d.validity,
      isActive: true,
    }));
    bulkCreate.mutate(
      { inputs, forceReplace },
      {
        onSuccess: (result) => {
          setCreatedCount(result.created);
          setStep('done');
        },
      },
    );
  }

  const selectedCount = drafts.filter((d) => d.selected).length;
  const highConfidenceCount = drafts.filter((d) => d.confidence >= 0.8).length;

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
          <Brain className="h-6 w-6" />
          AI Auto-Map
        </h1>
      </div>

      {/* Step 1: Configure */}
      {step === 'configure' && (
        <div className="border rounded-lg p-6 space-y-5 max-w-md">
          <p className="text-sm text-muted-foreground">
            AI will match your Shopify SKU names to provider catalog entries based on region, data
            amount, and validity. Review and approve suggestions before they are saved.
            <br />
            <span className="mt-1 inline-block">
              Tip: select a specific provider to add that provider&apos;s mappings to SKUs that are
              already mapped elsewhere — existing mappings are never overwritten.
            </span>
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

          <button
            onClick={runAi}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            <Brain className="h-4 w-4" />
            Run AI Mapping
          </button>
        </div>
      )}

      {/* Step 2: Running */}
      {step === 'running' && (
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground">
          <Brain className="h-10 w-10 animate-pulse" />
          <p className="text-sm">AI is analyzing your SKUs and matching to catalog entries…</p>
          {aiMapMutation.isError && (
            <div className="text-red-600 text-sm mt-4">
              Error: {aiMapMutation.error instanceof Error ? aiMapMutation.error.message : 'Unknown error'}
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => setStep('configure')}
                  className="px-3 py-1.5 text-sm border rounded-md hover:bg-muted"
                >
                  Back
                </button>
                <button
                  onClick={runAi}
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
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              {drafts.length} suggestions — {highConfidenceCount} high confidence (≥80%),{' '}
              {selectedCount} selected
            </div>
            <div className="flex items-center gap-2">
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
              <button
                onClick={() =>
                  setDrafts((prev) => prev.map((d) => ({ ...d, selected: d.confidence >= 0.8 })))
                }
                className="px-3 py-1.5 text-xs border rounded-md hover:bg-muted"
              >
                High confidence only
              </button>
            </div>
          </div>

          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
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

          {bulkCreate.isError && (
            <p className="text-sm text-red-600">
              Error creating mappings:{' '}
              {bulkCreate.error instanceof Error ? bulkCreate.error.message : 'Unknown error'}
            </p>
          )}
        </div>
      )}

      {/* Step 4: Done */}
      {step === 'done' && (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <div className="text-5xl">✓</div>
          <p className="text-lg font-semibold">
            {createdCount} mapping{createdCount !== 1 ? 's' : ''}{' '}
            {forceReplace ? 'created or updated' : 'created'} successfully
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
