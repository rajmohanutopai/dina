/**
 * Task 5.36 — PersonResolver + PersonLinkExtractor tests.
 */

import {
  PERSON_LINK_EXTRACTOR_VERSION,
  PersonLinkExtractor,
  PersonResolver,
  type PersonFetchFn,
  type PersonLinkExtractorEvent,
  type PersonLinkLlmFn,
  type PersonRecord,
  type PersonResolverEvent,
} from '../src/brain/person_resolver';

function samplePeople(): PersonRecord[] {
  return [
    {
      personId: 'person-mom',
      canonicalName: 'Sarah Johnson',
      surfaces: [
        { surface: 'Sarah Johnson', status: 'confirmed' },
        { surface: 'Mom', status: 'confirmed' },
        { surface: 'Mother', status: 'confirmed' },
        { surface: 'mommy', status: 'suggested' }, // ignored (not confirmed)
      ],
      contactDid: 'did:plc:mom',
      relationshipHint: 'parent',
    },
    {
      personId: 'person-doctor',
      canonicalName: 'Dr Carl Patel',
      surfaces: [
        { surface: 'Dr Carl Patel', status: 'confirmed' },
        { surface: 'Dr Carl', status: 'confirmed' },
      ],
      relationshipHint: 'doctor',
    },
    {
      personId: 'person-rejected',
      canonicalName: 'Rejected',
      status: 'rejected',
      surfaces: [{ surface: 'Rejected', status: 'confirmed' }],
    },
  ];
}

