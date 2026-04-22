/**
 * PC-CORE-04 — normalisePreferredForCategories helper tests.
 *
 * Pins the shared normalisation rules that both the in-memory +
 * SQLite contact repositories (PC-CORE-03), the HTTP handler
 * (PC-CORE-11), and the staging processor's preference-binding step
 * (PC-BRAIN-13) depend on. Any drift in these rules would let
 * different write paths land on different canonical forms and break
 * case-insensitive lookup.
 */

import {
  normalisePreferredForCategories,
  normalisePreferredForCategory,
} from '../../src/contacts/preferred_for';

describe('normalisePreferredForCategories', () => {
  it('returns [] for empty input', () => {
    expect(normalisePreferredForCategories([])).toEqual([]);
  });

  it('lowercases + trims + drops empties + dedups (main spec)', () => {
    expect(normalisePreferredForCategories(['  Dental  ', 'dental', '', 'TAX'])).toEqual([
      'dental',
      'tax',
    ]);
  });

  it('preserves first-seen ordering', () => {
    expect(normalisePreferredForCategories(['tax', 'accounting', 'dental'])).toEqual([
      'tax',
      'accounting',
      'dental',
    ]);
  });

  it('dedup is case-insensitive — first casing wins in normalised form', () => {
    // All of these collapse to "dental" — the first normalised form
    // is kept; subsequent duplicates are dropped regardless of input
    // casing.
    expect(normalisePreferredForCategories(['Dental', 'DENTAL', '  dental  '])).toEqual(['dental']);
  });

  it('drops whitespace-only entries', () => {
    expect(normalisePreferredForCategories(['dental', '   ', '\t\n', ''])).toEqual(['dental']);
  });

  it('drops non-string entries defensively', () => {
    // The type says `readonly string[]` but the helper is also called
    // from the HTTP handler where the body hasn't been validated yet.
    // A stray number / null in the incoming array must not poison
    // the output.
    const dirty = ['dental', 42 as unknown as string, null as unknown as string, 'tax'];
    expect(normalisePreferredForCategories(dirty)).toEqual(['dental', 'tax']);
  });

  it('does not mutate the input array', () => {
    const input = ['  Dental  ', 'dental', 'TAX'];
    const snapshot = [...input];
    normalisePreferredForCategories(input);
    expect(input).toEqual(snapshot);
  });

  it('returns a fresh array on every call (no shared mutable state)', () => {
    const a = normalisePreferredForCategories(['dental']);
    const b = normalisePreferredForCategories(['dental']);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.push('mutated');
    expect(b).toEqual(['dental']);
  });

  it('returns [] for non-array input (defensive, HTTP body may be malformed)', () => {
    expect(normalisePreferredForCategories(undefined as unknown as string[])).toEqual([]);
    expect(normalisePreferredForCategories(null as unknown as string[])).toEqual([]);
    expect(normalisePreferredForCategories('dental' as unknown as string[])).toEqual([]);
  });
});

describe('normalisePreferredForCategory (single-value helper for lookups)', () => {
  it('lowercases + trims', () => {
    expect(normalisePreferredForCategory('  Dental  ')).toBe('dental');
    expect(normalisePreferredForCategory('TAX')).toBe('tax');
  });

  it('returns empty string on blank / whitespace-only input', () => {
    expect(normalisePreferredForCategory('')).toBe('');
    expect(normalisePreferredForCategory('   ')).toBe('');
    expect(normalisePreferredForCategory('\t\n')).toBe('');
  });

  it('returns empty string on non-string input (defensive)', () => {
    expect(normalisePreferredForCategory(undefined as unknown as string)).toBe('');
    expect(normalisePreferredForCategory(null as unknown as string)).toBe('');
    expect(normalisePreferredForCategory(42 as unknown as string)).toBe('');
  });
});
