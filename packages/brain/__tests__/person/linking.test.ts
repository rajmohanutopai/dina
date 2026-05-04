/**
 * T2B.22 — Person identity linking: extraction, resolution, dedup, parsing.
 *
 * Source: brain/tests/test_person_linking.py
 */

import {
  extractPersonLinks,
  expandSearchTerms,
  expandSearchTermsFromText,
  resolvePerson,
  resolveMultiple,
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
        async () =>
          '{"identity_links":[{"name":"Alice","role_phrase":"colleague","confidence":"high"}]}',
      );
      const links = await extractPersonLinks('Had lunch with Alice');
      expect(links).toHaveLength(1);
      expect(links[0].name).toBe('Alice');
      expect(links[0].role_phrase).toBe('colleague');
      expect(links[0].confidence).toBe('high');
    });

    it('extracts multiple people', async () => {
      registerPersonLinkProvider(
        async () =>
          '{"identity_links":[{"name":"Alice","confidence":"high"},{"name":"Bob","confidence":"medium"}]}',
      );
      const links = await extractPersonLinks('Alice and Bob discussed the project');
      expect(links).toHaveLength(2);
    });

    it('returns empty when no provider registered', async () => {
      const links = await extractPersonLinks('Text with names');
      expect(links).toEqual([]);
    });

    it('returns empty for empty input', async () => {
      registerPersonLinkProvider(async () => '{"identity_links":[]}');
      expect(await extractPersonLinks('')).toEqual([]);
    });

    it('returns empty for whitespace-only input', async () => {
      registerPersonLinkProvider(async () => '{"identity_links":[]}');
      expect(await extractPersonLinks('   ')).toEqual([]);
    });

    it('handles malformed LLM output gracefully', async () => {
      registerPersonLinkProvider(async () => 'not json at all');
      const links = await extractPersonLinks('Some text');
      expect(links).toEqual([]);
    });

    it('handles LLM returning markdown-fenced JSON', async () => {
      registerPersonLinkProvider(
        async () => '```json\n{"identity_links":[{"name":"Charlie","confidence":"low"}]}\n```',
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
      const result = parseLLMOutput(
        '{"identity_links":[{"name":"Alice","confidence":"high"}]}',
      );
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('Alice');
      expect(result[0].confidence).toBe('high');
    });

    it('parses markdown-fenced JSON', () => {
      const result = parseLLMOutput('```json\n{"identity_links":[]}\n```');
      expect(result).toEqual([]);
    });

    it('returns empty for empty identity_links', () => {
      expect(parseLLMOutput('{"identity_links":[]}')).toEqual([]);
    });

    it('rejects old links envelope', () => {
      expect(parseLLMOutput('{"links":[{"name":"Alice","confidence":"high"}]}')).toEqual([]);
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

    it('parses the Python-parity identity_links envelope', () => {
      // Matches PROMPT_PERSON_IDENTITY_EXTRACTION — production LLM
      // output uses `identity_links` + per-link `role_phrase`
      // + `relationship` + `evidence`.
      const output = JSON.stringify({
        identity_links: [
          {
            name: 'Emma',
            role_phrase: 'my daughter',
            relationship: 'child',
            confidence: 'high',
            evidence: 'My daughter Emma loves dinosaurs',
          },
        ],
      });
      const links = parseLLMOutput(output);
      expect(links).toHaveLength(1);
      expect(links[0].name).toBe('Emma');
      expect(links[0].role_phrase).toBe('my daughter');
      expect(links[0].relationship).toBe('child');
      expect(links[0].evidence).toMatch(/daughter Emma/);
      expect(links[0].confidence).toBe('high');
    });

    it('truncates evidence at 200 chars (Python parity)', () => {
      const longEvidence = 'e'.repeat(500);
      const output = JSON.stringify({
        identity_links: [
          { name: 'Ziggy', relationship: 'friend', confidence: 'low', evidence: longEvidence },
        ],
      });
      expect(parseLLMOutput(output)[0].evidence?.length).toBe(200);
    });
  });

  describe('resolveMultiple — longest-first span claiming', () => {
    it('"Alice Cooper" claims the span before "Alice" gets a chance', () => {
      const people: ResolvedPerson[] = [
        { personId: 'p1', name: 'Alice', surfaces: [] },
        { personId: 'p2', name: 'Alice Cooper', surfaces: [] },
      ];
      const result = resolveMultiple('We saw Alice Cooper at the show', people);
      expect(result).toHaveLength(1);
      expect(result[0].personId).toBe('p2');
    });

    it('matches both when they appear as separate mentions', () => {
      const people: ResolvedPerson[] = [
        { personId: 'p1', name: 'Alice', surfaces: [] },
        { personId: 'p2', name: 'Alice Cooper', surfaces: [] },
      ];
      const result = resolveMultiple('Alice Cooper is different from Alice', people);
      expect(result).toHaveLength(2);
      expect(new Set(result.map((r) => r.personId))).toEqual(new Set(['p1', 'p2']));
    });
  });

  describe('expandSearchTermsFromText (Python recall expansion)', () => {
    it('returns surfaces NOT already in the query text', () => {
      const people: ResolvedPerson[] = [
        {
          personId: 'p1',
          name: 'Sarah Johnson',
          surfaces: ['Sarah', 'spouse', 'sarah@home.com'],
        },
      ];
      // Query uses "spouse" — "Sarah" + email should be the expansion terms.
      const terms = expandSearchTermsFromText('what does my spouse like', people);
      expect(terms).toEqual(expect.arrayContaining(['Sarah', 'sarah@home.com']));
      expect(terms).not.toContain('spouse');
    });

    it('returns [] when no person mentioned', () => {
      const people: ResolvedPerson[] = [
        { personId: 'p1', name: 'Sarah', surfaces: ['spouse'] },
      ];
      expect(expandSearchTermsFromText('random unrelated query', people)).toEqual([]);
    });
  });

  describe('ResolvedPerson carries contactDid + relationshipHint', () => {
    it('round-trips contactDid + relationshipHint via resolveMultiple', () => {
      const people: ResolvedPerson[] = [
        {
          personId: 'p1',
          name: 'Alice',
          surfaces: [],
          contactDid: 'did:plc:alice',
          relationshipHint: 'colleague',
        },
      ];
      const result = resolveMultiple('Talked to Alice', people);
      expect(result[0].contactDid).toBe('did:plc:alice');
      expect(result[0].relationshipHint).toBe('colleague');
    });
  });
});
