/**
 * Task 5.31 — IntentClassifier tests.
 */

import {
  IntentClassifier,
  coerceRaw,
  defaultClassification,
  type IntentClassifierEvent,
  type IntentLlmCallFn,
  type TocEntry,
  type TocFetcherFn,
} from '../src/brain/intent_classifier';

function stubLlm(content: unknown): IntentLlmCallFn {
  return async () => ({
    content: typeof content === 'string' ? content : JSON.stringify(content),
  });
}

describe('IntentClassifier (task 5.31)', () => {
  describe('construction', () => {
    it('throws on missing llmCallFn', () => {
      expect(
        () =>
          new IntentClassifier({
            llmCallFn: undefined as unknown as IntentLlmCallFn,
          }),
      ).toThrow(/llmCallFn/);
    });
  });

  describe('happy path', () => {
    it('parses a valid LLM response into IntentClassification', async () => {
      const c = new IntentClassifier({
        llmCallFn: stubLlm({
          sources: ['vault', 'provider_services'],
          relevant_personas: ['health'],
          toc_evidence: {
            entity_matches: ['Dr Carl'],
            theme_matches: [],
          },
          temporal: 'live_state',
          reasoning_hint: 'Needs live data + user context.',
        }),
      });
      const r = await c.classify('when does my dentist open?');
      expect(r.sources).toEqual(['vault', 'provider_services']);
      expect(r.relevantPersonas).toEqual(['health']);
      expect(r.temporal).toBe('live_state');
      expect(r.reasoningHint).toBe('Needs live data + user context.');
      expect(r.tocEvidence.entity_matches).toEqual(['Dr Carl']);
    });

    it('accepts ```json``` fenced responses', async () => {
      const c = new IntentClassifier({
        llmCallFn: stubLlm(
          '```json\n{"sources":["vault"],"temporal":"static"}\n```',
        ),
      });
      const r = await c.classify('what did I say about X?');
      expect(r.sources).toEqual(['vault']);
      expect(r.temporal).toBe('static');
    });

    it('calls the tocFetcher + passes ToC into the prompt', async () => {
      const seen: string[] = [];
      const tocFetcherFn: TocFetcherFn = async () => [
        { persona: 'health', topic: 'dentist' },
        { persona: 'work', topic: 'project-X' },
      ];
      const llmCallFn: IntentLlmCallFn = async (prompt) => {
        seen.push(prompt);
        return { content: '{"sources":["vault"]}' };
      };
      const c = new IntentClassifier({ llmCallFn, tocFetcherFn });
      await c.classify('about my dentist');
      expect(seen[0]!).toContain('dentist');
      expect(seen[0]!).toContain('project-X');
      expect(seen[0]!).toContain('health:');
      expect(seen[0]!).toContain('work:');
    });

    it('renders empty ToC as "(empty — ...)"', async () => {
      const seen: string[] = [];
      const tocFetcherFn: TocFetcherFn = async () => [];
      const llmCallFn: IntentLlmCallFn = async (prompt) => {
        seen.push(prompt);
        return { content: '{"sources":["vault"]}' };
      };
      const c = new IntentClassifier({ llmCallFn, tocFetcherFn });
      await c.classify('hello');
      expect(seen[0]!).toMatch(/empty/);
    });

    it('ToC entries with empty topic are skipped', async () => {
      const seen: string[] = [];
      const tocFetcherFn: TocFetcherFn = async () => [
        { persona: 'health', topic: '' }, // skipped
        { persona: 'health', topic: 'dentist' },
      ];
      const llmCallFn: IntentLlmCallFn = async (prompt) => {
        seen.push(prompt);
        return { content: '{"sources":["vault"]}' };
      };
      const c = new IntentClassifier({ llmCallFn, tocFetcherFn });
      await c.classify('x');
      expect(seen[0]!).toContain('health: dentist');
    });

    it('ToC entries without persona default to "general"', async () => {
      const seen: string[] = [];
      const tocFetcherFn: TocFetcherFn = async () => [
        { persona: '' as unknown as string, topic: 'floating-topic' },
      ];
      const llmCallFn: IntentLlmCallFn = async (prompt) => {
        seen.push(prompt);
        return { content: '{"sources":["vault"]}' };
      };
      const c = new IntentClassifier({ llmCallFn, tocFetcherFn });
      await c.classify('x');
      expect(seen[0]!).toContain('general: floating-topic');
    });

    it('fires classified event with sources + temporal', async () => {
      const events: IntentClassifierEvent[] = [];
      const c = new IntentClassifier({
        llmCallFn: stubLlm({
          sources: ['vault'],
          temporal: 'static',
        }),
        onEvent: (e) => events.push(e),
      });
      await c.classify('what did I say?');
      const classified = events.find(
        (e) => e.kind === 'classified',
      ) as Extract<IntentClassifierEvent, { kind: 'classified' }>;
      expect(classified.sources).toEqual(['vault']);
      expect(classified.temporal).toBe('static');
    });
  });

  describe('fallback paths', () => {
    it('empty query → default + fires empty_query event', async () => {
      const events: IntentClassifierEvent[] = [];
      const c = new IntentClassifier({
        llmCallFn: async () => {
          throw new Error('should not be called');
        },
        onEvent: (e) => events.push(e),
      });
      const r = await c.classify('');
      expect(r).toEqual(defaultClassification());
      expect(events.some((e) => e.kind === 'empty_query')).toBe(true);
    });

    it('whitespace-only query → default', async () => {
      const c = new IntentClassifier({
        llmCallFn: async () => {
          throw new Error('nope');
        },
      });
      const r = await c.classify('   \n  ');
      expect(r.reasoningHint).toMatch(/unavailable/);
    });

    it('LLM throws → default + fires llm_failed event', async () => {
      const events: IntentClassifierEvent[] = [];
      const c = new IntentClassifier({
        llmCallFn: async () => {
          throw new Error('rate limited');
        },
        onEvent: (e) => events.push(e),
      });
      const r = await c.classify('hello');
      expect(r).toEqual(defaultClassification());
      const failed = events.find(
        (e) => e.kind === 'llm_failed',
      ) as Extract<IntentClassifierEvent, { kind: 'llm_failed' }>;
      expect(failed.error).toMatch(/rate limited/);
    });

    it('LLM returns non-JSON → default + fires unparseable event', async () => {
      const events: IntentClassifierEvent[] = [];
      const c = new IntentClassifier({
        llmCallFn: stubLlm('yo this is definitely not json'),
        onEvent: (e) => events.push(e),
      });
      const r = await c.classify('hello');
      expect(r).toEqual(defaultClassification());
      expect(events.some((e) => e.kind === 'unparseable')).toBe(true);
    });

    it('LLM returns a JSON array → default (not an object)', async () => {
      const c = new IntentClassifier({ llmCallFn: stubLlm('[1,2,3]') });
      const r = await c.classify('hello');
      expect(r).toEqual(defaultClassification());
    });

    it('ToC fetcher throws → still runs LLM with empty ToC', async () => {
      const events: IntentClassifierEvent[] = [];
      const seen: string[] = [];
      const c = new IntentClassifier({
        llmCallFn: async (prompt) => {
          seen.push(prompt);
          return { content: '{"sources":["vault"]}' };
        },
        tocFetcherFn: async () => {
          throw new Error('ToC offline');
        },
        onEvent: (e) => events.push(e),
      });
      const r = await c.classify('hello');
      expect(r.sources).toEqual(['vault']);
      expect(events.some((e) => e.kind === 'toc_fetch_failed')).toBe(true);
      expect(seen[0]!).toMatch(/empty/);
    });

    it('ToC fetcher returns non-array → treated as empty', async () => {
      const seen: string[] = [];
      const c = new IntentClassifier({
        llmCallFn: async (prompt) => {
          seen.push(prompt);
          return { content: '{"sources":["vault"]}' };
        },
        tocFetcherFn: (async () => 'not-an-array') as unknown as TocFetcherFn,
      });
      await c.classify('hello');
      expect(seen[0]!).toMatch(/empty/);
    });
  });
});

