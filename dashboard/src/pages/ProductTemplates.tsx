import { useState, useMemo } from 'react';
import {
  useProductTemplates,
  useGenerateTemplates,
  useGenerateSeo,
  usePushToShopify,
  useDeleteTemplate,
  type ProductTemplateSummary,
} from '@/hooks/useProductTemplates';
import {
  Plus,
  Sparkles,
  Upload,
  Trash2,
  CheckCircle2,
  Clock,
  Search,
  X,
} from 'lucide-react';

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

export function ProductTemplates() {
  const { data, isLoading } = useProductTemplates();
  const generateMutation = useGenerateTemplates();
  const seoMutation = useGenerateSeo();
  const pushMutation = usePushToShopify();
  const deleteMutation = useDeleteTemplate();

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [overwrite, setOverwrite] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);

  const templates = data?.templates ?? [];
  const totalCount = data?.total ?? 0;
  const pushedCount = templates.filter((t) => t.shopifyProductId).length;
  const seoCount = templates.filter((t) => t.hasSeo).length;

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
    if (type !== 'error') {
      setTimeout(() => setToast(null), 8000);
    }
  }

  const selectedCodes = [...selected];
  const anyPending =
    generateMutation.isPending || seoMutation.isPending || pushMutation.isPending || deleteMutation.isPending;

  function handleGenerate() {
    generateMutation.mutate(
      { overwrite },
      {
        onSuccess: (data) => {
          showToast(
            `Generated ${data.generated} templates (${data.skippedExisting} skipped)${data.errors.length ? ` — ${data.errors.length} errors` : ''}`,
            data.errors.length ? 'error' : 'success',
          );
        },
        onError: (err) => showToast(`Generate failed: ${(err as Error).message}`, 'error'),
      },
    );
  }

  function handleGenerateSeo() {
    const input = selectedCodes.length > 0 ? { countries: selectedCodes } : {};
    seoMutation.mutate(input, {
      onSuccess: (data) => {
        if (data.queued > 0) {
          showToast(`Generating SEO for ${data.queued} templates in background`, 'info');
        } else {
          showToast(data.message ?? 'All templates already have SEO', 'success');
        }
        setSelected(new Set());
      },
      onError: (err) => showToast(`SEO generation failed: ${(err as Error).message}`, 'error'),
    });
  }

  function handlePush() {
    const input =
      selectedCodes.length > 0
        ? { countries: selectedCodes, force: true }
        : { force: false };
    pushMutation.mutate(input, {
      onSuccess: (data) => {
        if (data.total > 0) {
          showToast(`Pushing ${data.total} template(s) to Shopify in background`, 'info');
        } else {
          showToast(data.message ?? 'No templates to push', 'success');
        }
        setSelected(new Set());
      },
      onError: (err) => showToast(`Push failed: ${(err as Error).message}`, 'error'),
    });
  }

  function handleDeleteSelected() {
    if (!confirm(`Delete ${selectedCodes.length} template(s)? This does not delete from Shopify.`)) return;
    let done = 0;
    let failed = 0;
    for (const code of selectedCodes) {
      deleteMutation.mutate(code, {
        onSuccess: () => {
          done++;
          if (done + failed === selectedCodes.length) {
            showToast(`Deleted ${done} template(s)${failed ? `, ${failed} failed` : ''}`, failed ? 'error' : 'success');
            setSelected(new Set());
          }
        },
        onError: () => {
          failed++;
          if (done + failed === selectedCodes.length) {
            showToast(`Deleted ${done} template(s), ${failed} failed`, 'error');
            setSelected(new Set());
          }
        },
      });
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Product Templates</h1>
        <p className="text-muted-foreground mt-1">
          Generate templates, enrich with AI SEO, then push to Shopify.
        </p>
      </div>

      {/* Toast notification */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {/* Top action bar */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleGenerate}
            disabled={anyPending}
            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            <Plus className={`h-4 w-4 ${generateMutation.isPending ? 'animate-pulse' : ''}`} />
            {generateMutation.isPending ? 'Generating...' : 'Generate Templates'}
          </button>

          <button
            onClick={handleGenerateSeo}
            disabled={anyPending}
            className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
          >
            <Sparkles className={`h-4 w-4 ${seoMutation.isPending ? 'animate-pulse' : ''}`} />
            {seoMutation.isPending
              ? 'Generating SEO...'
              : selectedCodes.length > 0
                ? `Generate SEO (${selectedCodes.length})`
                : 'Generate SEO'}
          </button>

          <button
            onClick={handlePush}
            disabled={anyPending}
            className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
          >
            <Upload className={`h-4 w-4 ${pushMutation.isPending ? 'animate-pulse' : ''}`} />
            {pushMutation.isPending
              ? 'Pushing...'
              : selectedCodes.length > 0
                ? `Push to Shopify (${selectedCodes.length})`
                : 'Push to Shopify'}
          </button>

          {selectedCodes.length > 0 && (
            <button
              onClick={handleDeleteSelected}
              disabled={anyPending}
              className="flex items-center gap-2 px-3 py-1.5 text-sm border border-red-200 text-red-700 rounded-md hover:bg-red-50 disabled:opacity-50 transition-colors"
            >
              <Trash2 className="h-4 w-4" />
              Delete ({selectedCodes.length})
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              className="rounded"
            />
            Overwrite existing
          </label>
        </div>
      </div>

      {/* Selection bar */}
      {selectedCodes.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-2 bg-primary/5 border border-primary/20 rounded-md text-sm">
          <span className="font-medium">{selectedCodes.length} selected</span>
          <button
            onClick={() => setSelected(new Set())}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* Stats */}
      {totalCount > 0 && (
        <div className="flex gap-4 text-sm">
          <div className="px-3 py-2 bg-muted rounded-md">
            <span className="font-medium">{totalCount}</span>{' '}
            <span className="text-muted-foreground">templates</span>
          </div>
          <div className="px-3 py-2 bg-muted rounded-md">
            <span className="font-medium">{pushedCount}</span>{' '}
            <span className="text-muted-foreground">pushed</span>
          </div>
          <div className="px-3 py-2 bg-muted rounded-md">
            <span className="font-medium">{seoCount}</span>{' '}
            <span className="text-muted-foreground">with SEO</span>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search countries..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Table */}
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
            : 'No templates yet. Click "Generate Templates" to create them.'}
        </div>
      ) : (
        <div className="border rounded-md overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-2 w-10">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleSelectAll}
                    className="rounded"
                  />
                </th>
                <th className="text-left px-4 py-2 font-medium">Country</th>
                <th className="text-left px-4 py-2 font-medium">Code</th>
                <th className="text-left px-4 py-2 font-medium">Variants</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">SEO</th>
                <th className="text-left px-4 py-2 font-medium">Tags</th>
                <th className="text-left px-4 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr
                  key={t.countryCode}
                  className={`border-b last:border-0 hover:bg-muted/30 transition-colors ${
                    selected.has(t.countryCode) ? 'bg-primary/5' : ''
                  }`}
                >
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(t.countryCode)}
                      onChange={() => toggleSelect(t.countryCode)}
                      className="rounded"
                    />
                  </td>
                  <td className="px-4 py-2 font-medium">
                    <span className="flex items-center gap-2">
                      <img
                        src={`https://flagcdn.com/w20/${t.countryCode.toLowerCase()}.png`}
                        alt=""
                        className="h-4 rounded-sm"
                      />
                      {t.title}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{t.countryCode}</td>
                  <td className="px-4 py-2">{t.variantCount}</td>
                  <td className="px-4 py-2">
                    <StatusBadge template={t} />
                  </td>
                  <td className="px-4 py-2">
                    <SeoBadge hasSeo={t.hasSeo} />
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      {(t.tags as string[]).slice(0, 3).map((tag) => (
                        <span key={tag} className="px-1.5 py-0.5 text-xs bg-muted rounded">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {new Date(t.updatedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
