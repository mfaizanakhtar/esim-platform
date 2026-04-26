import { useState, useMemo, useEffect } from 'react';
import {
  useProductTemplates,
  useGenerateTemplates,
  useGenerateSeo,
  usePushToShopify,
  useDeleteTemplate,
  type ProductTemplateSummary,
  type GenerateResult,
} from '@/hooks/useProductTemplates';
import { apiClient } from '@/lib/api';
import {
  Plus,
  Sparkles,
  Upload,
  Trash2,
  CheckCircle2,
  Clock,
  Search,
  X,
  Eye,
} from 'lucide-react';

// ─── Helpers ──────────────────────────────────────────────────────────

function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function stripHtml(html: string) {
  return html.replace(/<[^>]*>/g, '').trim();
}

// ─── Badges ───────────────────────────────────────────────────────────

function StatusBadge({ template }: { template: ProductTemplateSummary }) {
  if (template.shopifyProductId) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-800">
        <CheckCircle2 className="h-3 w-3" />
        Pushed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-600">
      <Clock className="h-3 w-3" />
      Draft
    </span>
  );
}

function SeoBadge({ hasSeo }: { hasSeo: boolean }) {
  if (hasSeo) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-purple-100 text-purple-800">
        <Sparkles className="h-3 w-3" />
        SEO
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 text-xs rounded-full bg-gray-50 text-gray-400">No SEO</span>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────

type ToastType = 'success' | 'error' | 'info';

function Toast({
  message,
  type,
  onClose,
}: {
  message: string;
  type: ToastType;
  onClose: () => void;
}) {
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
  actions,
  onClose,
}: {
  title: string;
  message: string;
  actions: Array<{
    label: string;
    onClick: () => void;
    variant?: 'primary' | 'danger' | 'default';
  }>;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-lg max-w-md w-full mx-4 p-6 space-y-4">
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-sm text-muted-foreground">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm border rounded-md hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          {actions.map((action) => {
            const cls =
              action.variant === 'primary'
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : action.variant === 'danger'
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'border hover:bg-muted';
            return (
              <button
                key={action.label}
                onClick={() => {
                  action.onClick();
                  onClose();
                }}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${cls}`}
              >
                {action.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Detail Modal ─────────────────────────────────────────────────────

interface TemplateDetail {
  countryCode: string;
  title: string;
  handle: string;
  status: string;
  vendor: string;
  tags: string[];
  descriptionHtml: string;
  seoTitle: string | null;
  seoDescription: string | null;
  imageUrl: string | null;
  shopifyProductId: string | null;
  shopifyPushedAt: string | null;
  variants: Array<{ sku: string; price: string; planType: string; validity: string; volume: string }>;
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\son\w+\s*=/gi, ' data-removed=');
}

function DetailModal({ countryCode, onClose }: { countryCode: string; onClose: () => void }) {
  const [data, setData] = useState<TemplateDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiClient
      .get<TemplateDetail>(`/product-templates/${countryCode}`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [countryCode]);

  const daypassCount = data?.variants.filter((v) => v.planType === 'Day-Pass').length ?? 0;
  const fixedCount = data?.variants.filter((v) => v.planType === 'Total Data').length ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-lg max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">
            {loading ? 'Loading...' : `${data?.title} (${data?.countryCode})`}
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="p-6 space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-6 bg-muted animate-pulse rounded" />
            ))}
          </div>
        ) : data ? (
          <div className="p-6 space-y-5 text-sm">
            {/* Meta info */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="text-muted-foreground">Status</span>
                <div className="mt-1">
                  {data.shopifyProductId ? (
                    <span className="inline-flex items-center gap-1 text-green-700">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Pushed
                    </span>
                  ) : (
                    <span className="text-gray-500">Draft</span>
                  )}
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">Vendor</span>
                <div className="mt-1 font-medium">{data.vendor}</div>
              </div>
              {data.shopifyProductId && (
                <div className="col-span-2">
                  <span className="text-muted-foreground">Shopify Product ID</span>
                  <div className="mt-1 font-mono text-xs break-all">{data.shopifyProductId}</div>
                </div>
              )}
              {data.shopifyPushedAt && (
                <div>
                  <span className="text-muted-foreground">Last pushed</span>
                  <div className="mt-1">{new Date(data.shopifyPushedAt).toLocaleString()}</div>
                </div>
              )}
            </div>

            {/* SEO */}
            <div className="space-y-2">
              <h4 className="font-medium text-muted-foreground">SEO Title</h4>
              <p className={data.seoTitle ? '' : 'text-gray-400 italic'}>
                {data.seoTitle ?? 'Not generated'}
              </p>
            </div>

            <div className="space-y-2">
              <h4 className="font-medium text-muted-foreground">SEO Description</h4>
              <p className={data.seoDescription ? '' : 'text-gray-400 italic'}>
                {data.seoDescription ?? 'Not generated'}
              </p>
            </div>

            {/* Description */}
            <div className="space-y-2">
              <h4 className="font-medium text-muted-foreground">Product Description</h4>
              <div
                className="prose prose-sm max-w-none border rounded-md p-3 bg-muted/30"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(data.descriptionHtml) }}
              />
            </div>

            {/* Tags */}
            <div className="space-y-2">
              <h4 className="font-medium text-muted-foreground">Tags</h4>
              <div className="flex flex-wrap gap-1.5">
                {(data.tags as string[]).map((tag) => (
                  <span key={tag} className="px-2 py-0.5 text-xs bg-muted rounded-full">
                    {tag}
                  </span>
                ))}
              </div>
            </div>

            {/* Variants summary */}
            <div className="space-y-2">
              <h4 className="font-medium text-muted-foreground">Variants</h4>
              <p>
                {data.variants.length} total — {daypassCount} Day-Pass, {fixedCount} Total Data
              </p>
            </div>

            {/* Image */}
            {data.imageUrl && (
              <div className="space-y-2">
                <h4 className="font-medium text-muted-foreground">Product Image</h4>
                <img
                  src={data.imageUrl}
                  alt={`${data.title} flag`}
                  className="h-16 rounded border"
                />
              </div>
            )}
          </div>
        ) : (
          <div className="p-6 text-muted-foreground">Template not found.</div>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────

export function ProductTemplates() {
  const { data, isLoading } = useProductTemplates();
  const generateMutation = useGenerateTemplates();
  const seoMutation = useGenerateSeo();
  const pushMutation = usePushToShopify();
  const deleteMutation = useDeleteTemplate();

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    message: string;
    actions: Array<{ label: string; onClick: () => void; variant?: 'primary' | 'danger' | 'default' }>;
  } | null>(null);
  const [detailCode, setDetailCode] = useState<string | null>(null);

  const templates = data?.templates ?? [];
  const totalCount = data?.total ?? 0;
  const pushedCount = templates.filter((t) => t.shopifyProductId).length;
  const unpushedCount = totalCount - pushedCount;
  const seoCount = templates.filter((t) => t.hasSeo).length;
  const missingSeoCount = totalCount - seoCount;

  const filtered = useMemo(
    () =>
      search
        ? templates.filter(
            (t) =>
              t.title.toLowerCase().includes(search.toLowerCase()) ||
              t.countryCode.toLowerCase().includes(search.toLowerCase()),
          )
        : templates,
    [templates, search],
  );

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((t) => selected.has(t.countryCode));

  const selectedCodes = [...selected];
  const anyPending =
    generateMutation.isPending || seoMutation.isPending || pushMutation.isPending || deleteMutation.isPending;

  function toggleSelect(code: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function toggleSelectAll() {
    if (allFilteredSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const t of filtered) next.delete(t.countryCode);
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const t of filtered) next.add(t.countryCode);
        return next;
      });
    }
  }

  function showToast(message: string, type: ToastType = 'info') {
    setToast({ message, type });
    if (type !== 'error') setTimeout(() => setToast(null), 8000);
  }

  // ─── Global action handlers ─────────────────────────────────────

  /**
   * Produce a single toast string from the combined-or-legacy generate response.
   * Combined response (no `templateType` in request) has `country` and `region`
   * blocks; explicit-mode responses have flat fields.
   */
  function summarizeGenerate(d: GenerateResult, verb: 'Generated' | 'Regenerated'): string {
    if (d.country || d.region) {
      const cGen = d.country?.generated ?? 0;
      const rGen = d.region?.generated ?? 0;
      const rSkipped = d.region?.skippedNoCoverage ?? 0;
      const main = `${verb} ${cGen} country + ${rGen} region templates`;
      const tail =
        rSkipped > 0
          ? ` (${rSkipped} region${rSkipped === 1 ? '' : 's'} skipped — no provider coverage)`
          : '';
      return main + tail;
    }
    return `${verb} ${d.generated ?? 0} templates`;
  }

  function generatedAny(d: GenerateResult): boolean {
    if (d.country || d.region) {
      return (d.country?.generated ?? 0) + (d.region?.generated ?? 0) > 0;
    }
    return (d.generated ?? 0) > 0;
  }

  function handleGenerateAll() {
    if (totalCount === 0) {
      setConfirm({
        title: 'Generate Templates',
        message:
          'Generate product templates for all countries from the catalog AND every active region?',
        actions: [
          {
            label: 'Generate',
            variant: 'primary',
            onClick: () =>
              generateMutation.mutate(
                {},
                {
                  onSuccess: (d) => showToast(summarizeGenerate(d, 'Generated'), 'success'),
                  onError: (e) => showToast(`Failed: ${(e as Error).message}`, 'error'),
                },
              ),
          },
        ],
      });
    } else {
      setConfirm({
        title: 'Generate Templates',
        message: `${totalCount} templates already exist. Generate new ones only, or regenerate all? Regenerating will reset prices and variants. (Both country and region templates are included.)`,
        actions: [
          {
            label: 'New Only',
            variant: 'default',
            onClick: () =>
              generateMutation.mutate(
                { overwrite: false },
                {
                  onSuccess: (d) =>
                    showToast(
                      generatedAny(d)
                        ? summarizeGenerate(d, 'Generated')
                        : 'No new templates to generate',
                      generatedAny(d) ? 'success' : 'info',
                    ),
                  onError: (e) => showToast(`Failed: ${(e as Error).message}`, 'error'),
                },
              ),
          },
          {
            label: 'Regenerate All',
            variant: 'primary',
            onClick: () =>
              generateMutation.mutate(
                { overwrite: true },
                {
                  onSuccess: (d) => showToast(summarizeGenerate(d, 'Regenerated'), 'success'),
                  onError: (e) => showToast(`Failed: ${(e as Error).message}`, 'error'),
                },
              ),
          },
        ],
      });
    }
  }

  function handleGenerateAllSeo() {
    if (missingSeoCount === 0) {
      showToast('All templates already have SEO. Select specific templates below to regenerate.', 'info');
      return;
    }
    setConfirm({
      title: 'Generate SEO',
      message: `Generate AI SEO descriptions for ${missingSeoCount} template(s) that don't have SEO yet. This runs in the background.`,
      actions: [
        {
          label: 'Generate',
          variant: 'primary',
          onClick: () =>
            seoMutation.mutate(
              {},
              {
                onSuccess: (d) =>
                  showToast(
                    d.queued > 0 ? `Generating SEO for ${d.queued} templates in background` : 'All done',
                    'info',
                  ),
                onError: (e) => showToast(`Failed: ${(e as Error).message}`, 'error'),
              },
            ),
        },
      ],
    });
  }

  function handlePushAll() {
    if (unpushedCount === 0) {
      showToast('All templates are already pushed. Select specific templates below to re-push.', 'info');
      return;
    }
    setConfirm({
      title: 'Push to Shopify',
      message: `Push ${unpushedCount} unpushed template(s) to Shopify? This creates products in the background.`,
      actions: [
        {
          label: 'Push',
          variant: 'primary',
          onClick: () =>
            pushMutation.mutate(
              { force: false },
              {
                onSuccess: (d) =>
                  showToast(d.total > 0 ? `Pushing ${d.total} template(s) to Shopify` : 'Nothing to push', 'info'),
                onError: (e) => showToast(`Failed: ${(e as Error).message}`, 'error'),
              },
            ),
        },
      ],
    });
  }

  // ─── Selection action handlers ──────────────────────────────────

  function handlePushSelected() {
    setConfirm({
      title: 'Push Selected to Shopify',
      message: `Re-push ${selectedCodes.length} selected template(s) to Shopify? Existing products will be deleted and recreated.`,
      actions: [
        {
          label: 'Push',
          variant: 'primary',
          onClick: () =>
            pushMutation.mutate(
              { countries: selectedCodes, force: true },
              {
                onSuccess: (d) => {
                  showToast(`Pushing ${d.total} template(s) to Shopify`, 'info');
                  setSelected(new Set());
                },
                onError: (e) => showToast(`Failed: ${(e as Error).message}`, 'error'),
              },
            ),
        },
      ],
    });
  }

  function handleRegenerateSeoSelected() {
    setConfirm({
      title: 'Regenerate SEO',
      message: `Regenerate AI SEO for ${selectedCodes.length} selected template(s)? This will overwrite existing SEO content.`,
      actions: [
        {
          label: 'Regenerate',
          variant: 'primary',
          onClick: () =>
            seoMutation.mutate(
              { countries: selectedCodes, force: true },
              {
                onSuccess: (d) => {
                  showToast(
                    d.queued > 0 ? `Regenerating SEO for ${d.queued} template(s)` : 'Done',
                    'info',
                  );
                  setSelected(new Set());
                },
                onError: (e) => showToast(`Failed: ${(e as Error).message}`, 'error'),
              },
            ),
        },
      ],
    });
  }

  function handleDeleteSelected() {
    setConfirm({
      title: 'Delete Templates',
      message: `Delete ${selectedCodes.length} template(s) from the database? This does NOT delete products from Shopify.`,
      actions: [
        {
          label: 'Delete',
          variant: 'danger',
          onClick: () => {
            let done = 0;
            let failed = 0;
            for (const code of selectedCodes) {
              deleteMutation.mutate(code, {
                onSuccess: () => {
                  done++;
                  if (done + failed === selectedCodes.length) {
                    showToast(`Deleted ${done} template(s)`, failed ? 'error' : 'success');
                    setSelected(new Set());
                  }
                },
                onError: () => {
                  failed++;
                  if (done + failed === selectedCodes.length) {
                    showToast(`Deleted ${done}, ${failed} failed`, 'error');
                    setSelected(new Set());
                  }
                },
              });
            }
          },
        },
      ],
    });
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Product Templates</h1>
        <p className="text-muted-foreground mt-1">
          Generate templates, enrich with AI SEO, then push to Shopify.
        </p>
      </div>

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {/* Confirm dialog */}
      {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}

      {/* Detail modal */}
      {detailCode && <DetailModal countryCode={detailCode} onClose={() => setDetailCode(null)} />}

      {/* Zone 1: Global actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={handleGenerateAll}
          disabled={anyPending}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          <Plus className={`h-4 w-4 ${generateMutation.isPending ? 'animate-pulse' : ''}`} />
          {generateMutation.isPending ? 'Generating...' : 'Generate All Templates'}
        </button>

        <button
          onClick={handleGenerateAllSeo}
          disabled={anyPending}
          className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
        >
          <Sparkles className={`h-4 w-4 ${seoMutation.isPending ? 'animate-pulse' : ''}`} />
          {seoMutation.isPending ? 'Generating SEO...' : 'Generate All SEO'}
        </button>

        <button
          onClick={handlePushAll}
          disabled={anyPending}
          className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
        >
          <Upload className={`h-4 w-4 ${pushMutation.isPending ? 'animate-pulse' : ''}`} />
          {pushMutation.isPending ? 'Pushing...' : 'Push All to Shopify'}
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
        {totalCount > 0 && (
          <div className="flex gap-3 text-sm text-muted-foreground">
            <span>
              <span className="font-medium text-foreground">{totalCount}</span> templates
            </span>
            <span>·</span>
            <span>
              <span className="font-medium text-foreground">{pushedCount}</span> pushed
            </span>
            <span>·</span>
            <span>
              <span className="font-medium text-foreground">{seoCount}</span> with SEO
            </span>
          </div>
        )}
      </div>

      {/* Zone 3: Selection toolbar */}
      {selectedCodes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 bg-primary/5 border border-primary/20 rounded-md">
          <span className="text-sm font-medium mr-2">{selectedCodes.length} selected</span>
          <button
            onClick={handlePushSelected}
            disabled={anyPending}
            className="flex items-center gap-1.5 px-2.5 py-1 text-sm border rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
          >
            <Upload className="h-3.5 w-3.5" />
            Push Selected
          </button>
          <button
            onClick={handleRegenerateSeoSelected}
            disabled={anyPending}
            className="flex items-center gap-1.5 px-2.5 py-1 text-sm border rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Regenerate SEO
          </button>
          <button
            onClick={handleDeleteSelected}
            disabled={anyPending}
            className="flex items-center gap-1.5 px-2.5 py-1 text-sm border border-red-200 text-red-700 rounded-md hover:bg-red-50 disabled:opacity-50 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* Zone 4: Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 bg-muted animate-pulse rounded-md" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {search
            ? 'No templates match your search'
            : 'No templates yet. Click "Generate All Templates" to create them.'}
        </div>
      ) : (
        <div className="border rounded-md overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-3 py-2 w-10">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleSelectAll}
                    className="rounded"
                  />
                </th>
                <th className="text-left px-3 py-2 font-medium">Country</th>
                <th className="text-left px-3 py-2 font-medium">Variants</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium">SEO</th>
                <th className="text-left px-3 py-2 font-medium">SEO Title</th>
                <th className="text-left px-3 py-2 font-medium">Description</th>
                <th className="text-left px-3 py-2 font-medium">Tags</th>
                <th className="px-3 py-2 w-10" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const descPreview = t.seoDescription
                  ? truncate(stripHtml(t.seoDescription), 30)
                  : '';

                return (
                  <tr
                    key={t.countryCode}
                    className={`border-b last:border-0 hover:bg-muted/30 transition-colors ${
                      selected.has(t.countryCode) ? 'bg-primary/5' : ''
                    }`}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(t.countryCode)}
                        onChange={() => toggleSelect(t.countryCode)}
                        className="rounded"
                      />
                    </td>
                    <td className="px-3 py-2 font-medium">
                      <span className="flex items-center gap-2">
                        <img
                          src={`https://flagcdn.com/w20/${t.countryCode.toLowerCase()}.png`}
                          alt=""
                          className="h-4 rounded-sm"
                        />
                        {t.title}
                        <span className="text-muted-foreground font-normal">({t.countryCode})</span>
                      </span>
                    </td>
                    <td className="px-3 py-2">{t.variantCount}</td>
                    <td className="px-3 py-2">
                      <StatusBadge template={t} />
                    </td>
                    <td className="px-3 py-2">
                      <SeoBadge hasSeo={t.hasSeo} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground max-w-[180px]">
                      <span className="block truncate">
                        {t.seoTitle ?? '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground max-w-[160px]">
                      <span className="block truncate">{descPreview || '—'}</span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {(t.tags as string[]).slice(0, 3).map((tag) => (
                          <span key={tag} className="px-1.5 py-0.5 text-xs bg-muted rounded">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => setDetailCode(t.countryCode)}
                        className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                        title="View details"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
