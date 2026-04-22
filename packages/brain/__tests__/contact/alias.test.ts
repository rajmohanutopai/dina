/**
 * T2B.7 — Contact alias: matching precedence, staging override, recall hints.
 *
 * Category B: contract test.
 *
 * Source: brain/tests/test_alias_support.py
 */

import {
  matchWithAliases,
  attributeWithPrecedence,
  overrideStagingResponsibility,
  generateRecallHints,
} from '../../src/contact/alias';

describe('Contact Alias Support', () => {
  const contacts = [
    { name: 'Alice', aliases: ['Ali', 'Ally'], kinship: 'friend' },
    { name: 'Bob', aliases: ['Bobby', 'Robert'], kinship: 'colleague' },
    { name: 'Dr. Shah', aliases: ['Shah'], kinship: undefined },
  ];

  describe('matchWithAliases', () => {
    it('matches by alias', () => {
      const matches = matchWithAliases('Talked to Ali today', contacts);
      expect(matches.length).toBe(1);
      expect(matches[0].contactName).toBe('Alice');
      expect(matches[0].matchType).toBe('alias');
    });

    it('matches by name', () => {
      const matches = matchWithAliases('Talked to Alice today', contacts);
      expect(matches.length).toBe(1);
      expect(matches[0].contactName).toBe('Alice');
      expect(matches[0].matchType).toBe('name');
    });

    it('alias and name dedup (same contact)', () => {
      const matches = matchWithAliases('Alice (Ali) called', contacts);
      expect(matches.length).toBe(1);
      expect(matches[0].contactName).toBe('Alice');
    });

    it('longest-first matching', () => {
      const matches = matchWithAliases('Dr. Shah prescribed medication', contacts);
      expect(matches.length).toBe(1);
      expect(matches[0].contactName).toBe('Dr. Shah');
    });

    it('case-insensitive alias', () => {
      const matches = matchWithAliases('BOBBY sent a message', contacts);
      expect(matches.length).toBe(1);
      expect(matches[0].contactName).toBe('Bob');
    });

    it('word boundary (no partial match)', () => {
      const matches = matchWithAliases('Alison went home', contacts);
      expect(matches).toEqual([]);
    });

    it('multiple contacts matched', () => {
      const matches = matchWithAliases('Ali met Bobby for lunch', contacts);
      expect(matches.length).toBe(2);
      const names = matches.map((m) => m.contactName).sort();
      expect(names).toEqual(['Alice', 'Bob']);
    });

    it('no match for unknown text', () => {
      expect(matchWithAliases('Charlie went shopping', contacts)).toEqual([]);
    });

    it('empty contacts list', () => {
      expect(matchWithAliases('test', [])).toEqual([]);
    });

    it('overlapping aliases deduplicated', () => {
      const matches = matchWithAliases('Ali Ali Ali', contacts);
      expect(matches.length).toBe(1); // deduplicated per contact
    });
  });

  describe('attributeWithPrecedence', () => {
    it('alias wins over kinship role', () => {
      const result = attributeWithPrecedence('Ali is here', contacts);
      expect(result).not.toBeNull();
      expect(result!.subject).toBe('Alice');
      expect(result!.matchType).toBe('alias');
    });

    it('name match returns correctly', () => {
      const result = attributeWithPrecedence('Alice is here', contacts);
      expect(result!.subject).toBe('Alice');
      expect(result!.matchType).toBe('name');
    });

    it('kinship fallback when no alias match', () => {
      const result = attributeWithPrecedence('my colleague said hello', contacts);
      expect(result).not.toBeNull();
      expect(result!.matchType).toBe('kinship');
    });

    it('unmatched role returns null', () => {
      const result = attributeWithPrecedence('the stranger walked by', contacts);
      expect(result).toBeNull();
    });
  });

  describe('overrideStagingResponsibility', () => {
    it('overrides with alias-identified contact', () => {
      const result = overrideStagingResponsibility(
        { summary: 'test' },
        { contactName: 'Alice', matchedAlias: 'Ali', matchType: 'alias' },
      );
      expect(result.attributed_contact).toBe('Alice');
      expect(result.attributed_match_type).toBe('alias');
      expect(result.attributed_alias).toBe('Ali');
    });

    it('preserves original item fields', () => {
      const result = overrideStagingResponsibility(
        { summary: 'test', type: 'email' },
        { contactName: 'Alice', matchedAlias: 'Ali', matchType: 'alias' },
      );
      expect(result.summary).toBe('test');
      expect(result.type).toBe('email');
    });
  });

  describe('generateRecallHints', () => {
    it('generates hints when alias-matched contact mentioned', () => {
      const hints = generateRecallHints('Meeting with Ali tomorrow', contacts);
      expect(hints.length).toBe(1);
      expect(hints[0]).toContain('Alice');
    });

    it('no hints for unmentioned contacts', () => {
      const hints = generateRecallHints('Beautiful weather today', contacts);
      expect(hints).toEqual([]);
    });

    it('multiple hints for multiple contacts', () => {
      const hints = generateRecallHints('Ali and Bobby are arriving', contacts);
      expect(hints.length).toBe(2);
    });
  });
});
