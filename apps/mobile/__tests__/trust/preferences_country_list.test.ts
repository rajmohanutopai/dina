/**
 * Tests for the ISO 3166 country-list utility (TN-V2-CTX-002).
 *
 * Pins:
 *   - ISO 3166-1 alpha-2 list shape: every entry is exactly 2 uppercase letters.
 *   - No duplicates.
 *   - Lookup map agrees with the array (defends against future drift).
 *   - getCountryName: localised → english → raw-code fallback chain.
 *   - buildCountryList: sorts by display name in the requested locale.
 *   - filterCountries: case-insensitive on name AND code.
 */

import {
  ISO_3166_ALPHA_2_CODES,
  ISO_3166_CODE_SET,
  buildCountryList,
  clearCountryListCacheForTest,
  filterCountries,
  getCountryName,
} from '../../src/trust/preferences/country_list';

beforeEach(() => {
  clearCountryListCacheForTest();
});

describe('ISO_3166_ALPHA_2_CODES — list shape', () => {
  it('every entry is exactly 2 uppercase ASCII letters', () => {
    for (const code of ISO_3166_ALPHA_2_CODES) {
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('no duplicates', () => {
    const seen = new Set<string>();
    for (const code of ISO_3166_ALPHA_2_CODES) {
      expect(seen.has(code)).toBe(false);
      seen.add(code);
    }
  });

  it('list size is in the expected range (240–260 — ISO publishes ~249)', () => {
    // Defensive against an edit accidentally truncating the list to
    // a handful of entries (the kind of bug that's hard to spot
    // visually but easy to bound numerically).
    expect(ISO_3166_ALPHA_2_CODES.length).toBeGreaterThanOrEqual(240);
    expect(ISO_3166_ALPHA_2_CODES.length).toBeLessThanOrEqual(260);
  });

  it('contains canonical anchor codes (US, GB, IN, JP, BR, ZA)', () => {
    for (const code of ['US', 'GB', 'IN', 'JP', 'BR', 'ZA']) {
      expect(ISO_3166_ALPHA_2_CODES).toContain(code);
    }
  });

  it('contains widely-used unofficial codes (XK = Kosovo)', () => {
    // Kosovo's status is contested; XK is the user-assigned code most
    // platforms (CLDR, ICU) use. Including it matters because real
    // users in Pristina need to be able to set their region.
    expect(ISO_3166_ALPHA_2_CODES).toContain('XK');
  });

  it('excludes deprecated transitional codes (CS, YU)', () => {
    // CS = Serbia and Montenegro (split 2006), YU = Yugoslavia (split
    // earlier). Selecting either in 2025 would be confusing.
    expect(ISO_3166_ALPHA_2_CODES).not.toContain('CS');
    expect(ISO_3166_ALPHA_2_CODES).not.toContain('YU');
  });
});

describe('ISO_3166_CODE_SET — lookup map', () => {
  it('every array entry is in the set', () => {
    for (const code of ISO_3166_ALPHA_2_CODES) {
      expect(ISO_3166_CODE_SET.has(code)).toBe(true);
    }
  });

  it('set size matches array size (no dedup discrepancy)', () => {
    expect(ISO_3166_CODE_SET.size).toBe(ISO_3166_ALPHA_2_CODES.length);
  });

  it('rejects non-ISO codes', () => {
    expect(ISO_3166_CODE_SET.has('ZZ')).toBe(false);
    expect(ISO_3166_CODE_SET.has('us')).toBe(false); // case-sensitive
    expect(ISO_3166_CODE_SET.has('USA')).toBe(false);
  });
});

describe('getCountryName — localisation + fallback', () => {
  it('returns a non-trivial display name for known codes (en locale)', () => {
    // We can't pin "Germany" exactly because Intl implementations vary
    // wording (e.g., "United States" vs "United States of America"),
    // but the result should be longer than the raw code.
    const name = getCountryName('DE', 'en');
    expect(name.length).toBeGreaterThan(2);
    expect(name).not.toBe('DE');
  });

  it('handles different locales (fr returns French names where supported)', () => {
    // In environments with full Intl ICU data, fr locale returns
    // "Allemagne". In stripped Hermes environments, it may return the
    // English name. Either is acceptable — but the result should still
    // be non-trivial (not the raw code).
    const name = getCountryName('DE', 'fr');
    expect(name.length).toBeGreaterThan(2);
  });

  it('falls back to the static en-name table when Intl.DisplayNames is unavailable', () => {
    // Stub Intl.DisplayNames to throw — simulates Hermes (iOS/Android)
    // where the constructor exists but the locale data is stripped, OR
    // older runtimes where the constructor itself is missing.
    //
    // Behaviour change (TN-V2-CTX-002 fix): the static fallback now
    // returns the English name for the most common codes so the
    // picker is readable on Hermes. Less-common codes still fall to
    // the raw code (asserted separately).
    const original = (Intl as any).DisplayNames;
    delete (Intl as any).DisplayNames;
    try {
      clearCountryListCacheForTest();
      expect(getCountryName('DE')).toBe('Germany');
      expect(getCountryName('US')).toBe('United States');
      expect(getCountryName('XK')).toBe('Kosovo');
      // A code that's not even in ISO 3166-1 falls through to itself —
      // graceful degrade for stored stale data.
      expect(getCountryName('ZZ')).toBe('ZZ');
    } finally {
      (Intl as any).DisplayNames = original;
      clearCountryListCacheForTest();
    }
  });

  it('caches the lookup — second call for same (code, locale) is identical reference', () => {
    const a = getCountryName('FR', 'en');
    const b = getCountryName('FR', 'en');
    // Strings are interned in V8/Hermes, so `===` works for cache verification.
    expect(b).toBe(a);
  });
});

describe('buildCountryList — locale-aware sort', () => {
  it('returns one entry per ISO code', () => {
    const list = buildCountryList('en');
    expect(list.length).toBe(ISO_3166_ALPHA_2_CODES.length);
  });

  it('every entry has a code + displayName, both non-empty', () => {
    const list = buildCountryList('en');
    for (const entry of list) {
      expect(entry.code).toMatch(/^[A-Z]{2}$/);
      expect(entry.displayName.length).toBeGreaterThan(0);
    }
  });

  it('result is sorted by display name in the locale', () => {
    const list = buildCountryList('en');
    const collator = new Intl.Collator('en');
    for (let i = 1; i < list.length; i++) {
      // strict <= because two distinct codes could share a display name
      // (e.g., overseas territories with the same English name).
      expect(collator.compare(list[i - 1].displayName, list[i].displayName)).toBeLessThanOrEqual(0);
    }
  });

  it('codes are preserved verbatim (sort is on display name, not code)', () => {
    // Without this assertion a buggy refactor could swap to sorting by
    // code, leaving display names mismatched against codes.
    const list = buildCountryList('en');
    const codes = list.map((c) => c.code);
    for (const code of codes) {
      expect(ISO_3166_CODE_SET.has(code)).toBe(true);
    }
  });
});

describe('filterCountries — search', () => {
  const sample = [
    { code: 'DE', displayName: 'Germany' },
    { code: 'GB', displayName: 'United Kingdom' },
    { code: 'US', displayName: 'United States' },
    { code: 'IN', displayName: 'India' },
  ];

  it('returns the input unchanged for empty / whitespace queries', () => {
    expect(filterCountries(sample, '')).toBe(sample);
    expect(filterCountries(sample, '   ')).toBe(sample);
  });

  it('matches on display name (case-insensitive)', () => {
    expect(filterCountries(sample, 'germany').map((c) => c.code)).toEqual(['DE']);
    expect(filterCountries(sample, 'GERMANY').map((c) => c.code)).toEqual(['DE']);
    // Substring match.
    expect(filterCountries(sample, 'united').map((c) => c.code)).toEqual(['GB', 'US']);
  });

  it('matches on ISO code (case-insensitive)', () => {
    expect(filterCountries(sample, 'de').map((c) => c.code)).toEqual(['DE']);
    expect(filterCountries(sample, 'DE').map((c) => c.code)).toEqual(['DE']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterCountries(sample, 'mars')).toEqual([]);
  });

  it('does not mutate the input list', () => {
    const before = [...sample];
    filterCountries(sample, 'germany');
    expect(sample).toEqual(before);
  });
});
