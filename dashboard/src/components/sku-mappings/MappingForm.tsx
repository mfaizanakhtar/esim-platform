import { useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { SkuMapping } from '@/lib/types';
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

  // Track previous provider so we can clear catalog state on provider change
  const previousProviderRef = useRef(provider);

  // Fetch catalog items for the selected provider
  const { data: catalogData } = useCatalog(
    provider ? { provider, isActive: true, limit: 200 } : { limit: 0 },
  );
  const catalogItems = catalogData?.items ?? [];

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
      return;
    }
    const item = catalogItems.find((c) => c.id === id);
    if (!item) return;
    // Always overwrite all derived fields — avoids stale values from previous selection
    setValue('name', item.productName ?? '');
    setValue('region', item.region ?? '');
    setValue('dataAmount', item.dataAmount ?? '');
    setValue('validity', item.validity ?? '');
  }

  function handleFormSubmit(values: FormValues) {
    // Require catalog selection for:
    //   - new mappings
    //   - edits where the provider changed (stale catalog ID from old provider)
    //   - edits where the mapping was already catalog-linked (keep it linked)
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

      {/* Catalog product selection */}
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
          <select
            value={providerCatalogId ?? ''}
            onChange={(e) => handleCatalogSelect(e.target.value)}
            className="w-full border rounded-md px-3 py-2 text-sm"
          >
            <option value="">{isLegacy ? 'Keep existing / select to update' : 'Select catalog product…'}</option>
            {catalogItems.map((item) => (
              <option key={item.id} value={item.id}>
                {item.productName}
                {item.dataAmount || item.validity
                  ? ` (${[item.dataAmount, item.validity].filter(Boolean).join(', ')})`
                  : ''}
              </option>
            ))}
          </select>
        )}
        {errors.providerCatalogId && (
          <p className="text-xs text-red-600">{errors.providerCatalogId.message}</p>
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

      <div className="space-y-1">
        <label className="text-sm font-medium">Package Type</label>
        <select
          {...register('packageType')}
          className="w-full border rounded-md px-3 py-2 text-sm"
        >
          <option value="fixed">Fixed</option>
          <option value="daypass">Day Pass</option>
        </select>
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
