import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { SkuMapping, CatalogItem } from '@/lib/types';
import { useCatalog } from '@/hooks/useCatalog';
import { useProviders, providerLabel } from '@/hooks/useProviders';

const schema = z.object({
  shopifySku: z.string().min(1, 'Shopify SKU is required'),
  provider: z.string().min(1, 'Provider is required'),
  providerCatalogId: z.string().optional(),
  name: z.string().optional(),
  region: z.string().optional(),
  dataAmount: z.string().optional(),
  validity: z.string().optional(),
  packageType: z.enum(['fixed', 'daypass']).default('fixed'),
  daysCount: z.number().optional(),
  providerConfigJson: z.string().optional(),
  isActive: z.boolean().default(true),
  priorityLocked: z.boolean().default(false),
  mappingLocked: z.boolean().default(false),
});

type FormValues = z.infer<typeof schema>;

interface MappingFormProps {
  initial?: SkuMapping;
  lockedSku?: string;
  existingMappings?: SkuMapping[];
  onSubmit: (values: FormValues & { providerConfig?: Record<string, unknown> }) => void;
  onCancel: () => void;
  isPending: boolean;
}

// Don't hard-code '$' — only show the currency code when it's known.
// Prefix with skuName so entries with the same productCode across different SKUs are distinguishable.
function catalogLabel(item: CatalogItem): string {
  const skuPrefix = item.skuName ? `[${item.skuName}] ` : '';
  const parts = [item.dataAmount, item.validity].filter(Boolean).join(', ');
  const base = skuPrefix + item.productName + (parts ? ` (${parts})` : '');
  if (item.netPrice) {
    return `${base} — ${item.netPrice}${item.currency ? ` ${item.currency}` : ''}`;
  }
  return base;
}

