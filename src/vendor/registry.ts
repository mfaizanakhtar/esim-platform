import type { VendorProvider } from '~/vendor/types';
import { FiRoamProvider } from '~/vendor/providers/firoam';
import { TgtProvider } from '~/vendor/providers/tgt';
import { isTgtEnabled } from '~/vendor/tgtConfig';
import { MappingError } from '~/utils/errors';

/**
 * Central registry of all eSIM vendor provider implementations.
 *
 * Adding a new vendor is a 3-step process:
 *   1. Create `src/vendor/providers/<vendor>.ts` implementing VendorProvider
 *   2. Add it to the registry map below: `['airalo', new AiraloProvider()]`
 *   3. Insert ProviderSkuMapping rows via the admin API (no deploy required for mappings)
 *
 * The string key must match the `provider` field stored in ProviderSkuMapping rows.
 */
const registry = new Map<string, VendorProvider>([
  ['firoam', new FiRoamProvider()],
  ...(isTgtEnabled() ? ([['tgt', new TgtProvider()]] as const) : []),
  // ['airalo', new AiraloProvider()],   ← example: add new vendor here
]);

/**
 * Returns the registered VendorProvider for the given name.
 * Throws a descriptive error if the provider is not registered.
 *
 * @param name - Value of `ProviderSkuMapping.provider` (e.g. `'firoam'`)
 */
export function getProvider(name: string): VendorProvider {
  const provider = registry.get(name);
  if (!provider) {
    const available = [...registry.keys()].join(', ');
    throw new MappingError(`Unsupported provider: ${name}. Registered providers: [${available}]`);
  }
  return provider;
}