describe('coerceRaw', () => {
  it('filters unknown sources', () => {
    const r = coerceRaw({
      sources: ['vault', 'made_up_source', 'trust_network'],
    });
    expect(r.sources).toEqual(['vault', 'trust_network']);
  });

  it('collapses empty source list to ["vault"] conservative default', () => {
    const r = coerceRaw({ sources: [] });
    expect(r.sources).toEqual(['vault']);
  });

  it('rejects non-string source entries', () => {
    const r = coerceRaw({ sources: ['vault', 42, null, 'provider_services'] });
    expect(r.sources).toEqual(['vault', 'provider_services']);
  });

  it('trims persona names + drops empty', () => {
    const r = coerceRaw({
      sources: ['vault'],
      relevant_personas: ['  health  ', '', 'work'],
    });
    expect(r.relevantPersonas).toEqual(['health', 'work']);
  });

  it('accepts valid temporal values', () => {
    for (const t of ['static', 'live_state', 'comparative', ''] as const) {
      expect(coerceRaw({ sources: ['vault'], temporal: t }).temporal).toBe(t);
    }
  });

  it('rejects unknown temporal value → empty string', () => {
    const r = coerceRaw({ sources: ['vault'], temporal: 'yesterday' });
    expect(r.temporal).toBe('');
  });

  it('tocEvidence non-object → {}', () => {
    expect(coerceRaw({ sources: ['vault'], toc_evidence: 'not-obj' }).tocEvidence).toEqual({});
    expect(coerceRaw({ sources: ['vault'], toc_evidence: [1, 2] }).tocEvidence).toEqual({});
    expect(coerceRaw({ sources: ['vault'], toc_evidence: null }).tocEvidence).toEqual({});
  });

  it('reasoning_hint non-string → empty string', () => {
    expect(coerceRaw({ sources: ['vault'], reasoning_hint: 123 }).reasoningHint).toBe('');
    expect(coerceRaw({ sources: ['vault'], reasoning_hint: null }).reasoningHint).toBe('');
  });

  it('empty / non-array sources → ["vault"] default', () => {
    expect(coerceRaw({}).sources).toEqual(['vault']);
    expect(coerceRaw({ sources: 'vault' }).sources).toEqual(['vault']);
  });
});