export function MappingForm({ initial, lockedSku, existingMappings, onSubmit, onCancel, isPending }: MappingFormProps) {
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: initial
      ? {
          shopifySku: initial.shopifySku,
          provider: initial.provider,
          providerCatalogId: initial.providerCatalogId ?? undefined,
          name: initial.name ?? '',
          region: initial.region ?? '',
          dataAmount: initial.dataAmount ?? '',
          validity: initial.validity ?? '',
          packageType: (initial.packageType as 'fixed' | 'daypass') ?? 'fixed',
          daysCount: initial.daysCount ?? undefined,
          providerConfigJson: initial.providerConfig
            ? JSON.stringify(initial.providerConfig, null, 2)
            : '',
          isActive: initial.isActive,
          priorityLocked: initial.priorityLocked ?? false,
          mappingLocked: initial.mappingLocked ?? false,
        }
      : { packageType: 'fixed', isActive: true, priorityLocked: false, mappingLocked: false },
  });

  const provider = watch('provider') as string | undefined;
  const providerCatalogId = watch('providerCatalogId');
  const packageType = watch('packageType');
  const daysCount = watch('daysCount');

  const { data: providersData } = useProviders();
  const providers = providersData?.providers ?? [];

  // Combobox state
  const [comboQuery, setComboQuery] = useState('');
  const [comboOpen, setComboOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const comboBlurTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Selected item stored in state so it persists across search query changes
  const [selectedItem, setSelectedItem] = useState<CatalogItem | null>(null);

  // Track previous provider so we can clear catalog state on provider change
  const previousProviderRef = useRef(provider);

  // Fetch catalog items — server-side search when comboQuery is set
  const { data: catalogData } = useCatalog(
    provider
      ? { provider, isActive: true, search: comboQuery || undefined, limit: comboQuery ? 50 : 200 }
      : { limit: 0 },
  );
  const catalogItems = catalogData?.items ?? [];

  // Server already filters by comboQuery — no client-side filter needed
  const filteredCatalog = catalogItems;

  // Hydrate selectedItem when editing with an existing providerCatalogId
  useEffect(() => {
    if (providerCatalogId && !selectedItem && catalogItems.length > 0) {
      const found = catalogItems.find((c) => c.id === providerCatalogId);
      if (found) setSelectedItem(found);
    }
  }, [providerCatalogId, catalogItems, selectedItem]);

  useEffect(() => {
    reset(
      initial
        ? {
            shopifySku: initial.shopifySku,
            provider: initial.provider,
            providerCatalogId: initial.providerCatalogId ?? undefined,
            name: initial.name ?? '',
            region: initial.region ?? '',
            dataAmount: initial.dataAmount ?? '',
            validity: initial.validity ?? '',
            packageType: initial.packageType ?? 'fixed',
            daysCount: initial.daysCount ?? undefined,
            providerConfigJson: initial.providerConfig
              ? JSON.stringify(initial.providerConfig, null, 2)
              : '',
            isActive: initial.isActive,
            priorityLocked: initial.priorityLocked ?? false,
            mappingLocked: initial.mappingLocked ?? false,
          }
        : { packageType: 'fixed', isActive: true, priorityLocked: false, mappingLocked: false },
    );
    setSelectedItem(null);
  }, [initial, reset]);

  // Clear catalog selection and derived fields whenever the provider changes
  useEffect(() => {
    if (previousProviderRef.current && previousProviderRef.current !== provider) {
      setValue('providerCatalogId', undefined);
      setValue('name', '');
      setValue('region', '');
      setValue('dataAmount', '');
      setValue('validity', '');
      setSelectedItem(null);
      setComboQuery('');
      setComboOpen(false);
      setFocusedIndex(-1);
    }
    previousProviderRef.current = provider;
  }, [provider, setValue]);

  function handleCatalogSelect(id: string) {
    setValue('providerCatalogId', id || undefined);
    if (!id) {
      setSelectedItem(null);
      setValue('name', '');
      setValue('region', '');
      setValue('dataAmount', '');
      setValue('validity', '');
      setValue('packageType', 'fixed');
      setValue('daysCount', undefined);
      setComboQuery('');
      return;
    }
    const item = catalogItems.find((c) => c.id === id);
    if (!item) return;
    setSelectedItem(item);
    setValue('name', item.productName ?? '');
    setValue('region', item.region ?? '');
    setValue('dataAmount', item.dataAmount ?? '');
    setValue('validity', item.validity ?? '');
    // Auto-derive packageType for FiRoam
    const derived = item.productCode?.includes('?') ? 'daypass' : 'fixed';
    setValue('packageType', derived);
    // Auto-derive daysCount from validity string (e.g. "7 days" → 7)
    const parsedDays = parseInt(item.validity ?? '', 10);
    setValue('daysCount', isNaN(parsedDays) ? undefined : parsedDays);
    setComboQuery('');
    setComboOpen(false);
    setFocusedIndex(-1);
  }

  function handleFormSubmit(values: FormValues) {
    if (!values.providerCatalogId) {
      setError('providerCatalogId', { message: 'Select a catalog product' });
      return;
    }

    let providerConfig: Record<string, unknown> | undefined;
    if (values.providerConfigJson) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(values.providerConfigJson);
      } catch {
        setError('providerConfigJson', { message: 'Enter a valid JSON object' });
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setError('providerConfigJson', { message: 'Provider config must be a JSON object' });
        return;
      }
      providerConfig = parsed as Record<string, unknown>;
    }
    onSubmit({ ...values, providerConfig });
  }

  // Combobox input text: show selected label when closed, query while typing
  const comboDisplayValue = comboOpen
    ? comboQuery
    : selectedItem
      ? catalogLabel(selectedItem)
      : '';

  return (
    <>
      {existingMappings && existingMappings.length > 0 && (
        <div className="rounded-md border bg-muted/40 px-4 py-3 space-y-1 mb-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Currently mapped
          </p>
          {existingMappings.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
              <span className="font-medium">{providerLabel(m.provider)}</span>
              {m.name && (
                <>
                  <span className="text-muted-foreground">—</span>
                  <span className="truncate max-w-[16rem]">{m.name}</span>
                </>
              )}
              {m.region && (
                <span className="text-muted-foreground text-xs">· {m.region}</span>
              )}
              {m.dataAmount && (
                <span className="text-muted-foreground text-xs">· {m.dataAmount}</span>
              )}
              {m.validity && (
                <span className="text-muted-foreground text-xs">· {m.validity}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-4">
        {/* Hidden derived fields — values set automatically on catalog selection */}
      <input type="hidden" {...register('name')} />
      <input type="hidden" {...register('region')} />
      <input type="hidden" {...register('dataAmount')} />
      <input type="hidden" {...register('validity')} />
      <input type="hidden" {...register('packageType')} />

      <div className="space-y-1">
        <label className="text-sm font-medium">Shopify SKU *</label>
        {lockedSku ? (
          <>
            <input type="hidden" {...register('shopifySku')} value={lockedSku} />
            <p className="text-sm font-mono bg-muted rounded-md px-3 py-2">{lockedSku}</p>
          </>
        ) : (
          <>
            <input
              {...register('shopifySku')}
              className="w-full border rounded-md px-3 py-2 text-sm"
              placeholder="ESIM-US-5GB"
            />
            {errors.shopifySku && (
              <p className="text-xs text-red-600">{errors.shopifySku.message}</p>
            )}
          </>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Provider *</label>
        <select {...register('provider')} className="w-full border rounded-md px-3 py-2 text-sm">
          <option value="">Select provider</option>
          {providers.map((p) => (
            <option key={p} value={p}>{providerLabel(p)}</option>
          ))}
        </select>
        {errors.provider && <p className="text-xs text-red-600">{errors.provider.message}</p>}
      </div>

      {/* Catalog product selection — combobox with keyboard support */}
      <div className="space-y-1">
        <label className="text-sm font-medium">Catalog Product *</label>
        {/* Hidden field to register providerCatalogId in form state */}
        <input type="hidden" {...register('providerCatalogId')} />
        {!provider ? (
          <p className="text-sm text-muted-foreground">Select a provider first</p>
        ) : (
          <div className="relative">
            <input
              type="text"
              role="combobox"
              aria-expanded={comboOpen}
              aria-controls="catalog-listbox"
              aria-autocomplete="list"
              value={comboDisplayValue}
              placeholder="Search catalog…"
              className="w-full border rounded-md px-3 py-2 text-sm"
              onChange={(e) => {
                setComboQuery(e.target.value);
                setComboOpen(true);
                setFocusedIndex(-1);
              }}
              onFocus={() => setComboOpen(true)}
              onBlur={() => {
                comboBlurTimeout.current = setTimeout(() => {
                  setComboOpen(false);
                  setFocusedIndex(-1);
                }, 150);
              }}
              onKeyDown={(e) => {
                if (!comboOpen) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setComboOpen(true);
                    setFocusedIndex(0);
                  }
                  return;
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setFocusedIndex((i) => Math.min(i + 1, filteredCatalog.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setFocusedIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (focusedIndex >= 0 && filteredCatalog[focusedIndex]) {
                    handleCatalogSelect(filteredCatalog[focusedIndex].id);
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setComboOpen(false);
                  setFocusedIndex(-1);
                }
              }}
            />
            {comboOpen && (
              <ul
                id="catalog-listbox"
                role="listbox"
                className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto border rounded-md bg-white shadow-lg text-sm"
              >
                {filteredCatalog.length === 0 ? (
                  <li
                    className="px-3 py-2 text-muted-foreground"
                    role="option"
                    aria-selected={false}
                  >
                    {comboQuery ? 'No results' : 'No catalog entries — sync catalog first'}
                  </li>
                ) : (
                  filteredCatalog.map((item, idx) => (
                    <li
                      key={item.id}
                      role="option"
                      aria-selected={item.id === providerCatalogId}
                      tabIndex={-1}
                      className={`px-3 py-2 cursor-pointer transition-colors ${
                        idx === focusedIndex
                          ? 'bg-primary/10'
                          : item.id === providerCatalogId
                            ? 'bg-muted font-medium'
                            : 'hover:bg-muted/50'
                      }`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        if (comboBlurTimeout.current) clearTimeout(comboBlurTimeout.current);
                        handleCatalogSelect(item.id);
                      }}
                    >
                      {catalogLabel(item)}
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
        )}
        {errors.providerCatalogId && (
          <p className="text-xs text-red-600">{errors.providerCatalogId.message}</p>
        )}

        {/* Info rows for selected catalog item */}
        {selectedItem && (
          <div className="space-y-0.5 mt-1">
            <p className="text-xs text-muted-foreground">
              {[
                selectedItem.netPrice
                  ? `${selectedItem.netPrice}${selectedItem.currency ? ` ${selectedItem.currency}` : ''}`
                  : null,
                selectedItem.region ? `Region: ${selectedItem.region}` : null,
                `Type: ${selectedItem.productCode?.includes('?') ? 'daypass' : 'fixed'}`,
              ]
                .filter(Boolean)
                .join('  ·  ')}
            </p>
            <p className="text-xs text-muted-foreground">
              {[
                selectedItem.productName ? `Name: ${selectedItem.productName}` : null,
                selectedItem.dataAmount ?? null,
                packageType === 'daypass'
                  ? (daysCount != null ? `${daysCount} days` : null)
                  : (selectedItem.validity ?? null),
              ]
                .filter(Boolean)
                .join('  ·  ')}
            </p>
          </div>
        )}
      </div>

      {packageType === 'daypass' && (
        <div className="space-y-1">
          <label className="text-sm font-medium">Days Count</label>
          <input
            {...register('daysCount', { setValueAs: (v) => (v === '' || v === null) ? undefined : Number(v) })}
            type="number"
            className="w-full border rounded-md px-3 py-2 text-sm"
            placeholder="7"
          />
          {errors.daysCount && (
            <p className="text-xs text-red-600">{errors.daysCount.message}</p>
          )}
        </div>
      )}

      <div className="space-y-1">
        <label className="text-sm font-medium">Provider Config (JSON)</label>
        <textarea
          {...register('providerConfigJson')}
          className="w-full border rounded-md px-3 py-2 text-sm font-mono h-24"
          placeholder='{"key": "value"}'
        />
        {errors.providerConfigJson && (
          <p className="text-xs text-red-600">{errors.providerConfigJson.message}</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input {...register('isActive')} type="checkbox" id="isActive" />
        <label htmlFor="isActive" className="text-sm font-medium">
          Active
        </label>
      </div>

      <div className="flex items-center gap-2">
        <input {...register('priorityLocked')} type="checkbox" id="priorityLocked" />
        <label htmlFor="priorityLocked" className="text-sm font-medium">
          Lock priority (exclude from smart pricing reorder)
        </label>
      </div>

      <div className="flex items-center gap-2">
        <input {...register('mappingLocked')} type="checkbox" id="mappingLocked" />
        <label htmlFor="mappingLocked" className="text-sm font-medium">
          Lock mapping (prevent edits and deactivation)
        </label>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm border rounded-md hover:bg-muted transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {isPending ? 'Saving...' : initial ? 'Update' : 'Create'}
        </button>
      </div>
      </form>
    </>
  );
}
