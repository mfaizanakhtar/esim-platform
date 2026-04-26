import { useMemo, useState } from 'react';
import { Check, Loader2, Pencil, Trash2, Globe } from 'lucide-react';
import {
  useRegions,
  useRegionSuggestions,
  useAcceptSuggestion,
  useUpdateRegion,
  useDeleteRegion,
  type Region,
  type RegionSuggestion,
} from '@/hooks/useRegions';

export function Regions() {
  const regionsQ = useRegions();
  const suggestionsQ = useRegionSuggestions();

  const savedCodes = useMemo(
    () => new Set((regionsQ.data?.regions ?? []).map((r) => r.code)),
    [regionsQ.data?.regions],
  );

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Globe className="h-6 w-6" />
          Regions
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Group countries into canonical regional bundles (e.g.{' '}
          <span className="font-mono">EU30</span>, <span className="font-mono">ASIA4</span>,{' '}
          <span className="font-mono">GCC6</span>) that you can sell as multi-country eSIMs.
          Suggestions come from your live provider catalog — accept the ones you want, then run
          "Generate All Templates" on the Products page.
        </p>
      </header>

      <SuggestionsSection
        loading={suggestionsQ.isPending}
        error={suggestionsQ.error as Error | null}
        groups={suggestionsQ.data?.groups ?? []}
        savedCodes={savedCodes}
      />

      <SavedRegionsSection
        loading={regionsQ.isPending}
        error={regionsQ.error as Error | null}
        regions={regionsQ.data?.regions ?? []}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Suggestions
// ────────────────────────────────────────────────────────────────────────────

function SuggestionsSection({
  loading,
  error,
  groups,
  savedCodes,
}: {
  loading: boolean;
  error: Error | null;
  groups: import('@/hooks/useRegions').RegionGroup[];
  savedCodes: Set<string>;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold mb-3">Suggestions from provider catalog</h2>
      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Discovering…
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Failed to load suggestions: {error.message}
        </div>
      )}
      {!loading && !error && groups.length === 0 && (
        <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground text-center">
          No suggestions yet. Sync provider catalogs first (Catalog page) so we have data to group.
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {groups.map((g) => (
          <SuggestionCard key={`${g.parentCode}::${g.label}`} group={g} savedCodes={savedCodes} />
        ))}
      </div>
    </section>
  );
}

function SuggestionCard({
  group,
  savedCodes,
}: {
  group: import('@/hooks/useRegions').RegionGroup;
  savedCodes: Set<string>;
}) {
  return (
    <div className="rounded-lg border bg-white p-4 space-y-3">
      <div>
        <div className="flex items-baseline gap-2">
          <span className="text-base font-semibold">{group.parentCode}</span>
          <span className="text-xs text-muted-foreground">vendor label "{group.label}"</span>
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          {group.providers
            .map((p) => `${p.provider}: ${p.countries.length} countries`)
            .join(' · ')}
        </div>
      </div>

      <div className="space-y-2">
        {group.suggestions.length === 0 && (
          <div className="text-xs text-muted-foreground italic">
            No actionable suggestions (need ≥2 countries common, or union too large).
          </div>
        )}
        {group.suggestions.map((s) => (
          <SuggestionRow key={s.code} suggestion={s} alreadySaved={savedCodes.has(s.code)} />
        ))}
      </div>
    </div>
  );
}

function SuggestionRow({
  suggestion,
  alreadySaved,
}: {
  suggestion: RegionSuggestion;
  alreadySaved: boolean;
}) {
  const accept = useAcceptSuggestion();

  function handleAccept() {
    accept.mutate(suggestion.code);
  }

  const isPending = accept.isPending;
  const isSaved = alreadySaved || accept.isSuccess;
  const errorMsg = accept.isError ? (accept.error as Error).message : null;

  return (
    <div className="flex items-center justify-between gap-3 border rounded-md px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium">{suggestion.code}</span>
          <span
            className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
              suggestion.kind === 'INTERSECTION'
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-amber-100 text-amber-800'
            }`}
          >
            {suggestion.kind}
          </span>
          <span className="text-xs text-muted-foreground">
            {suggestion.countryCodes.length} countries
          </span>
        </div>
        <div className="text-xs text-muted-foreground truncate" title={suggestion.rationale}>
          {suggestion.rationale}
        </div>
        {suggestion.providersAvailable.length > 0 && (
          <div className="text-xs text-muted-foreground mt-0.5">
            Fulfilled by: {suggestion.providersAvailable.join(', ')}
          </div>
        )}
        {errorMsg && <div className="text-xs text-red-600 mt-1">{errorMsg}</div>}
      </div>
      <div className="shrink-0">
        {isSaved ? (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-700 px-2 py-1">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        ) : (
          <button
            onClick={handleAccept}
            disabled={isPending}
            className="text-sm px-3 py-1 rounded-md border bg-white hover:bg-muted disabled:opacity-50 transition-colors"
          >
            {isPending ? 'Saving…' : 'Accept'}
          </button>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Saved regions
// ────────────────────────────────────────────────────────────────────────────

function SavedRegionsSection({
  loading,
  error,
  regions,
}: {
  loading: boolean;
  error: Error | null;
  regions: Region[];
}) {
  const [editing, setEditing] = useState<Region | null>(null);
  const updateMutation = useUpdateRegion();
  const deleteMutation = useDeleteRegion();

  function toggleActive(region: Region) {
    updateMutation.mutate({
      code: region.code,
      data: { isActive: !region.isActive },
    });
  }

  function handleDelete(region: Region) {
    const ok = window.confirm(
      `Delete region ${region.code}? Templates referencing it become orphaned (regionCode set to NULL).`,
    );
    if (!ok) return;
    deleteMutation.mutate(region.code);
  }

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold">Saved regions</h2>
        {regions.length > 0 && (
          <span className="text-xs text-muted-foreground">{regions.length} total</span>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Failed to load regions: {error.message}
        </div>
      )}
      {!loading && !error && regions.length === 0 && (
        <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground text-center">
          No regions yet. Accept a suggestion above to create one.
        </div>
      )}
      {regions.length > 0 && (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Code</th>
                <th className="text-left px-3 py-2 font-medium">Parent</th>
                <th className="text-left px-3 py-2 font-medium">Name</th>
                <th className="text-right px-3 py-2 font-medium">Countries</th>
                <th className="text-right px-3 py-2 font-medium">Templates</th>
                <th className="text-center px-3 py-2 font-medium">Active</th>
                <th className="text-right px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {regions.map((r) => (
                <tr key={r.code} className="border-t">
                  <td className="px-3 py-2 font-mono">{r.code}</td>
                  <td className="px-3 py-2">{r.parentCode}</td>
                  <td className="px-3 py-2">{r.name}</td>
                  <td className="px-3 py-2 text-right">{r.countryCodes.length}</td>
                  <td className="px-3 py-2 text-right">{r.templateCount ?? 0}</td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => toggleActive(r)}
                      disabled={updateMutation.isPending}
                      className={`inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
                        r.isActive ? 'bg-emerald-500' : 'bg-gray-300'
                      }`}
                      aria-label={r.isActive ? 'Deactivate' : 'Activate'}
                    >
                      <span
                        className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                          r.isActive ? 'translate-x-4' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right space-x-1">
                    <button
                      onClick={() => setEditing(r)}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted transition-colors"
                    >
                      <Pencil className="h-3 w-3" /> Edit
                    </button>
                    <button
                      onClick={() => handleDelete(r)}
                      disabled={deleteMutation.isPending}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" /> Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <EditRegionDialog
          region={editing}
          onClose={() => setEditing(null)}
          onSave={(data) =>
            updateMutation.mutate(
              { code: editing.code, data },
              { onSuccess: () => setEditing(null) },
            )
          }
          saving={updateMutation.isPending}
          error={updateMutation.isError ? (updateMutation.error as Error).message : null}
        />
      )}
    </section>
  );
}

function EditRegionDialog({
  region,
  onClose,
  onSave,
  saving,
  error,
}: {
  region: Region;
  onClose: () => void;
  onSave: (data: {
    name?: string;
    description?: string | null;
    countryCodes?: string[];
    sortOrder?: number;
  }) => void;
  saving: boolean;
  error: string | null;
}) {
  const [name, setName] = useState(region.name);
  const [description, setDescription] = useState(region.description ?? '');
  const [countriesText, setCountriesText] = useState(region.countryCodes.join(', '));
  const [sortOrder, setSortOrder] = useState(String(region.sortOrder));

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const countryCodes = countriesText
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    onSave({
      name: name.trim() || undefined,
      description: description.trim() ? description.trim() : null,
      countryCodes,
      sortOrder: Number.isFinite(parseInt(sortOrder, 10)) ? parseInt(sortOrder, 10) : undefined,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-lg shadow-xl w-full max-w-md p-5 space-y-4"
      >
        <div>
          <h3 className="text-lg font-semibold">Edit region</h3>
          <p className="text-xs text-muted-foreground">
            Code <span className="font-mono">{region.code}</span> is immutable (used in SKUs).
          </p>
        </div>
        <label className="block text-sm">
          <span className="font-medium">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block w-full border rounded-md px-2 py-1.5"
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="mt-1 block w-full border rounded-md px-2 py-1.5"
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Country codes</span>
          <textarea
            value={countriesText}
            onChange={(e) => setCountriesText(e.target.value)}
            rows={3}
            className="mt-1 block w-full font-mono text-xs border rounded-md px-2 py-1.5"
            placeholder="DE, FR, AT, BE, NL"
          />
          <span className="text-xs text-muted-foreground">
            ISO 3166-1 alpha-2 codes, comma- or space-separated. Auto-uppercased.
          </span>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Sort order</span>
          <input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            className="mt-1 block w-24 border rounded-md px-2 py-1.5"
          />
        </label>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="text-sm px-3 py-1.5 rounded-md border hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="text-sm px-3 py-1.5 rounded-md bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