describe('defaultClassification', () => {
  it('returns a usable fallback shape', () => {
    const d = defaultClassification();
    expect(d.sources).toEqual(['vault']);
    expect(d.relevantPersonas).toEqual([]);
    expect(d.temporal).toBe('');
    expect(d.reasoningHint).toMatch(/Classifier unavailable/);
  });

  it('returns a fresh object each call (no aliasing)', () => {
    const a = defaultClassification();
    const b = defaultClassification();
    a.sources.push('trust_network');
    a.tocEvidence.mutated = true;
    expect(b.sources).toEqual(['vault']);
    expect(b.tocEvidence).toEqual({});
  });
});

describe('realistic prompts', () => {
  const fakeToc: TocEntry[] = [
    { persona: 'health', topic: 'dentist appointment' },
    { persona: 'health', topic: 'Dr Carl' },
    { persona: 'work', topic: 'Q2 roadmap' },
  ];

  it('"when does my dentist open" → vault + provider_services', async () => {
    const c = new IntentClassifier({
      llmCallFn: stubLlm({
        sources: ['vault', 'provider_services'],
        relevant_personas: ['health'],
        temporal: 'live_state',
      }),
      tocFetcherFn: async () => fakeToc,
    });
    const r = await c.classify('when does my dentist open?');
    expect(r.sources).toContain('vault');
    expect(r.sources).toContain('provider_services');
    expect(r.temporal).toBe('live_state');
  });

  it('"what projects am I working on" → vault only', async () => {
    const c = new IntentClassifier({
      llmCallFn: stubLlm({
        sources: ['vault'],
        relevant_personas: ['work'],
        temporal: 'static',
      }),
      tocFetcherFn: async () => fakeToc,
    });
    const r = await c.classify('what projects am I working on?');
    expect(r.sources).toEqual(['vault']);
    expect(r.temporal).toBe('static');
  });
});
