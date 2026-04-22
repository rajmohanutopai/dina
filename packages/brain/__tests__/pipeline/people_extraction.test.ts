/**
 * T10.4 — People extraction: detect names, link to contacts, merge.
 *
 * Source: ARCHITECTURE.md Task 10.4
 */

import {
  extractPeople,
  extractPeopleBatch,
  mergeByContact,
} from '../../src/pipeline/people_extraction';
import { registerPersonLinkProvider, resetPersonLinkProvider } from '../../src/person/linking';
import type { ResolvedPerson } from '../../src/person/linking';
import { addContact, resetContactDirectory } from '../../../core/src/contacts/directory';
import { addAlias } from '../../../core/src/contacts/directory';

const knownPeople: ResolvedPerson[] = [
  { personId: 'p1', name: 'Alice', surfaces: ['alice@example.com', 'Ali'] },
  { personId: 'p2', name: 'Bob', surfaces: ['bob@work.com', 'Robert'] },
];

describe('People Extraction Pipeline', () => {
  beforeEach(() => {
    resetPersonLinkProvider();
    resetContactDirectory();
    // Register contacts with aliases matching knownPeople
    addContact('did:plc:alice', 'Alice');
    addAlias('did:plc:alice', 'Alice');
    addAlias('did:plc:alice', 'Ali');
    addContact('did:plc:bob', 'Bob');
    addAlias('did:plc:bob', 'Bob');
    addAlias('did:plc:bob', 'Robert');
  });

  describe('extractPeople — name matching', () => {
    it('detects known person by name', async () => {
      const result = await extractPeople('item-1', 'Had lunch with Alice today', knownPeople);
      expect(result.mentions).toHaveLength(1);
      expect(result.mentions[0].name).toBe('Alice');
      expect(result.mentions[0].contactDID).toBe('did:plc:alice');
      expect(result.mentions[0].source).toBe('name_match');
      expect(result.mentions[0].confidence).toBe('high');
    });

    it('detects multiple people', async () => {
      const result = await extractPeople(
        'item-2',
        'Alice and Bob discussed the project',
        knownPeople,
      );
      expect(result.mentions).toHaveLength(2);
      expect(result.linkedContacts).toContain('did:plc:alice');
      expect(result.linkedContacts).toContain('did:plc:bob');
    });

    it('deduplicates same person mentioned twice', async () => {
      const result = await extractPeople('item-3', 'Alice called Alice again', knownPeople);
      expect(result.mentions).toHaveLength(1);
    });

    it('returns empty for no matches', async () => {
      const result = await extractPeople('item-4', 'Weather is nice today', knownPeople);
      expect(result.mentions).toHaveLength(0);
      expect(result.linkedContacts).toHaveLength(0);
    });

    it('tracks itemId in result', async () => {
      const result = await extractPeople('item-5', 'Test with Alice', knownPeople);
      expect(result.itemId).toBe('item-5');
    });
  });

  describe('extractPeople — LLM extraction', () => {
    it('LLM finds additional names not in knownPeople', async () => {
      registerPersonLinkProvider(
        async () => '{"links":[{"name":"Charlie","role":"colleague","confidence":"medium"}]}',
      );
      const result = await extractPeople('item-6', 'Met Charlie at the conference', knownPeople);
      expect(result.mentions.some((m) => m.name === 'Charlie')).toBe(true);
      expect(result.unresolved).toContain('Charlie');
    });

    it('LLM results are deduplicated against name matches', async () => {
      registerPersonLinkProvider(async () => '{"links":[{"name":"Alice","confidence":"high"}]}');
      const result = await extractPeople('item-7', 'Had lunch with Alice', knownPeople);
      // Alice found by name match — LLM result should be skipped
      const aliceMentions = result.mentions.filter((m) => m.name === 'Alice');
      expect(aliceMentions).toHaveLength(1);
      expect(aliceMentions[0].source).toBe('name_match'); // not llm_extraction
    });

    it('handles LLM failure gracefully', async () => {
      registerPersonLinkProvider(async () => {
        throw new Error('LLM down');
      });
      const result = await extractPeople('item-8', 'Alice is here', knownPeople);
      // Should still have name-match results
      expect(result.mentions).toHaveLength(1);
      expect(result.mentions[0].name).toBe('Alice');
    });

    it('LLM result links to known contact via alias', async () => {
      registerPersonLinkProvider(async () => '{"links":[{"name":"Bob","confidence":"high"}]}');
      const result = await extractPeople('item-9', 'Only Bob was mentioned by LLM', []);
      // No knownPeople match, but LLM finds Bob, which resolves via alias
      const bobMention = result.mentions.find((m) => m.name === 'Bob');
      expect(bobMention?.contactDID).toBe('did:plc:bob');
    });
  });

  describe('extractPeopleBatch', () => {
    it('processes multiple items', async () => {
      const results = await extractPeopleBatch(
        [
          { id: 'a', text: 'Alice said hello' },
          { id: 'b', text: 'Bob is coming' },
          { id: 'c', text: 'Nice weather' },
        ],
        knownPeople,
      );
      expect(results).toHaveLength(3);
      expect(results[0].mentions).toHaveLength(1);
      expect(results[1].mentions).toHaveLength(1);
      expect(results[2].mentions).toHaveLength(0);
    });
  });

  describe('mergeByContact', () => {
    it('aggregates items per contact', async () => {
      const results = [
        await extractPeople('item-A', 'Alice sent email', knownPeople),
        await extractPeople('item-B', 'Meeting with Alice and Bob', knownPeople),
        await extractPeople('item-C', 'Bob called', knownPeople),
      ];
      const merged = mergeByContact(results);
      expect(merged.get('did:plc:alice')).toEqual(['item-A', 'item-B']);
      expect(merged.get('did:plc:bob')).toEqual(['item-B', 'item-C']);
    });

    it('deduplicates items per contact', async () => {
      const r1 = await extractPeople('item-X', 'Alice Alice Alice', knownPeople);
      const merged = mergeByContact([r1, r1]); // same result twice
      expect(merged.get('did:plc:alice')).toEqual(['item-X']); // only once
    });

    it('returns empty map for no contacts', async () => {
      const results = [await extractPeople('item-Z', 'No people here', knownPeople)];
      expect(mergeByContact(results).size).toBe(0);
    });
  });
});
