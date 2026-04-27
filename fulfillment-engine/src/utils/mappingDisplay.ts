import type { ProviderSkuMapping } from '@prisma/client';

export interface EmailMappingMetadata {
  name?: string;
  region?: string;
  dataAmount?: string;
  validity?: string;
}

// For daypass we render "N day(s)" from `daysCount` — the same value sent to the
// vendor — so the customer-facing duration cannot drift from what was ordered.
// Fixed packages keep the catalog `validity` string verbatim.
export function buildEmailMetadataFromMapping(
  mapping: Pick<
    ProviderSkuMapping,
    'name' | 'region' | 'dataAmount' | 'validity' | 'packageType' | 'daysCount'
  >,
): EmailMappingMetadata {
  const validity =
    mapping.packageType === 'daypass' && mapping.daysCount
      ? `${mapping.daysCount} ${mapping.daysCount === 1 ? 'day' : 'days'}`
      : mapping.validity || undefined;

  return {
    name: mapping.name || undefined,
    region: mapping.region || undefined,
    dataAmount: mapping.dataAmount || undefined,
    validity,
  };
}
