/**
 * Task 5.37 — EnrichmentService tests.
 */

import {
  ENRICHMENT_PROMPT_VERSION,
  EnrichmentService,
  generateL0Deterministic,
  type EmbedFn,
  type EnrichmentEvent,
  type EnrichmentItem,
  type EnrichmentLlmFn,
  type EnrichmentOutcome,
  type ScrubFn,
} from '../src/brain/enrichment';

/** 2026-03-21T00:00:00Z. */
const MARCH_21_2026_S = Math.floor(Date.UTC(2026, 2, 21) / 1000);

function stubLlm(content: string): EnrichmentLlmFn {
  return async () => ({ content });
}

function stubEmbed(dims = 8): EmbedFn {
  return async () => new Array(dims).fill(0.125);
}

const BASE_ITEM: EnrichmentItem = {
  id: 'item-1',
  bodyText: 'Board meeting Tuesday at 3pm with Alice about Q2 planning.',
  summary: 'Board meeting Tuesday',
  sender: 'alice@example.com',
  type: 'email',
  source: 'gmail',
  timestamp: MARCH_21_2026_S,
};

describe('generateL0Deterministic', () => {
  it('builds a compact L0 from full metadata', () => {
    const l0 = generateL0Deterministic(BASE_ITEM);
    expect(l0).toBe('Email · from alice@example.com · Mar 21, 2026');
  });

  it('omits missing fields gracefully', () => {
    const l0 = generateL0Deterministic({ type: 'note' });
    expect(l0).toBe('Note');
  });

  it('surfaces low confidence', () => {
    const l0 = generateL0Deterministic({
      ...BASE_ITEM,
      confidence: 'low',
    });
    expect(l0).toContain('low confidence');
  });

  it('surfaces unverified sender', () => {
    const l0 = generateL0Deterministic({
      ...BASE_ITEM,
      senderTrust: 'unverified',
    });
    expect(l0).toContain('unverified sender');
  });

  it('replaces underscores in type names', () => {
    const l0 = generateL0Deterministic({ type: 'calendar_event' });
    expect(l0).toBe('Calendar event');
  });

  it('falls back to summary when no metadata at all', () => {
    const l0 = generateL0Deterministic({ summary: 'Quick note' });
    expect(l0).toBe('Quick note');
  });

  it('final fallback: "(no summary available)"', () => {
    const l0 = generateL0Deterministic({});
    expect(l0).toBe('(no summary available)');
  });

  it('skips date for 0 / missing timestamp', () => {
    const l0 = generateL0Deterministic({ type: 'email', timestamp: 0 });
    expect(l0).toBe('Email');
  });

  it('skips date for NaN / invalid timestamp', () => {
    const l0 = generateL0Deterministic({ type: 'email', timestamp: NaN });
    expect(l0).toBe('Email');
  });
});

