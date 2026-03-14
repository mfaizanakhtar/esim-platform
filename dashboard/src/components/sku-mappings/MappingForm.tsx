import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { SkuMapping } from '@/lib/types';

const schema = z.object({
  shopifySku: z.string().min(1, 'Shopify SKU is required'),
  provider: z.enum(['firoam', 'tgt'], { required_error: 'Provider is required' }),
  providerSku: z.string().min(1, 'Provider SKU is required'),
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
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: initial
      ? {
          shopifySku: initial.shopifySku,
          provider: initial.provider as 'firoam' | 'tgt',
          providerSku: initial.providerSku,
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

  const packageType = watch('packageType');

  useEffect(() => {
    reset(
      initial
        ? {
            shopifySku: initial.shopifySku,
            provider: initial.provider,
            providerSku: initial.providerSku,
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

  function handleFormSubmit(values: FormValues) {
    let providerConfig: Record<string, unknown> | undefined;
    if (values.providerConfigJson) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(values.providerConfigJson);
      } catch {
        // setError would need the setError from useForm — skip submission instead
        return;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return; // reject arrays and primitives
      }
      providerConfig = parsed as Record<string, unknown>;
    }
    onSubmit({ ...values, providerConfig });
  }

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

      <div className="space-y-1">
        <label className="text-sm font-medium">Provider SKU *</label>
        <input
          {...register('providerSku')}
          className="w-full border rounded-md px-3 py-2 text-sm"
          placeholder="skuId:apiCode:priceId"
        />
        {errors.providerSku && (
          <p className="text-xs text-red-600">{errors.providerSku.message}</p>
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
