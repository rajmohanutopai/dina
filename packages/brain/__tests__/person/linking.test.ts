/**
 * T2B.22 — Person identity linking: extraction, resolution, dedup, parsing.
 *
 * Source: brain/tests/test_person_linking.py
 */

import {
  extractPersonLinks,
  resolvePerson,
  resolveMultiple,
  expandSearchTerms,
  deduplicatePersons,
  parseLLMOutput,
  registerPersonLinkProvider,
  resetPersonLinkProvider,
} from '../../src/person/linking';
import type { ResolvedPerson } from '../../src/person/linking';

describe('Person Identity Linking', () => {
  const knownPeople: ResolvedPerson[] = [
    { personId: 'p1', name: 'Alice', surfaces: ['alice@example.com', 'Ali'] },
    { personId: 'p2', name: 'Bob', surfaces: ['bob@work.com', 'Robert'] },
  ];

  afterEach(() => resetPersonLinkProvider());

  describe('extractPersonLinks', () => {
    it('extracts person links via LLM provider', async () => {
      registerPersonLinkProvider(
        async () => '{"links":[{"name":"Alice","role":"colleague","confidence":"high"}]}',
      );
      const links = await extractPersonLinks('Had lunch with Alice');
      expect(links).toHaveLength(1);
      expect(links[0].name).toBe('Alice');
      expect(links[0].role).toBe('colleague');
      expect(links[0].confidence).toBe('high');
    });

    it('extracts multiple people', async () => {
      registerPersonLinkProvider(
        async () =>
          '{"links":[{"name":"Alice","confidence":"high"},{"name":"Bob","confidence":"medium"}]}',
      );
      const links = await extractPersonLinks('Alice and Bob discussed the project');
      expect(links).toHaveLength(2);
    });

    it('returns empty when no provider registered', async () => {
      const links = await extractPersonLinks('Text with names');
      expect(links).toEqual([]);
    });

    it('returns empty for empty input', async () => {
      registerPersonLinkProvider(async () => '{"links":[]}');
      expect(await extractPersonLinks('')).toEqual([]);
    });

    it('returns empty for whitespace-only input', async () => {
      registerPersonLinkProvider(async () => '{"links":[]}');
      expect(await extractPersonLinks('   ')).toEqual([]);
    });

    it('handles malformed LLM output gracefully', async () => {
      registerPersonLinkProvider(async () => 'not json at all');
      const links = await extractPersonLinks('Some text');
      expect(links).toEqual([]);
    });

    it('handles LLM returning markdown-fenced JSON', async () => {
      registerPersonLinkProvider(
        async () => '```json\n{"links":[{"name":"Charlie","confidence":"low"}]}\n```',
      );
      const links = await extractPersonLinks('Talked to Charlie');
      expect(links).toHaveLength(1);
      expect(links[0].name).toBe('Charlie');
    });

    it('handles LLM provider error gracefully', async () => {
      registerPersonLinkProvider(async () => {
        throw new Error('LLM unavailable');
      });
      await expect(extractPersonLinks('Some text')).rejects.toThrow('LLM unavailable');
    });
  });

  describe('resolvePerson', () => {
    it('resolves by name', () => {
      expect(resolvePerson('Alice', knownPeople)?.personId).toBe('p1');
    });

    it('resolves by surface (email)', () => {
      expect(resolvePerson('alice@example.com', knownPeople)?.personId).toBe('p1');
    });

    it('resolves by surface (alias)', () => {
      expect(resolvePerson('Ali', knownPeople)?.personId).toBe('p1');
    });

    it('case-insensitive', () => {
      expect(resolvePerson('ALICE', knownPeople)?.personId).toBe('p1');
    });

    it('returns null for unknown person', () => {
      expect(resolvePerson('Charlie', knownPeople)).toBeNull();
    });

    it('empty text returns null', () => {
      expect(resolvePerson('', knownPeople)).toBeNull();
    });
  });

  describe('resolveMultiple', () => {
    it('resolves multiple people from text', () => {
      const result = resolveMultiple('Alice met Bob', knownPeople);
      expect(result.length).toBe(2);
    });

    it('deduplicates same person mentioned twice', () => {
      const result = resolveMultiple('Alice saw Alice', knownPeople);
      expect(result.length).toBe(1);
    });

    it('returns empty for no matches', () => {
      expect(resolveMultiple('nice weather', knownPeople)).toEqual([]);
    });

    it('matches by alias in text', () => {
      const result = resolveMultiple('Talked to Ali yesterday', knownPeople);
      expect(result.length).toBe(1);
      expect(result[0].personId).toBe('p1');
    });
  });

  describe('expandSearchTerms', () => {
    it('expands from all known surfaces', () => {
      const terms = expandSearchTerms(knownPeople[0]);
      expect(terms).toContain('Alice');
      expect(terms).toContain('alice@example.com');
      expect(terms).toContain('Ali');
    });

    it('includes name and all aliases/emails', () => {
      const terms = expandSearchTerms(knownPeople[1]);
      expect(terms).toContain('Bob');
      expect(terms).toContain('bob@work.com');
      expect(terms).toContain('Robert');
    });

    it('empty surfaces returns just name', () => {
      const terms = expandSearchTerms({ personId: 'p99', name: 'Unknown', surfaces: [] });
      expect(terms).toEqual(['Unknown']);
    });
  });

  describe('deduplicatePersons', () => {
    it('removes duplicate personId', () => {
      const result = deduplicatePersons([knownPeople[0], knownPeople[0]]);
      expect(result.length).toBe(1);
    });

    it('keeps distinct persons', () => {
      const result = deduplicatePersons(knownPeople);
      expect(result.length).toBe(2);
    });
  });

  describe('parseLLMOutput', () => {
    it('parses valid JSON', () => {
      const result = parseLLMOutput('{"links":[{"name":"Alice","confidence":"high"}]}');
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('Alice');
      expect(result[0].confidence).toBe('high');
    });

    it('parses markdown-fenced JSON', () => {
      const result = parseLLMOutput('```json\n{"links":[]}\n```');
      expect(result).toEqual([]);
    });

    it('returns empty for empty links', () => {
      expect(parseLLMOutput('{"links":[]}')).toEqual([]);
    });

    it('returns empty for invalid JSON', () => {
      expect(parseLLMOutput('not json at all')).toEqual([]);
    });

    it('returns empty for missing key', () => {
      expect(parseLLMOutput('{"wrong_key":[]}')).toEqual([]);
    });

    it('returns empty for empty input', () => {
      expect(parseLLMOutput('')).toEqual([]);
    });
  });
});
