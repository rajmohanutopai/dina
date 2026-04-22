/**
 * Task 4.81 — allow-list filter tests.
 */

import type { PIIMatch } from '@dina/core';
import { AllowList, filterMatches } from '../src/pii/allow_list';

function match(type: string, value: string, start = 0): PIIMatch {
  return { type, value, start, end: start + value.length };
}

describe('AllowList (task 4.81)', () => {
  describe('add + suppresses', () => {
    it('adds a token and suppresses matches case-insensitively', () => {
      const al = new AllowList().add('B12');
      expect(al.suppresses('PAN', 'B12')).toBe(true);
      expect(al.suppresses('PAN', 'b12')).toBe(true);
      expect(al.suppresses('PAN', 'B12 ')).toBe(true);
      expect(al.suppresses('PAN', 'B13')).toBe(false);
    });

    it('rejects empty or non-string tokens', () => {
      const al = new AllowList();
      expect(() => al.add('')).toThrow(/non-empty/);
      expect(() => al.add('   ')).toThrow(/non-empty/);
      expect(() => al.add(123 as unknown as string)).toThrow(/must be a string/);
    });

    it('returns itself for chaining', () => {
      const al = new AllowList();
      expect(al.add('a').add('b').size()).toBe(2);
    });

    it('stores global entries and type-scoped entries separately', () => {
      const al = new AllowList().add('FOO').add('BAR', { type: 'EMAIL' });
      expect(al.size()).toBe(2);
      expect(al.suppresses('PAN', 'FOO')).toBe(true);
      expect(al.suppresses('PAN', 'BAR')).toBe(false);
      expect(al.suppresses('EMAIL', 'BAR')).toBe(true);
    });

    it('type-scoped entry does NOT leak to other types', () => {
      const al = new AllowList().add('john@dina.app', { type: 'EMAIL' });
      expect(al.suppresses('EMAIL', 'john@dina.app')).toBe(true);
      expect(al.suppresses('UPI', 'john@dina.app')).toBe(false);
    });
  });

  describe('addAll', () => {
    it('adds every non-empty token from an iterable', () => {
      const al = new AllowList().addAll(['A1C', 'HbA1c', '', '   ', 'PSA']);
      expect(al.size()).toBe(3);
      expect(al.suppresses('PAN', 'a1c')).toBe(true);
      expect(al.suppresses('PAN', 'psa')).toBe(true);
    });

    it('respects the type option for every entry', () => {
      const al = new AllowList().addAll(['a@b', 'c@d'], { type: 'UPI' });
      expect(al.suppresses('UPI', 'a@b')).toBe(true);
      expect(al.suppresses('UPI', 'c@d')).toBe(true);
      expect(al.suppresses('EMAIL', 'a@b')).toBe(false);
    });
  });

  describe('loadFromConfig', () => {
    it('flattens every category into the global set', () => {
      const al = new AllowList().loadFromConfig({
        medical: ['B12', 'HbA1c'],
        finance: ['LTCG'],
        misc: ['SKU-999'],
      });
      expect(al.size()).toBe(4);
      expect(al.suppresses('PAN', 'b12')).toBe(true);
      expect(al.suppresses('BANK_ACCT', 'sku-999')).toBe(true);
    });

    it('ignores non-array category values', () => {
      const al = new AllowList().loadFromConfig({
        good: ['A', 'B'],
        bad: 'not an array' as unknown as string[],
      });
      expect(al.size()).toBe(2);
    });

    it('rejects non-object input', () => {
      const al = new AllowList();
      expect(() => al.loadFromConfig(null as unknown as Record<string, string[]>)).toThrow(
        /expected an object/,
      );
    });
  });

  describe('suppresses — edge cases', () => {
    it('empty value is never suppressed', () => {
      const al = new AllowList().add('A');
      expect(al.suppresses('EMAIL', '')).toBe(false);
    });

    it('whitespace-only value is never suppressed', () => {
      const al = new AllowList().add('A');
      expect(al.suppresses('EMAIL', '   ')).toBe(false);
    });
  });
});

describe('filterMatches (task 4.81)', () => {
  it('returns a copy when allowList is undefined', () => {
    const matches = [match('EMAIL', 'a@b.com')];
    const out = filterMatches(matches, undefined);
    expect(out).toEqual(matches);
    expect(out).not.toBe(matches);
  });

  it('returns a copy when allowList is empty', () => {
    const matches = [match('EMAIL', 'a@b.com')];
    const out = filterMatches(matches, new AllowList());
    expect(out).toEqual(matches);
  });

  it('drops matches whose value is allow-listed globally', () => {
    const al = new AllowList().add('B12');
    const matches = [
      match('PAN', 'B12', 0),
      match('EMAIL', 'a@b.com', 10),
    ];
    expect(filterMatches(matches, al)).toEqual([matches[1]]);
  });

  it('drops only the specified type when allow-list entry is type-scoped', () => {
    const al = new AllowList().add('john@dina.app', { type: 'EMAIL' });
    const matches = [
      match('EMAIL', 'john@dina.app', 0),
      match('UPI', 'john@dina.app', 20),
    ];
    const out = filterMatches(matches, al);
    expect(out.map((m) => m.type)).toEqual(['UPI']);
  });

  it('does not mutate the input array', () => {
    const al = new AllowList().add('A');
    const matches = [match('PAN', 'A', 0), match('EMAIL', 'b@c.com', 5)];
    const before = matches.slice();
    filterMatches(matches, al);
    expect(matches).toEqual(before);
  });
});