describe('PersonResolver (task 5.36)', () => {
  describe('construction', () => {
    it('throws on missing fetchFn', () => {
      expect(
        () =>
          new PersonResolver({ fetchFn: undefined as unknown as PersonFetchFn }),
      ).toThrow(/fetchFn/);
    });
  });

  describe('refresh + pattern build', () => {
    it('loads people + builds patterns for confirmed surfaces', async () => {
      const events: PersonResolverEvent[] = [];
      const r = new PersonResolver({
        fetchFn: async () => samplePeople(),
        onEvent: (e) => events.push(e),
      });
      await r.refresh();
      // 2 active people (rejected skipped). 3 + 2 confirmed surfaces = 5 patterns.
      expect(r.peopleCount()).toBe(2);
      expect(r.patternCount()).toBe(5);
      expect(events.some((e) => e.kind === 'loaded')).toBe(true);
    });

    it('skips rejected persons entirely', async () => {
      const r = new PersonResolver({ fetchFn: async () => samplePeople() });
      await r.refresh();
      const matches = r.resolve('Rejected says hi');
      expect(matches).toEqual([]);
    });

    it('ignores non-confirmed surfaces', async () => {
      const r = new PersonResolver({ fetchFn: async () => samplePeople() });
      await r.refresh();
      // "mommy" is suggested → should NOT match.
      const matches = r.resolve('call mommy later');
      expect(matches).toEqual([]);
    });

    it('refresh failure keeps last-known-good cache', async () => {
      let fail = false;
      const events: PersonResolverEvent[] = [];
      const r = new PersonResolver({
        fetchFn: async () => {
          if (fail) throw new Error('Core down');
          return samplePeople();
        },
        onEvent: (e) => events.push(e),
      });
      await r.refresh();
      const initial = r.patternCount();
      fail = true;
      await r.refresh();
      expect(r.patternCount()).toBe(initial); // cache preserved
      expect(events.some((e) => e.kind === 'refresh_failed_kept_cache')).toBe(true);
    });

    it('concurrent refresh calls coalesce', async () => {
      let calls = 0;
      const r = new PersonResolver({
        fetchFn: async () => {
          calls++;
          await new Promise((x) => setImmediate(x));
          return samplePeople();
        },
      });
      await Promise.all([r.refresh(), r.refresh(), r.refresh()]);
      expect(calls).toBe(1);
    });

    it('minSurfaceLength filters short surfaces', async () => {
      const r = new PersonResolver({
        fetchFn: async () => [
          {
            personId: 'p1',
            canonicalName: 'Jo',
            surfaces: [
              { surface: 'Jo', status: 'confirmed' },
              { surface: 'Joe', status: 'confirmed' },
              { surface: 'X', status: 'confirmed' },
            ],
          },
        ],
        minSurfaceLength: 3,
      });
      await r.refresh();
      expect(r.patternCount()).toBe(1); // only 'Joe'
    });
  });

  describe('resolve', () => {
    it('returns matched person with full confirmed surface list', async () => {
      const r = new PersonResolver({ fetchFn: async () => samplePeople() });
      await r.refresh();
      const matches = r.resolve('I spoke with Mom yesterday');
      expect(matches).toHaveLength(1);
      expect(matches[0]!.personId).toBe('person-mom');
      expect(matches[0]!.canonicalName).toBe('Sarah Johnson');
      expect(matches[0]!.surfaces.sort()).toEqual([
        'Mom',
        'Mother',
        'Sarah Johnson',
      ]);
      expect(matches[0]!.contactDid).toBe('did:plc:mom');
      expect(matches[0]!.relationshipHint).toBe('parent');
    });

    it('one entry per distinct person even with multiple surface matches', async () => {
      const r = new PersonResolver({ fetchFn: async () => samplePeople() });
      await r.refresh();
      const matches = r.resolve(
        'Mom called Mother about Sarah Johnson yesterday',
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]!.personId).toBe('person-mom');
    });

    it('different persons yield separate entries', async () => {
      const r = new PersonResolver({ fetchFn: async () => samplePeople() });
      await r.refresh();
      const matches = r.resolve('Mom drove me to Dr Carl yesterday');
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.personId).sort()).toEqual([
        'person-doctor',
        'person-mom',
      ]);
    });

    it('longest-first: "Dr Carl Patel" beats "Dr Carl"', async () => {
      const events: PersonResolverEvent[] = [];
      const r = new PersonResolver({
        fetchFn: async () => samplePeople(),
        onEvent: (e) => events.push(e),
      });
      await r.refresh();
      r.resolve('Appointment with Dr Carl Patel Tuesday');
      const resolved = events.filter((e) => e.kind === 'resolved');
      expect(resolved).toHaveLength(1);
      // Expected span covers "Dr Carl Patel" (13 chars).
      const span = (resolved[0] as Extract<PersonResolverEvent, { kind: 'resolved' }>).span;
      expect(span[1] - span[0]).toBe(13);
    });

    it('empty / non-string input → []', async () => {
      const r = new PersonResolver({ fetchFn: async () => samplePeople() });
      await r.refresh();
      expect(r.resolve('')).toEqual([]);
      expect(r.resolve(null as unknown as string)).toEqual([]);
    });

    it('resolve before refresh → []', () => {
      const r = new PersonResolver({ fetchFn: async () => samplePeople() });
      expect(r.resolve('Mom says hi')).toEqual([]);
    });

    it('case-insensitive surface matching', async () => {
      const r = new PersonResolver({ fetchFn: async () => samplePeople() });
      await r.refresh();
      const matches = r.resolve('saw MOM yesterday');
      expect(matches[0]!.personId).toBe('person-mom');
    });

    it('word boundaries — no match inside another word', async () => {
      const r = new PersonResolver({ fetchFn: async () => samplePeople() });
      await r.refresh();
      expect(r.resolve('mommysays').length).toBe(0);
    });
  });

  describe('expandSearchTerms', () => {
    it('returns surfaces NOT already in the query', async () => {
      const r = new PersonResolver({ fetchFn: async () => samplePeople() });
      await r.refresh();
      const expanded = r.expandSearchTerms('messages from Mom');
      // "Mom" is in query → skip. Adds "Mother" + "Sarah Johnson".
      expect(expanded.sort()).toEqual(['Mother', 'Sarah Johnson']);
    });

    it('deduplicates across multiple persons', async () => {
      const r = new PersonResolver({ fetchFn: async () => samplePeople() });
      await r.refresh();
      const expanded = r.expandSearchTerms(
        'Mom and Dr Carl had lunch',
      );
      expect(expanded).toContain('Mother');
      expect(expanded).toContain('Sarah Johnson');
      expect(expanded).toContain('Dr Carl Patel');
    });

    it('no mention → empty expansion', async () => {
      const r = new PersonResolver({ fetchFn: async () => samplePeople() });
      await r.refresh();
      expect(r.expandSearchTerms('nobody here')).toEqual([]);
    });
  });
});

