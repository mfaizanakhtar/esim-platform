import { useState } from 'react';
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

function ActionBar() {
  const generateMutation = useGenerateTemplates();
  const seoMutation = useGenerateSeo();
  const pushMutation = usePushToShopify();
  const [message, setMessage] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [forcePush, setForcePush] = useState(false);

  function handleGenerate() {
    setMessage(null);
    generateMutation.mutate(
      { overwrite },
      {
        onSuccess: (data) => {
          setMessage(
            `Generated ${data.generated} templates (${data.skippedExisting} already existed, ${data.skippedInvalid} invalid codes)${data.errors.length ? `. Errors: ${data.errors.join(', ')}` : ''}`,
          );
        },
        onError: (err) => setMessage(`Failed: ${(err as Error).message}`),
      },
    );
  }

  function handleGenerateSeo() {
    setMessage(null);
    seoMutation.mutate(
      {},
      {
        onSuccess: (data) => {
          if (data.queued > 0) {
            setMessage(`Generating SEO for ${data.queued} templates in background`);
          } else {
            setMessage(data.message ?? 'All templates already have SEO');
          }
        },
        onError: (err) => setMessage(`Failed: ${(err as Error).message}`),
      },
    );
  }

  function handlePush() {
    setMessage(null);
    pushMutation.mutate(
      { force: forcePush },
      {
        onSuccess: (data) => {
          if (data.total > 0) {
            setMessage(`Pushing ${data.total} templates to Shopify in background`);
          } else {
            setMessage(data.message ?? 'No templates to push');
          }
        },
        onError: (err) => setMessage(`Failed: ${(err as Error).message}`),
      },
    );
  }

  const anyPending = generateMutation.isPending || seoMutation.isPending || pushMutation.isPending;

  return (
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
          {seoMutation.isPending ? 'Generating SEO...' : 'Generate SEO'}
        </button>

        <button
          onClick={handlePush}
          disabled={anyPending}
          className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md hover:bg-muted disabled:opacity-50 transition-colors"
        >
          <Upload className={`h-4 w-4 ${pushMutation.isPending ? 'animate-pulse' : ''}`} />
          {pushMutation.isPending ? 'Pushing...' : 'Push to Shopify'}
        </button>
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
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={forcePush}
            onChange={(e) => setForcePush(e.target.checked)}
            className="rounded"
          />
          Force re-push
        </label>
      </div>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}

function TemplateTable({
  templates,
  search,
}: {
  templates: ProductTemplateSummary[];
  search: string;
}) {
  const deleteMutation = useDeleteTemplate();

  const filtered = search
    ? templates.filter(
        (t) =>
          t.title.toLowerCase().includes(search.toLowerCase()) ||
          t.countryCode.toLowerCase().includes(search.toLowerCase()),
      )
    : templates;

  if (filtered.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        {search ? 'No templates match your search' : 'No templates yet. Click "Generate Templates" to create them.'}
      </div>
    );
  }

  return (
    <div className="border rounded-md overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="text-left px-4 py-2 font-medium">Country</th>
            <th className="text-left px-4 py-2 font-medium">Code</th>
            <th className="text-left px-4 py-2 font-medium">Variants</th>
            <th className="text-left px-4 py-2 font-medium">Status</th>
            <th className="text-left px-4 py-2 font-medium">SEO</th>
            <th className="text-left px-4 py-2 font-medium">Tags</th>
            <th className="text-left px-4 py-2 font-medium">Updated</th>
            <th className="text-right px-4 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {filtered.map((t) => (
            <tr key={t.countryCode} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
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
              <td className="px-4 py-2 text-right">
                <button
                  onClick={() => {
                    if (confirm(`Delete template for ${t.title}?`)) {
                      deleteMutation.mutate(t.countryCode);
                    }
                  }}
                  disabled={deleteMutation.isPending}
                  className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                  title="Delete template"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProductTemplates() {
  const { data, isLoading } = useProductTemplates();
  const [search, setSearch] = useState('');

  const templates = data?.templates ?? [];
  const totalCount = data?.total ?? 0;
  const pushedCount = templates.filter((t) => t.shopifyProductId).length;
  const seoCount = templates.filter((t) => t.hasSeo).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Product Templates</h1>
        <p className="text-muted-foreground mt-1">
          Manage Shopify product definitions. Generate templates, enrich with AI SEO, then push to Shopify.
        </p>
      </div>

      <ActionBar />

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
      ) : (
        <TemplateTable templates={templates} search={search} />
      )}
    </div>
  );
}
