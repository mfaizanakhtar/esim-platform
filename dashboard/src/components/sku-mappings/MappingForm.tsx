import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { SkuMapping, CatalogItem } from '@/lib/types';
import { useCatalog } from '@/hooks/useCatalog';

const schema = z.object({
  shopifySku: z.string().min(1, 'Shopify SKU is required'),
  provider: z.enum(['firoam', 'tgt'], { required_error: 'Provider is required' }),
  providerCatalogId: z.string().optional(),
  name: z.string().optional(),
  region: z.string().optional(),
  dataAmount: z.string().optional(),
  validity: z.string().optional(),
  packageType: z.enum(['fixed', 'daypass']).default('fixed'),
  daysCount: z.number().optional(),
  providerConfigJson: z.string().optional(),
  isActive: z.boolean().default(true),
});

type FormValues = z.infer<typeof schema>;

interface MappingFormProps {
  initial?: SkuMapping;
  onSubmit: (values: FormValues & { providerConfig?: Record<string, unknown> }) => void;
  onCancel: () => void;
  isPending: boolean;
}

// Don't hard-code '$' — only show the currency code when it's known
function catalogLabel(item: CatalogItem): string {
  const parts = [item.dataAmount, item.validity].filter(Boolean).join(', ');
  const base = item.productName + (parts ? ` (${parts})` : '');
  if (item.netPrice) {
    return `${base} — ${item.netPrice}${item.currency ? ` ${item.currency}` : ''}`;
  }
  return base;
}

export function MappingForm({ initial, onSubmit, onCancel, isPending }: MappingFormProps) {
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
          provider: initial.provider as 'firoam' | 'tgt',
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
        }
      : { packageType: 'fixed', isActive: true },
  });

  const provider = watch('provider') as 'firoam' | 'tgt' | undefined;
  const providerCatalogId = watch('providerCatalogId');
  const packageType = watch('packageType');

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
          }
        : { packageType: 'fixed', isActive: true },
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
    if (provider === 'firoam') {
      const derived = item.productCode?.includes('?') ? 'daypass' : 'fixed';
      setValue('packageType', derived);
    }
    setComboQuery('');
    setComboOpen(false);
    setFocusedIndex(-1);
  }

  function handleFormSubmit(values: FormValues) {
    const providerChanged = initial ? values.provider !== initial.provider : false;
    const requiresCatalogLink =
      !initial || providerChanged || Boolean(initial?.providerCatalogId);

    if (requiresCatalogLink && !values.providerCatalogId) {
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

  // Legacy mapping: has providerSku but no catalog link
  const isLegacy = initial && !initial.providerCatalogId;

  // Combobox input text: show selected label when closed, query while typing
  const comboDisplayValue = comboOpen
    ? comboQuery
    : selectedItem
      ? catalogLabel(selectedItem)
      : '';

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-4">
      <div className="space-y-1">
        <label className="text-sm font-medium">Shopify SKU *</label>
        <input
          {...register('shopifySku')}
          className="w-full border rounded-md px-3 py-2 text-sm"
          placeholder="ESIM-US-5GB"
        />
        {errors.shopifySku && (
          <p className="text-xs text-red-600">{errors.shopifySku.message}</p>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Provider *</label>
        <select {...register('provider')} className="w-full border rounded-md px-3 py-2 text-sm">
          <option value="">Select provider</option>
          <option value="firoam">FiRoam</option>
          <option value="tgt">TGT</option>
        </select>
        {errors.provider && <p className="text-xs text-red-600">{errors.provider.message}</p>}
      </div>

      {/* Catalog product selection — combobox with keyboard support */}
      <div className="space-y-1">
        <label className="text-sm font-medium">
          Catalog Product {!initial && '*'}
        </label>
        {isLegacy && !providerCatalogId && (
          <div className="space-y-1">
            <div className="bg-muted px-3 py-2 rounded-md text-sm font-mono text-muted-foreground">
              {initial.providerSku}
            </div>
            <p className="text-xs text-amber-600">
              Legacy mapping — select a catalog item below to link it
            </p>
          </div>
        )}
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
              placeholder={isLegacy ? 'Keep existing / select to update' : 'Search catalog…'}
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

        {/* Info row for selected catalog item */}
        {selectedItem && (
          <p className="text-xs text-muted-foreground mt-1">
            {selectedItem.netPrice && (
              <>
                Price: {selectedItem.netPrice}
                {selectedItem.currency ? ` ${selectedItem.currency}` : ''}
                {'  ·  '}
              </>
            )}
            {selectedItem.region && <>Region: {selectedItem.region}{'  ·  '}</>}
            Type: {selectedItem.productCode?.includes('?') ? 'daypass' : 'fixed'}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-sm font-medium">Name</label>
          <input
            {...register('name')}
            className="w-full border rounded-md px-3 py-2 text-sm"
            placeholder="US 5GB 30 days"
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">Region</label>
          <input
            {...register('region')}
            className="w-full border rounded-md px-3 py-2 text-sm"
            placeholder="US"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-sm font-medium">Data Amount</label>
          <input
            {...register('dataAmount')}
            className="w-full border rounded-md px-3 py-2 text-sm"
            placeholder="5GB"
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">Validity</label>
          <input
            {...register('validity')}
            className="w-full border rounded-md px-3 py-2 text-sm"
            placeholder="30 days"
          />
        </div>
      </div>

      {/* packageType — read-only badge for FiRoam with catalog selection, editable otherwise */}
      <div className="space-y-1">
        <label className="text-sm font-medium">Package Type</label>
        {provider === 'firoam' && providerCatalogId ? (
          <>
            <input type="hidden" {...register('packageType')} />
            <div className="inline-flex items-center px-3 py-1.5 rounded-md text-sm border bg-muted text-muted-foreground">
              {packageType === 'daypass' ? 'Day Pass' : 'Fixed'}
              <span className="ml-2 text-xs opacity-60">(auto-derived)</span>
            </div>
          </>
        ) : (
          <select
            {...register('packageType')}
            className="w-full border rounded-md px-3 py-2 text-sm"
          >
            <option value="fixed">Fixed</option>
            <option value="daypass">Day Pass</option>
          </select>
        )}
      </div>

      {packageType === 'daypass' && (
        <div className="space-y-1">
          <label className="text-sm font-medium">Days Count</label>
          <input
            {...register('daysCount', { valueAsNumber: true })}
            type="number"
            className="w-full border rounded-md px-3 py-2 text-sm"
            placeholder="7"
          />
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
  );
}
