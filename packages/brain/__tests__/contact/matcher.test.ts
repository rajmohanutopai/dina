/**
 * T1J.6 — Contact name matching in text.
 *
 * Category A: fixture-based. Verifies matching behavior:
 * case-insensitive, word-boundary, longest-first, dedup.
 *
 * Source: brain/tests/test_contact_matcher.py
 */

import { matchContacts, containsContact } from '../../src/contact/matcher';
import type { ContactInfo } from '../../src/contact/matcher';

describe('Contact Matcher', () => {
  const contacts: ContactInfo[] = [
    { name: 'Alice' },
    { name: 'Bob', aliases: ['Bobby', 'Robert'] },
    { name: 'Alice Cooper' },
  ];

  describe('matchContacts', () => {
    it('matches basic name mention', () => {
      const matches = matchContacts('Saw Alice today', contacts);
      expect(matches.length).toBe(1);
      expect(matches[0].contactName).toBe('Alice');
      expect(matches[0].matchedText).toBe('Alice');
    });

    it('case-insensitive matching', () => {
      const matches = matchContacts('Saw ALICE today', contacts);
      expect(matches.length).toBe(1);
      expect(matches[0].contactName).toBe('Alice');
    });

    it('returns no matches for unknown names', () => {
      const matches = matchContacts('Saw Charlie today', contacts);
      expect(matches).toEqual([]);
    });

    it('matches multiple contacts in one text', () => {
      const matches = matchContacts('Alice met Bob for coffee', contacts);
      expect(matches.length).toBe(2);
      expect(matches.map((m) => m.contactName).sort()).toEqual(['Alice', 'Bob']);
    });

    it('longest-first: "Alice Cooper" matches before "Alice"', () => {
      const matches = matchContacts('Went to see Alice Cooper', contacts);
      expect(matches.length).toBe(1);
      expect(matches[0].contactName).toBe('Alice Cooper');
      expect(matches[0].matchedText).toBe('Alice Cooper');
    });

    it('word-boundary: does not match partial names inside words', () => {
      const matches = matchContacts('Saw a Bobcat', contacts);
      expect(matches).toEqual([]);
    });

    it('deduplicates same contact mentioned twice', () => {
      const matches = matchContacts('Alice likes Alice', contacts);
      expect(matches.length).toBe(1);
      expect(matches[0].contactName).toBe('Alice');
    });

    it('returns span positions (start, end)', () => {
      const matches = matchContacts('Hi Alice', contacts);
      expect(matches[0].start).toBe(3);
      expect(matches[0].end).toBe(8);
    });

    it('minimum name length enforced (no 1-2 char names)', () => {
      const shortContacts: ContactInfo[] = [{ name: 'Al' }];
      const matches = matchContacts('Al went home', shortContacts);
      expect(matches).toEqual([]);
    });

    it('handles empty contacts list', () => {
      expect(matchContacts('Hello world', [])).toEqual([]);
    });

    it('handles empty text', () => {
      expect(matchContacts('', contacts)).toEqual([]);
    });

    it('matches alias names', () => {
      const matches = matchContacts('Saw Bobby yesterday', contacts);
      expect(matches.length).toBe(1);
      expect(matches[0].contactName).toBe('Bob'); // canonical name
      expect(matches[0].matchedText).toBe('Bobby');
    });

    it('matches "Robert" alias to Bob', () => {
      const matches = matchContacts('Robert called me', contacts);
      expect(matches.length).toBe(1);
      expect(matches[0].contactName).toBe('Bob');
    });

    it('sorted by position in text', () => {
      const matches = matchContacts('Bob saw Alice', contacts);
      expect(matches[0].contactName).toBe('Bob');
      expect(matches[1].contactName).toBe('Alice');
    });
  });

  describe('containsContact', () => {
    it('returns true when contact name present', () => {
      expect(containsContact('Lunch with Alice', 'Alice')).toBe(true);
    });

    it('returns false when contact name absent', () => {
      expect(containsContact('Lunch alone', 'Alice')).toBe(false);
    });

    it('case-insensitive', () => {
      expect(containsContact('Lunch with ALICE', 'Alice')).toBe(true);
    });

    it('word-boundary aware', () => {
      expect(containsContact('Bobcat is not Bob', 'Bob')).toBe(true); // "Bob" at end
      expect(containsContact('Bobcat ran away', 'Bob')).toBe(false); // only "Bobcat"
    });

    it('rejects names shorter than 3 chars', () => {
      expect(containsContact('Al went home', 'Al')).toBe(false);
    });
  });
});
