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

function catalogLabel(item: CatalogItem): string {
  const parts = [item.dataAmount, item.validity].filter(Boolean).join(', ');
  const base = item.productName + (parts ? ` (${parts})` : '');
  if (item.netPrice) {
    return `${base} — $${item.netPrice}${item.currency ? ` ${item.currency}` : ''}`;
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
  const comboBlurTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track previous provider so we can clear catalog state on provider change
  const previousProviderRef = useRef(provider);

  // Fetch catalog items for the selected provider
  const { data: catalogData } = useCatalog(
    provider ? { provider, isActive: true, limit: 500 } : { limit: 0 },
  );
  const catalogItems = catalogData?.items ?? [];

  // Derive selected catalog item
  const selectedCatalogItem = catalogItems.find((c) => c.id === providerCatalogId) ?? null;

  // Filtered catalog for combobox
  const filteredCatalog = catalogItems.filter(
    (item) =>
      !comboQuery ||
      item.productName.toLowerCase().includes(comboQuery.toLowerCase()) ||
      item.productCode.toLowerCase().includes(comboQuery.toLowerCase()) ||
      (item.region ?? '').toLowerCase().includes(comboQuery.toLowerCase()),
  );

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
  }, [initial, reset]);

  // Clear catalog selection and derived fields whenever the provider changes
  useEffect(() => {
    if (previousProviderRef.current && previousProviderRef.current !== provider) {
      setValue('providerCatalogId', undefined);
      setValue('name', '');
      setValue('region', '');
      setValue('dataAmount', '');
      setValue('validity', '');
      setComboQuery('');
      setComboOpen(false);
    }
    previousProviderRef.current = provider;
  }, [provider, setValue]);

  function handleCatalogSelect(id: string) {
    setValue('providerCatalogId', id || undefined);
    if (!id) {
      setValue('name', '');
      setValue('region', '');
      setValue('dataAmount', '');
      setValue('validity', '');
      setComboQuery('');
      return;
    }
    const item = catalogItems.find((c) => c.id === id);
    if (!item) return;
    setValue('name', item.productName ?? '');
    setValue('region', item.region ?? '');
    setValue('dataAmount', item.dataAmount ?? '');
    setValue('validity', item.validity ?? '');
    // 4a: auto-derive packageType for FiRoam
    if (provider === 'firoam') {
      const derived = item.productCode?.includes('?') ? 'daypass' : 'fixed';
      setValue('packageType', derived);
    }
    setComboQuery('');
    setComboOpen(false);
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

  // Combobox display text: show selected label when closed, query when typing
  const comboDisplayValue = comboOpen
    ? comboQuery
    : selectedCatalogItem
      ? catalogLabel(selectedCatalogItem)
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

      {/* Catalog product selection — combobox */}
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
        ) : catalogItems.length === 0 ? (
          <p className="text-sm text-amber-600">No catalog entries — sync catalog first</p>
        ) : (
          <div className="relative">
            <input
              type="text"
              value={comboDisplayValue}
              placeholder={isLegacy ? 'Keep existing / select to update' : 'Search catalog…'}
              className="w-full border rounded-md px-3 py-2 text-sm"
              onChange={(e) => {
                setComboQuery(e.target.value);
                setComboOpen(true);
              }}
              onFocus={() => setComboOpen(true)}
              onBlur={() => {
                comboBlurTimeout.current = setTimeout(() => setComboOpen(false), 150);
              }}
            />
            {comboOpen && (
              <ul className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto border rounded-md bg-white shadow-lg text-sm">
                {filteredCatalog.length === 0 ? (
                  <li className="px-3 py-2 text-muted-foreground">No results</li>
                ) : (
                  filteredCatalog.map((item) => (
                    <li
                      key={item.id}
                      className={`px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors ${
                        item.id === providerCatalogId ? 'bg-muted font-medium' : ''
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

        {/* 4b: info row for selected catalog item */}
        {selectedCatalogItem && (
          <p className="text-xs text-muted-foreground mt-1">
            {selectedCatalogItem.netPrice && (
              <>
                Price: ${selectedCatalogItem.netPrice}
                {selectedCatalogItem.currency ? ` ${selectedCatalogItem.currency}` : ''}
                {'  ·  '}
              </>
            )}
            {selectedCatalogItem.region && <>Region: {selectedCatalogItem.region}{'  ·  '}</>}
            Type: {selectedCatalogItem.productCode?.includes('?') ? 'daypass' : 'fixed'}
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

      {/* 4a: packageType — read-only badge for FiRoam with catalog selection, editable otherwise */}
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
