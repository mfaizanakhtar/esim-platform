import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted: vi.mock is hoisted above top-level declarations, so the mock fn
// must be hoisted too or the factory closure will see undefined.
const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock('~/utils/logger', () => ({
  logger: { warn: warnMock, info: vi.fn(), error: vi.fn() },
}));

import { normalizeFiroamCountries } from '~/utils/firoamCountryCodes';

beforeEach(() => {
  warnMock.mockClear();
});

describe('normalizeFiroamCountries', () => {
  it('maps display names to ISO codes', () => {
    expect(normalizeFiroamCountries(['Germany', 'France', 'Austria'])).toEqual(['AT', 'DE', 'FR']);
  });

  it('passes through already-ISO codes (uppercased)', () => {
    expect(normalizeFiroamCountries(['DE', 'fr'])).toEqual(['DE', 'FR']);
  });

  it('handles mixed name + ISO inputs, dedup, sort', () => {
    expect(normalizeFiroamCountries(['Germany', 'de', 'FR', 'France'])).toEqual(['DE', 'FR']);
  });

  it('drops unknown names and logs a warning', () => {
    const out = normalizeFiroamCountries(['Atlantis', 'Germany'], {
      skuId: '123',
      productCode: 'PKG-X',
    });
    expect(out).toEqual(['DE']);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        skuId: '123',
        productCode: 'PKG-X',
        unknownCountryNames: ['Atlantis'],
      }),
      expect.any(String),
    );
  });

  it('returns empty array (no warning) for empty input', () => {
    expect(normalizeFiroamCountries([])).toEqual([]);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('returns empty array for non-array input (null, undefined, string, object)', () => {
    expect(normalizeFiroamCountries(null)).toEqual([]);
    expect(normalizeFiroamCountries(undefined)).toEqual([]);
    expect(normalizeFiroamCountries('Germany')).toEqual([]);
    expect(normalizeFiroamCountries({ x: 1 })).toEqual([]);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('skips non-string entries silently (defensive vs API drift)', () => {
    expect(normalizeFiroamCountries(['Germany', 42, null, 'France'])).toEqual(['DE', 'FR']);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('skips empty/whitespace strings', () => {
    expect(normalizeFiroamCountries(['', '  ', 'Germany'])).toEqual(['DE']);
  });

  it('accepts a plausible 2-letter code even if not in the lookup (defensive)', () => {
    // 2-letter codes pass the regex gate. If the code is something obscure
    // like 'XK' (Kosovo provisional), we don't reject it — better to keep
    // the code than drop coverage. firoamNameToCode wouldn't match anyway.
    expect(normalizeFiroamCountries(['XK', 'Germany'])).toEqual(['DE', 'XK']);
  });

  it('does not double-warn within a single call when one name is unknown', () => {
    normalizeFiroamCountries(['Atlantis', 'Wakanda', 'Germany']);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ unknownCountryNames: ['Atlantis', 'Wakanda'] }),
      expect.any(String),
    );
  });
});