describe('EnrichmentService (task 5.37)', () => {
  describe('construction', () => {
    it('throws without llmCallFn', () => {
      expect(
        () =>
          new EnrichmentService({
            llmCallFn: undefined as unknown as EnrichmentLlmFn,
            embedFn: stubEmbed(),
          }),
      ).toThrow(/llmCallFn/);
    });

    it('throws without embedFn', () => {
      expect(
        () =>
          new EnrichmentService({
            llmCallFn: stubLlm('x'),
            embedFn: undefined as unknown as EmbedFn,
          }),
      ).toThrow(/embedFn/);
    });
  });

  describe('happy path', () => {
    it('produces L0 + L1 + embedding', async () => {
      const s = new EnrichmentService({
        llmCallFn: stubLlm('L1 paragraph: Board meeting Tuesday 3pm with Alice.'),
        embedFn: stubEmbed(8),
      });
      const r = (await s.enrich(BASE_ITEM)) as Extract<
        EnrichmentOutcome,
        { ok: true }
      >;
      expect(r.ok).toBe(true);
      expect(r.enriched.contentL0).toContain('Email');
      expect(r.enriched.contentL1).toContain('Board meeting');
      expect(r.enriched.embedding).toHaveLength(8);
      expect(r.enriched.enrichmentStatus).toBe('complete');
      expect(r.enriched.enrichmentVersion).toBe(ENRICHMENT_PROMPT_VERSION);
    });

    it('ENRICHMENT_PROMPT_VERSION is exposed', () => {
      expect(typeof ENRICHMENT_PROMPT_VERSION).toBe('number');
    });

    it('embedding is from L1 (not raw body)', async () => {
      let embeddedInput = '';
      const embedFn: EmbedFn = async (text) => {
        embeddedInput = text;
        return [0.1, 0.2, 0.3];
      };
      const s = new EnrichmentService({
        llmCallFn: stubLlm('CLEAN L1 SUMMARY'),
        embedFn,
      });
      await s.enrich(BASE_ITEM);
      expect(embeddedInput).toBe('CLEAN L1 SUMMARY');
      expect(embeddedInput).not.toContain(BASE_ITEM.bodyText);
    });

    it('fires events for each stage', async () => {
      const events: EnrichmentEvent[] = [];
      const s = new EnrichmentService({
        llmCallFn: stubLlm('L1 text'),
        embedFn: stubEmbed(),
        onEvent: (e) => events.push(e),
      });
      await s.enrich(BASE_ITEM);
      const kinds = events.map((e) => e.kind).sort();
      expect(kinds).toEqual(['embedded', 'l0_deterministic', 'l1_generated']);
    });

    it('uses summary as LLM input when bodyText is empty', async () => {
      let prompt = '';
      const s = new EnrichmentService({
        llmCallFn: async (p) => {
          prompt = p;
          return { content: 'summary-based L1' };
        },
        embedFn: stubEmbed(),
      });
      await s.enrich({ ...BASE_ITEM, bodyText: '' });
      expect(prompt).toContain('Board meeting Tuesday'); // summary flowed in
    });
  });

  describe('failure paths', () => {
    it('no body + no summary → no_input', async () => {
      const s = new EnrichmentService({
        llmCallFn: stubLlm('x'),
        embedFn: stubEmbed(),
      });
      const r = await s.enrich({ id: 'x', type: 'email' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('no_input');
    });

    it('whitespace-only body + summary → no_input', async () => {
      const s = new EnrichmentService({
        llmCallFn: stubLlm('x'),
        embedFn: stubEmbed(),
      });
      const r = await s.enrich({ bodyText: '   ', summary: '\n\t' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('no_input');
    });

    it('scrub throws → scrub_failed', async () => {
      const scrubFn: ScrubFn = async () => {
        throw new Error('scrubber offline');
      };
      const s = new EnrichmentService({
        llmCallFn: stubLlm('x'),
        embedFn: stubEmbed(),
        scrubFn,
      });
      const r = await s.enrich(BASE_ITEM);
      expect(r.ok).toBe(false);
      if (r.ok === false && r.reason === 'scrub_failed') {
        expect(r.error).toMatch(/scrubber offline/);
      }
    });

    it('LLM throws → llm_failed', async () => {
      const s = new EnrichmentService({
        llmCallFn: async () => {
          throw new Error('LLM quota');
        },
        embedFn: stubEmbed(),
      });
      const r = await s.enrich(BASE_ITEM);
      expect(r.ok).toBe(false);
      if (r.ok === false && r.reason === 'llm_failed') {
        expect(r.error).toMatch(/LLM quota/);
      }
    });

    it('LLM returns empty → llm_empty', async () => {
      const s = new EnrichmentService({
        llmCallFn: stubLlm('   '),
        embedFn: stubEmbed(),
      });
      const r = await s.enrich(BASE_ITEM);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('llm_empty');
    });

    it('embed throws → embed_failed', async () => {
      const s = new EnrichmentService({
        llmCallFn: stubLlm('L1'),
        embedFn: async () => {
          throw new Error('embedding service down');
        },
      });
      const r = await s.enrich(BASE_ITEM);
      expect(r.ok).toBe(false);
      if (r.ok === false && r.reason === 'embed_failed') {
        expect(r.error).toMatch(/embedding service down/);
      }
    });

    it('embed returns empty vector → embed_failed', async () => {
      const s = new EnrichmentService({
        llmCallFn: stubLlm('L1'),
        embedFn: async () => [],
      });
      const r = await s.enrich(BASE_ITEM);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('embed_failed');
    });

    it('embed returns non-array → embed_failed', async () => {
      const s = new EnrichmentService({
        llmCallFn: stubLlm('L1'),
        embedFn: (async () =>
          'not-a-vector' as unknown as number[]) as EmbedFn,
      });
      const r = await s.enrich(BASE_ITEM);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('embed_failed');
    });
  });

  describe('PII scrubbing', () => {
    it('scrubs body + summary + sender before LLM', async () => {
      const seen: string[] = [];
      const scrubFn: ScrubFn = async (text) => `<<SCRUBBED:${text.slice(0, 5)}>>`;
      const s = new EnrichmentService({
        llmCallFn: async (p) => {
          seen.push(p);
          return { content: 'L1' };
        },
        embedFn: stubEmbed(),
        scrubFn,
      });
      await s.enrich(BASE_ITEM);
      expect(seen[0]!).toContain('<<SCRUBBED:');
      // The raw body should NOT be in the prompt.
      expect(seen[0]!).not.toContain('alice@example.com');
      expect(seen[0]!).not.toContain('Board meeting Tuesday at 3pm');
    });

    it('scrubs run in parallel — all 3 inputs go at once', async () => {
      // Timing-independent: count how many scrub calls are simultaneously
      // in flight. Parallel execution → peak concurrency = 3.
      let inFlight = 0;
      let peak = 0;
      let releaseAll!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseAll = resolve;
      });
      const scrubFn: ScrubFn = async (text) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await gate;
        inFlight--;
        return text;
      };
      const s = new EnrichmentService({
        llmCallFn: stubLlm('L1'),
        embedFn: stubEmbed(),
        scrubFn,
      });
      const enrichPromise = s.enrich(BASE_ITEM);
      // Let the three scrub calls register before we release them.
      await new Promise((r) => setImmediate(r));
      expect(peak).toBe(3);
      releaseAll();
      await enrichPromise;
    });

    it('without scrubFn, body/summary/sender flow to LLM untouched', async () => {
      const seen: string[] = [];
      const s = new EnrichmentService({
        llmCallFn: async (p) => {
          seen.push(p);
          return { content: 'L1' };
        },
        embedFn: stubEmbed(),
      });
      await s.enrich(BASE_ITEM);
      expect(seen[0]!).toContain('alice@example.com');
      expect(seen[0]!).toContain('Board meeting Tuesday at 3pm');
    });
  });

  describe('L0 deterministic generation', () => {
    it('L0 is produced BEFORE the LLM call (no LLM dependency)', async () => {
      const events: EnrichmentEvent[] = [];
      let llmCalled = false;
      const s = new EnrichmentService({
        llmCallFn: async () => {
          llmCalled = true;
          return { content: 'L1' };
        },
        embedFn: stubEmbed(),
        onEvent: (e) => events.push(e),
      });
      await s.enrich(BASE_ITEM);
      const l0Idx = events.findIndex((e) => e.kind === 'l0_deterministic');
      const l1Idx = events.findIndex((e) => e.kind === 'l1_generated');
      expect(l0Idx).toBeGreaterThan(-1);
      expect(l0Idx).toBeLessThan(l1Idx);
      expect(llmCalled).toBe(true);
    });
  });
});
