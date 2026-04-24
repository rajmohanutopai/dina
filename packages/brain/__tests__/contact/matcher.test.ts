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

    it('returns every occurrence (Python parity — no dedup per contact)', () => {
      // Python's `ContactMatcher.find_mentions` returns one
      // `MatchedContact` per match. Callers that want per-contact
      // uniqueness deduplicate themselves — the matcher's job is to
      // report every span so highlighters get all of them.
      const matches = matchContacts('Alice likes Alice', contacts);
      expect(matches.length).toBe(2);
      expect(matches[0].contactName).toBe('Alice');
      expect(matches[1].contactName).toBe('Alice');
      // Spans are different — two distinct occurrences.
      expect(matches[0].start).toBeLessThan(matches[1].start);
    });

    it('returns span positions (start, end)', () => {
      const matches = matchContacts('Hi Alice', contacts);
      expect(matches[0].start).toBe(3);
      expect(matches[0].end).toBe(8);
    });

    it('minimum name length is 2 chars (Python parity)', () => {
      // Python's MIN_NAME_LENGTH is 2 — enough to reject 1-char
      // pathologies (`I`, `a`) without losing real nicknames (`Bo`,
      // `Jo`, `Li`).
      const oneChar: ContactInfo[] = [{ name: 'I' }];
      expect(matchContacts('I went home', oneChar)).toEqual([]);

      const twoChar: ContactInfo[] = [{ name: 'Jo' }];
      const matches = matchContacts('Jo went home', twoChar);
      expect(matches.length).toBe(1);
      expect(matches[0].contactName).toBe('Jo');
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

    it('carries DID + relationship + data_responsibility on every match', () => {
      // This is the Python-parity payload the persona classifier's
      // `mentioned_contacts` needs — without it the LLM can't apply
      // data_responsibility-based routing overrides.
      const rich: ContactInfo[] = [
        {
          name: 'Emma',
          did: 'did:plc:emma',
          relationship: 'child',
          data_responsibility: 'household',
        },
        {
          name: 'Sancho',
          did: 'did:plc:sancho',
          relationship: 'friend',
          data_responsibility: 'external',
        },
      ];
      const matches = matchContacts('Emma and Sancho are allergic', rich);
      expect(matches.length).toBe(2);
      const byName = new Map(matches.map((m) => [m.contactName, m]));
      expect(byName.get('Emma')).toMatchObject({
        did: 'did:plc:emma',
        relationship: 'child',
        data_responsibility: 'household',
      });
      expect(byName.get('Sancho')).toMatchObject({
        did: 'did:plc:sancho',
        relationship: 'friend',
        data_responsibility: 'external',
      });
    });

    it('defaults relationship=unknown + data_responsibility=external when omitted', () => {
      const bare: ContactInfo[] = [{ name: 'Ziggy' }];
      const matches = matchContacts('Met Ziggy at the park', bare);
      expect(matches[0]).toMatchObject({
        did: '',
        relationship: 'unknown',
        data_responsibility: 'external',
      });
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

    it('rejects names shorter than 2 chars', () => {
      expect(containsContact('I went home', 'I')).toBe(false);
    });

    it('accepts 2-char names (Python parity)', () => {
      expect(containsContact('Jo went home', 'Jo')).toBe(true);
    });
  });
});
