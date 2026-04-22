/**
 * IntentClassifier tests (WM-BRAIN-02 + WM-TEST-02).
 *
 * Ported from main-dina's `brain/tests/test_intent_classifier.py`.
 * Each group below mirrors the Python test file:
 *
 *   parse    — LLM-output → typed classification
 *   coerce   — schema-violation handling
 *   default  — `IntentClassifier.default()` contract
 *   toc     — `renderTocForPrompt` output
 *   classify — `.classify()` end-to-end seams (ToC fetcher + LLM fail)
 */

import {
  IntentClassifier,
  parseIntentClassification,
  renderTocForPrompt,
  type IntentClassification,
} from '../../src/reasoning/intent_classifier';
import type { TocEntry } from '../../../core/src/memory/domain';

function fakeLLM(response: string): jest.Mock {
  return jest.fn(async () => response);
}

function tocEntry(partial: Partial<TocEntry>): TocEntry {
  return {
    persona: 'general',
    topic: 'x',
    kind: 'theme',
    salience: 1,
    last_update: 1_700_000_000,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// parse — raw LLM output → IntentClassification
// ---------------------------------------------------------------------------

describe('parseIntentClassification — parse', () => {
  it('plain_json', () => {
    const raw = JSON.stringify({
      sources: ['vault'],
      relevant_personas: ['health'],
      toc_evidence: {},
      temporal: 'static',
      reasoning_hint: 'use vault',
    });
    expect(parseIntentClassification(raw)).toEqual({
      sources: ['vault'],
      relevant_personas: ['health'],
      toc_evidence: {},
      temporal: 'static',
      reasoning_hint: 'use vault',
    });
  });

  it('strips_code_fence', () => {
    const raw =
      '```json\n{"sources":["vault"],"relevant_personas":[],"toc_evidence":{},"temporal":"","reasoning_hint":""}\n```';
    expect(parseIntentClassification(raw).sources).toEqual(['vault']);
  });

  it('empty_returns_empty_dict — empty string input → default', () => {
    expect(parseIntentClassification('')).toEqual(IntentClassifier.default());
  });

  it('invalid_json_returns_empty — garbage → default', () => {
    expect(parseIntentClassification('not json at all')).toEqual(IntentClassifier.default());
  });

  it('non_object_returns_empty — e.g. a bare array or number → default', () => {
    expect(parseIntentClassification('[1, 2, 3]')).toEqual(IntentClassifier.default());
    expect(parseIntentClassification('42')).toEqual(IntentClassifier.default());
  });
});

// ---------------------------------------------------------------------------
// coerce — schema-violation handling
// ---------------------------------------------------------------------------

describe('parseIntentClassification — coerce', () => {
  it('filters_unknown_sources (keeps only the 4 valid literals)', () => {
    const raw = JSON.stringify({
      sources: ['vault', 'pinterest', 'trust_network', 42, ''],
      relevant_personas: [],
      toc_evidence: {},
      temporal: '',
      reasoning_hint: '',
    });
    expect(parseIntentClassification(raw).sources).toEqual(['vault', 'trust_network']);
  });

  it('all_unknown_sources_fallback_to_vault', () => {
    const raw = JSON.stringify({
      sources: ['pinterest', 'spotify'],
      relevant_personas: [],
      toc_evidence: {},
      temporal: '',
      reasoning_hint: '',
    });
    expect(parseIntentClassification(raw).sources).toEqual(['vault']);
  });

  it('missing_sources_fallback_to_vault', () => {
    // `sources` absent from the object.
    const raw = JSON.stringify({
      relevant_personas: [],
      toc_evidence: {},
      temporal: '',
      reasoning_hint: '',
    });
    expect(parseIntentClassification(raw).sources).toEqual(['vault']);
  });

  it('accepts_provider_services', () => {
    const raw = JSON.stringify({
      sources: ['provider_services'],
      relevant_personas: [],
      toc_evidence: {},
      temporal: '',
      reasoning_hint: '',
    });
    expect(parseIntentClassification(raw).sources).toEqual(['provider_services']);
  });

  it('filters_unknown_temporal → ""', () => {
    const raw = JSON.stringify({
      sources: ['vault'],
      relevant_personas: [],
      toc_evidence: {},
      temporal: 'future_tense',
      reasoning_hint: '',
    });
    expect(parseIntentClassification(raw).temporal).toBe('');
  });

  it('accepts_live_state', () => {
    const raw = JSON.stringify({
      sources: ['vault'],
      relevant_personas: [],
      toc_evidence: {},
      temporal: 'live_state',
      reasoning_hint: '',
    });
    expect(parseIntentClassification(raw).temporal).toBe('live_state');
  });

  it('non_dict_toc_evidence_becomes_empty', () => {
    // Array at the `toc_evidence` slot — Python `dict` check fails.
    const raw = JSON.stringify({
      sources: ['vault'],
      relevant_personas: [],
      toc_evidence: ['nope'],
      temporal: '',
      reasoning_hint: '',
    });
    expect(parseIntentClassification(raw).toc_evidence).toEqual({});
  });

  it('preserves_toc_evidence_structure', () => {
    const raw = JSON.stringify({
      sources: ['vault', 'provider_services'],
      relevant_personas: ['health'],
      toc_evidence: {
        entity_matches: ['Dr Carl'],
        theme_matches: ['knee rehab'],
        persona_context: { health: ['Dr Carl', 'knee rehab'] },
      },
      temporal: 'live_state',
      reasoning_hint: 'ask Dr Carl',
    });
    const out = parseIntentClassification(raw);
    expect(out.toc_evidence).toEqual({
      entity_matches: ['Dr Carl'],
      theme_matches: ['knee rehab'],
      persona_context: { health: ['Dr Carl', 'knee rehab'] },
    });
  });

  it('non_string_reasoning_hint_becomes_empty', () => {
    const raw = JSON.stringify({
      sources: ['vault'],
      relevant_personas: [],
      toc_evidence: {},
      temporal: '',
      reasoning_hint: 42,
    });
    expect(parseIntentClassification(raw).reasoning_hint).toBe('');
  });

  it('returns_intent_classification — typed shape, no extra fields', () => {
    const raw = JSON.stringify({
      sources: ['vault'],
      relevant_personas: ['health'],
      toc_evidence: {},
      temporal: 'static',
      reasoning_hint: 'use vault',
      extra: 'dropped',
    });
    const out = parseIntentClassification(raw);
    expect(Object.keys(out).sort()).toEqual([
      'reasoning_hint',
      'relevant_personas',
      'sources',
      'temporal',
      'toc_evidence',
    ]);
    expect((out as IntentClassification & { extra?: unknown }).extra).toBeUndefined();
  });

  it('drops unexpected fields from toc_evidence', () => {
    // LLMs occasionally emit extra keys. The coercion is strict:
    // only the typed slots (`entity_matches`, `theme_matches`,
    // `persona_context`) are carried through; everything else is
    // silently dropped so unexpected shapes never poison downstream
    // consumers.
    const raw = JSON.stringify({
      sources: ['provider_services'],
      relevant_personas: [],
      toc_evidence: {
        entity_matches: ['Dr Carl'],
        some_made_up_field: [{ foo: 'bar' }],
      },
      temporal: 'live_state',
      reasoning_hint: '',
    });
    const out = parseIntentClassification(raw);
    expect(out.toc_evidence.entity_matches).toEqual(['Dr Carl']);
    expect((out.toc_evidence as Record<string, unknown>).some_made_up_field).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// default
// ---------------------------------------------------------------------------

describe('IntentClassifier.default', () => {
  it('default_is_conservative (sources=["vault"], everything else empty)', () => {
    const d = IntentClassifier.default();
    expect(d).toEqual({
      sources: ['vault'],
      relevant_personas: [],
      toc_evidence: {},
      temporal: '',
      reasoning_hint: '',
    });
  });

  it('to_dict_roundtrip — JSON round-trip is lossless', () => {
    const d = IntentClassifier.default();
    const round = JSON.parse(JSON.stringify(d));
    expect(round).toEqual(d);
  });

  it('returns a fresh instance (mutations do not leak into future defaults)', () => {
    const d1 = IntentClassifier.default();
    d1.sources.push('provider_services');
    d1.relevant_personas.push('health');
    d1.reasoning_hint = 'mutated';
    const d2 = IntentClassifier.default();
    expect(d2.sources).toEqual(['vault']);
    expect(d2.relevant_personas).toEqual([]);
    expect(d2.reasoning_hint).toBe('');
  });
});

// ---------------------------------------------------------------------------
// renderTocForPrompt
// ---------------------------------------------------------------------------

describe('renderTocForPrompt', () => {
  it('empty_message — sentinel for the classifier prompt', () => {
    expect(renderTocForPrompt([])).toBe('(empty — user has not captured any topics yet)');
  });

  it('groups_by_persona', () => {
    const entries = [
      tocEntry({ persona: 'health', topic: 'Dr Carl', kind: 'entity' }),
      tocEntry({ persona: 'health', topic: 'knee rehab' }),
      tocEntry({ persona: 'finance', topic: 'HDFC FD', kind: 'entity' }),
    ];
    expect(renderTocForPrompt(entries)).toBe('health: Dr Carl, knee rehab\nfinance: HDFC FD');
  });

  it('missing_persona_defaults_to_general', () => {
    // persona explicitly empty string — bucket under "general".
    const entries = [tocEntry({ persona: '', topic: 'x' })];
    expect(renderTocForPrompt(entries)).toBe('general: x');
  });
});

// ---------------------------------------------------------------------------
// .classify() — end-to-end seams
// ---------------------------------------------------------------------------

describe('IntentClassifier.classify', () => {
  const tocFixture: TocEntry[] = [
    tocEntry({ persona: 'health', topic: 'Dr Carl', kind: 'entity' }),
  ];

  it('feeds the rendered ToC + query to the LLM', async () => {
    const llm = fakeLLM(
      JSON.stringify({
        sources: ['vault'],
        relevant_personas: ['health'],
        toc_evidence: {},
        temporal: 'static',
        reasoning_hint: '',
      }),
    );
    const classifier = new IntentClassifier({
      llm,
      tocFetcher: async () => tocFixture,
    });
    const out = await classifier.classify('what did Dr Carl say');
    expect(out.sources).toEqual(['vault']);
    expect(out.relevant_personas).toEqual(['health']);
    const [system, userPrompt] = llm.mock.calls[0];
    expect(system).toContain('Intent Classifier for Dina');
    expect(userPrompt).toContain('Table of Contents');
    expect(userPrompt).toContain('health: Dr Carl');
    expect(userPrompt).toContain('Query:\nwhat did Dr Carl say');
  });

  it('returns default on empty query (no LLM / ToC call)', async () => {
    const llm = fakeLLM('{}');
    const tocFetcher = jest.fn(async () => tocFixture);
    const classifier = new IntentClassifier({ llm, tocFetcher });
    const out = await classifier.classify('   ');
    expect(out).toEqual(IntentClassifier.default());
    expect(tocFetcher).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
  });

  it('returns default when the ToC fetcher throws', async () => {
    const llm = fakeLLM('{}');
    const classifier = new IntentClassifier({
      llm,
      tocFetcher: async () => {
        throw new Error('core unreachable');
      },
    });
    const out = await classifier.classify('anything');
    expect(out).toEqual(IntentClassifier.default());
    expect(llm).not.toHaveBeenCalled();
  });

  it('returns default when the LLM throws', async () => {
    const classifier = new IntentClassifier({
      llm: jest.fn(async () => {
        throw new Error('timeout');
      }),
      tocFetcher: async () => tocFixture,
    });
    const out = await classifier.classify('anything');
    expect(out).toEqual(IntentClassifier.default());
  });

  it('handles a non-array ToC defensively (treats as empty)', async () => {
    const llm = fakeLLM(
      JSON.stringify({
        sources: ['vault'],
        relevant_personas: [],
        toc_evidence: {},
        temporal: '',
        reasoning_hint: '',
      }),
    );
    const classifier = new IntentClassifier({
      llm,
      // Core contract returns TocEntry[]; defensive behaviour for
      // broken impls — treat as empty ToC rather than throw.
      tocFetcher: async () => null as unknown as TocEntry[],
    });
    const out = await classifier.classify('q');
    expect(out.sources).toEqual(['vault']);
    const [, userPrompt] = llm.mock.calls[0];
    expect(userPrompt).toContain('(empty — user has not captured any topics yet)');
  });
});