describe('PersonLinkExtractor (task 5.36)', () => {
  describe('construction', () => {
    it('throws on missing llmCallFn', () => {
      expect(
        () =>
          new PersonLinkExtractor({
            llmCallFn: undefined as unknown as PersonLinkLlmFn,
          }),
      ).toThrow(/llmCallFn/);
    });
  });

  describe('happy path', () => {
    it('extracts identity links from LLM JSON', async () => {
      const events: PersonLinkExtractorEvent[] = [];
      const llmCallFn: PersonLinkLlmFn = async () => ({
        content: JSON.stringify({
          identity_links: [
            {
              name: 'Dr Carl Patel',
              rolePhrase: 'my dentist',
              relationship: 'dentist',
              confidence: 'high',
              evidence: 'My dentist Dr Carl Patel confirmed the appointment',
            },
          ],
        }),
      });
      const ex = new PersonLinkExtractor({
        llmCallFn,
        onEvent: (e) => events.push(e),
      });
      const r = await ex.extract(
        'My dentist Dr Carl Patel confirmed the appointment',
        'item-123',
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.result.sourceItemId).toBe('item-123');
      expect(r.result.extractorVersion).toBe(PERSON_LINK_EXTRACTOR_VERSION);
      expect(r.result.results).toHaveLength(1);
      expect(r.result.results[0]!.canonicalName).toBe('Dr Carl Patel');
      expect(r.result.results[0]!.relationshipHint).toBe('dentist');
      expect(r.result.results[0]!.surfaces).toHaveLength(2);
      expect(r.result.results[0]!.surfaces[0]!.confidence).toBe('high');
      expect(events.some((e) => e.kind === 'extracted')).toBe(true);
    });

    it('accepts ```json``` fence', async () => {
      const llmCallFn: PersonLinkLlmFn = async () => ({
        content:
          '```json\n{"identity_links":[{"name":"Alice","relationship":"friend","confidence":"high"}]}\n```',
      });
      const ex = new PersonLinkExtractor({ llmCallFn });
      const r = await ex.extract('Alice said hi', 'id');
      expect(r.ok).toBe(true);
    });

    it('defaults missing fields (medium confidence, "other" relationship)', async () => {
      const llmCallFn: PersonLinkLlmFn = async () => ({
        content: '{"identity_links":[{"name":"Dan"}]}',
      });
      const ex = new PersonLinkExtractor({ llmCallFn });
      const r = await ex.extract('Dan said hi', 'id');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.result.results[0]!.relationshipHint).toBe('other');
      expect(r.result.results[0]!.surfaces[0]!.confidence).toBe('medium');
    });

    it('evidence capped at 200 chars', async () => {
      const long = 'y'.repeat(500);
      const llmCallFn: PersonLinkLlmFn = async () => ({
        content: JSON.stringify({
          identity_links: [
            { name: 'Alice', confidence: 'high', evidence: long },
          ],
        }),
      });
      const ex = new PersonLinkExtractor({ llmCallFn });
      const r = await ex.extract('text', 'id');
      if (r.ok) {
        expect(r.result.results[0]!.sourceExcerpt.length).toBe(200);
      }
    });

    it('invalid confidence → medium fallback', async () => {
      const llmCallFn: PersonLinkLlmFn = async () => ({
        content: JSON.stringify({
          identity_links: [{ name: 'A', confidence: 'bogus' }],
        }),
      });
      const ex = new PersonLinkExtractor({ llmCallFn });
      const r = await ex.extract('A said hi', 'id');
      if (r.ok) {
        expect(r.result.results[0]!.surfaces[0]!.confidence).toBe('medium');
      }
    });

    it('link with role_phrase but no name still extracted', async () => {
      const llmCallFn: PersonLinkLlmFn = async () => ({
        content: JSON.stringify({
          identity_links: [
            { rolePhrase: 'my dentist', relationship: 'dentist' },
          ],
        }),
      });
      const ex = new PersonLinkExtractor({ llmCallFn });
      const r = await ex.extract('my dentist...', 'id');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.result.results[0]!.canonicalName).toBe('my dentist');
    });
  });

  describe('rejection paths', () => {
    it('empty text → empty_input', async () => {
      const ex = new PersonLinkExtractor({
        llmCallFn: async () => ({ content: '{}' }),
      });
      const r = await ex.extract('', 'id');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('empty_input');
    });

    it('whitespace-only text → empty_input', async () => {
      const ex = new PersonLinkExtractor({
        llmCallFn: async () => ({ content: '{}' }),
      });
      const r = await ex.extract('   \n  ', 'id');
      expect(r.ok).toBe(false);
    });

    it('LLM throws → llm_failed', async () => {
      const ex = new PersonLinkExtractor({
        llmCallFn: async () => {
          throw new Error('network timeout');
        },
      });
      const r = await ex.extract('text', 'id');
      expect(r.ok).toBe(false);
      if (r.ok === false && r.reason === 'llm_failed') {
        expect(r.error).toMatch(/network timeout/);
      }
    });

    it('LLM returns non-JSON → parse_failed', async () => {
      const ex = new PersonLinkExtractor({
        llmCallFn: async () => ({ content: 'not json' }),
      });
      const r = await ex.extract('text', 'id');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('parse_failed');
    });

    it('LLM returns array-root → parse_failed', async () => {
      const ex = new PersonLinkExtractor({
        llmCallFn: async () => ({ content: '[1,2,3]' }),
      });
      const r = await ex.extract('text', 'id');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('parse_failed');
    });

    it('LLM returns empty identity_links → no_usable_links', async () => {
      const ex = new PersonLinkExtractor({
        llmCallFn: async () => ({ content: '{"identity_links":[]}' }),
      });
      const r = await ex.extract('text', 'id');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('no_usable_links');
    });

    it('links with neither name nor role_phrase → no_usable_links', async () => {
      const ex = new PersonLinkExtractor({
        llmCallFn: async () => ({
          content: JSON.stringify({
            identity_links: [{ confidence: 'high' }, { relationship: 'friend' }],
          }),
        }),
      });
      const r = await ex.extract('text', 'id');
      expect(r.ok).toBe(false);
    });
  });
});
