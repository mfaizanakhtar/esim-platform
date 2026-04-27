import { describe, it, expect } from 'vitest';
import { buildEmailMetadataFromMapping } from '~/utils/mappingDisplay';

describe('buildEmailMetadataFromMapping', () => {
  const base = {
    name: 'Germany 2GB (Daily, 2 Days)',
    region: 'Europe',
    dataAmount: '2GB',
  };

  it('derives daypass validity from daysCount, ignoring stale validity text', () => {
    const meta = buildEmailMetadataFromMapping({
      ...base,
      packageType: 'daypass',
      daysCount: 2,
      validity: '1 day',
    });
    expect(meta).toEqual({
      name: base.name,
      region: base.region,
      dataAmount: base.dataAmount,
      validity: '2 days',
    });
  });

  it('uses singular "1 day" when daysCount is 1', () => {
    const meta = buildEmailMetadataFromMapping({
      ...base,
      packageType: 'daypass',
      daysCount: 1,
      validity: '7 days',
    });
    expect(meta.validity).toBe('1 day');
  });

  it('falls back to validity text for daypass when daysCount is null', () => {
    const meta = buildEmailMetadataFromMapping({
      ...base,
      packageType: 'daypass',
      daysCount: null,
      validity: '5 days',
    });
    expect(meta.validity).toBe('5 days');
  });

  it('keeps validity verbatim for fixed packages', () => {
    const meta = buildEmailMetadataFromMapping({
      ...base,
      packageType: 'fixed',
      daysCount: null,
      validity: '30 days',
    });
    expect(meta.validity).toBe('30 days');
  });

  it('coalesces empty strings to undefined', () => {
    const meta = buildEmailMetadataFromMapping({
      name: '',
      region: '',
      dataAmount: '',
      packageType: 'fixed',
      daysCount: null,
      validity: '',
    });
    expect(meta).toEqual({
      name: undefined,
      region: undefined,
      dataAmount: undefined,
      validity: undefined,
    });
  });
});
