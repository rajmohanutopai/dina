/**
 * TopicExtractor (WM-BRAIN-01) — pinned against the behaviours listed in
 * the task spec (ported from main-dina's `test_topic_extractor.py`):
 *
 *   - code-fence strip on LLM output
 *   - empty input → empty output (no spurious LLM call)
 *   - sanitise: dedup case-insensitive, drop empties, drop >80-char,
 *     drop non-strings, cap at 6 entities / 4 themes
 *   - scrub / rehydrate cycle: PII tokens don't leak into the ToC
 *   - fail-open on LLM / scrub / JSON errors
 */

import { TopicExtractor, type TopicExtractorLLM } from '../../src/enrichment/topic_extractor';
import { EntityVault } from '../../src/pii/entity_vault';
import { sanitiseList } from '../../src/llm/output_parser';

function fakeLLM(response: string): jest.Mock {
  return jest.fn(async () => response);
}

function failingLLM(msg = 'timeout'): jest.Mock {
  return jest.fn(async () => {
    throw new Error(msg);
  });
}

describe('TopicExtractor.extract', () => {
  it('parses a well-formed LLM response', async () => {
    const llm = fakeLLM(
      JSON.stringify({
        entities: ['Dr Carl', 'HDFC Bank'],
        themes: ['tax planning', 'knee rehab'],
      }),
    );
    const ex = new TopicExtractor({ llm });
    const out = await ex.extract({
      summary: 'Met Dr Carl about knee rehab; reviewed tax plan with HDFC.',
    });
    expect(out).toEqual({
      entities: ['Dr Carl', 'HDFC Bank'],
      themes: ['tax planning', 'knee rehab'],
    });
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('strips markdown code fences from the LLM output', async () => {
    const llm = fakeLLM('```json\n{"entities": ["Sancho"], "themes": ["birthday planning"]}\n```');
    const ex = new TopicExtractor({ llm });
    const out = await ex.extract({ body: 'Sancho birthday next week' });
    expect(out.entities).toEqual(['Sancho']);
    expect(out.themes).toEqual(['birthday planning']);
  });

  it('returns empty + skips the LLM on empty input', async () => {
    const llm = fakeLLM('{"entities": ["x"], "themes": ["y"]}');
    const ex = new TopicExtractor({ llm });
    const out = await ex.extract({});
    expect(out).toEqual({ entities: [], themes: [] });
    expect(llm).not.toHaveBeenCalled();
  });

  it('prefers summary over content_l0 and content_l1 over body', async () => {
    const llm = fakeLLM('{"entities": [], "themes": []}');
    const ex = new TopicExtractor({ llm });
    await ex.extract({
      summary: 'S',
      content_l0: 'L0',
      content_l1: 'L1',
      body: 'B',
    });
    const [, userPrompt] = llm.mock.calls[0];
    expect(userPrompt).toContain('Summary:\nS');
    expect(userPrompt).toContain('Content:\nL1');
    // Fallbacks NOT used when the preferred field is present.
    expect(userPrompt).not.toContain('L0');
    expect(userPrompt).not.toContain('\nB');
  });

  it('falls back to content_l0 / body when preferred fields are empty', async () => {
    const llm = fakeLLM('{"entities": [], "themes": []}');
    const ex = new TopicExtractor({ llm });
    await ex.extract({ summary: '', content_l0: 'L0', content_l1: '', body: 'B' });
    const [, userPrompt] = llm.mock.calls[0];
    expect(userPrompt).toContain('L0');
    expect(userPrompt).toContain('B');
  });

  it('caps summary at 500 and content at 2000 chars', async () => {
    const llm = fakeLLM('{"entities": [], "themes": []}');
    const ex = new TopicExtractor({ llm });
    const longSummary = 'A'.repeat(1000);
    const longContent = 'B'.repeat(5000);
    await ex.extract({ summary: longSummary, body: longContent });
    const [, userPrompt] = llm.mock.calls[0];
    // 500 A's in the summary slice, 2000 B's in the content slice.
    const aRun = userPrompt.match(/A+/)?.[0] ?? '';
    const bRun = userPrompt.match(/B+/)?.[0] ?? '';
    expect(aRun.length).toBe(500);
    expect(bRun.length).toBe(2000);
  });

  it('rehydrates PII tokens in the returned topics (no [EMAIL_N] leaks)', async () => {
    // Set up a vault that scrubs the known email, then returns a
    // fixture response that includes the token — verify it's
    // rehydrated back to the original string on the way out.
    const vault = new EntityVault();
    const llm = jest.fn(async (_sys: string, user: string) => {
      // Extract the token the extractor handed to the LLM so the test
      // stays schema-stable — the token number depends on vault state.
      const match = user.match(/\[EMAIL_\d+\]/);
      expect(match).not.toBeNull();
      return JSON.stringify({
        entities: [match![0]],
        themes: [],
      });
    });
    const ex = new TopicExtractor({ llm, createVault: () => vault });
    const out = await ex.extract({
      summary: 'Reached out to alice@example.com about knee rehab',
    });
    expect(out.entities).toEqual(['alice@example.com']);
  });

  it('sanitises the LLM response (dedup, trim, length cap, hard cap)', async () => {
    const llm = fakeLLM(
      JSON.stringify({
        entities: [
          'Dr Carl',
          '  Dr Carl  ',
          'dr carl', // dedup: first wins
          '', // drop empty
          'A'.repeat(100), // drop >80 chars
          42 as unknown, // drop non-string
          'Alpha',
          'Beta',
          'Gamma',
          'Delta', // cap at 6 total
          'Epsilon',
          'Zeta',
          'Eta',
          'Theta', // Theta truncated
        ],
        themes: [
          'tax planning',
          'Tax Planning', // case-insensitive dedup
          'knee rehab',
          'travel',
          'groceries', // cap at 4 themes
          'unused',
        ],
      }),
    );
    const ex = new TopicExtractor({ llm });
    const out = await ex.extract({ summary: 'x' });
    expect(out.entities).toEqual(['Dr Carl', 'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']);
    expect(out.entities).toHaveLength(6);
    expect(out.themes).toEqual(['tax planning', 'knee rehab', 'travel', 'groceries']);
    expect(out.themes).toHaveLength(4);
  });

  it('returns empty on malformed JSON (does not throw)', async () => {
    const llm = fakeLLM('this is not JSON');
    const ex = new TopicExtractor({ llm });
    const out = await ex.extract({ summary: 'x' });
    expect(out).toEqual({ entities: [], themes: [] });
  });

  it('returns empty when entities/themes are missing or wrong type', async () => {
    // Missing fields.
    const llmMissing = fakeLLM('{}');
    expect(await new TopicExtractor({ llm: llmMissing }).extract({ summary: 'x' })).toEqual({
      entities: [],
      themes: [],
    });
    // Wrong types.
    const llmWrongType = fakeLLM('{"entities": "not an array", "themes": 42}');
    expect(await new TopicExtractor({ llm: llmWrongType }).extract({ summary: 'x' })).toEqual({
      entities: [],
      themes: [],
    });
  });

  it('fails open when the LLM throws (returns empty, never rethrows)', async () => {
    const ex = new TopicExtractor({ llm: failingLLM() });
    const out = await ex.extract({ summary: 'x' });
    expect(out).toEqual({ entities: [], themes: [] });
  });

  it('fails open when the vault factory throws', async () => {
    const llm = fakeLLM('{"entities": ["x"], "themes": []}');
    const ex = new TopicExtractor({
      llm,
      createVault: () => {
        throw new Error('vault init');
      },
    });
    const out = await ex.extract({ summary: 'x' });
    expect(out).toEqual({ entities: [], themes: [] });
    expect(llm).not.toHaveBeenCalled();
  });

  it('extracts JSON embedded in prose (LLM added a stray preamble)', async () => {
    const llm = fakeLLM('Sure, here is the result:\n{"entities": ["Dr Carl"], "themes": []}');
    const ex = new TopicExtractor({ llm });
    const out = await ex.extract({ summary: 'x' });
    expect(out.entities).toEqual(['Dr Carl']);
  });

  // ------------------------------------------------------------------
  // Additional WM-TEST-06 parser cases — pinning extractJSON edge cases
  // through the extractor so future parser refactors can't regress
  // them. Complement the direct `extractJSON` tests in
  // output_parser.test.ts (if present).
  // ------------------------------------------------------------------

  it('code_fence_without_language — strips bare ``` fences', async () => {
    const llm = fakeLLM('```\n{"entities": ["Sancho"], "themes": []}\n```');
    const ex = new TopicExtractor({ llm });
    expect((await ex.extract({ summary: 'x' })).entities).toEqual(['Sancho']);
  });

  it('leading_whitespace — trims before parse', async () => {
    const llm = fakeLLM('   \n\n  {"entities": ["Alpha"], "themes": []}\n');
    const ex = new TopicExtractor({ llm });
    expect((await ex.extract({ summary: 'x' })).entities).toEqual(['Alpha']);
  });

  it('null_returns_empty — JSON parses to null', async () => {
    const llm = fakeLLM('null');
    const ex = new TopicExtractor({ llm });
    expect(await ex.extract({ summary: 'x' })).toEqual({ entities: [], themes: [] });
  });

  it('bare array is not a valid object → empty', async () => {
    // Python equivalent: `non_object_returns_empty`.
    const llm = fakeLLM('["not", "an", "object"]');
    const ex = new TopicExtractor({ llm });
    expect(await ex.extract({ summary: 'x' })).toEqual({ entities: [], themes: [] });
  });
});

// ---------------------------------------------------------------------------
// GAP-PROMPT-01 — system prompt fixture.
//
// The TopicExtractor system prompt is load-bearing for downstream
// sanitisation: it carries the pronoun + generic-type exclusions that
// prevent the LLM from polluting the ToC with "doctor" / "company" /
// "she". A silent rewrite that erodes those rules would shift
// extraction quality without failing any other test. Pin them here so
// drift shows up as a test failure.
// ---------------------------------------------------------------------------

describe('TOPIC_EXTRACTOR_SYSTEM_PROMPT — pinned exclusions (GAP-PROMPT-01)', () => {
  // Re-imported inline so the assertion reads self-contained.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TOPIC_EXTRACTOR_SYSTEM_PROMPT } = require('../../src/enrichment/topic_extractor') as {
    TOPIC_EXTRACTOR_SYSTEM_PROMPT: string;
  };

  it('declares pronouns as non-topics', () => {
    expect(TOPIC_EXTRACTOR_SYSTEM_PROMPT).toMatch(/pronouns/i);
    // Each pronoun enumerated with word-boundary semantics so partial
    // deletions ("drop just `I`") fail this test.
    for (const p of ['he', 'she', 'they', 'it', 'you', 'we', 'I']) {
      expect(TOPIC_EXTRACTOR_SYSTEM_PROMPT).toMatch(new RegExp(`\\b${p}\\b`));
    }
  });

  it('declares generic role/type words as non-entities', () => {
    expect(TOPIC_EXTRACTOR_SYSTEM_PROMPT).toMatch(/generic role\/type/i);
    // Spot-check the enumerated generics so a future edit can't drop
    // them all while keeping the heading.
    for (const g of ['doctor', 'patient', 'driver', 'company', 'person']) {
      expect(TOPIC_EXTRACTOR_SYSTEM_PROMPT).toContain(`"${g}"`);
    }
  });

  it('declares dates and times as non-topics', () => {
    expect(TOPIC_EXTRACTOR_SYSTEM_PROMPT).toMatch(/Dates and times/);
    expect(TOPIC_EXTRACTOR_SYSTEM_PROMPT).toMatch(/not topics/);
  });

  it('keeps the JSON-only output rule + placeholder-token exclusion', () => {
    expect(TOPIC_EXTRACTOR_SYSTEM_PROMPT).toMatch(/ONLY the JSON object/);
    expect(TOPIC_EXTRACTOR_SYSTEM_PROMPT).toMatch(/\[EMAIL_0\]/);
    expect(TOPIC_EXTRACTOR_SYSTEM_PROMPT).toMatch(/\[PHONE_1\]/);
  });

  it('passes the system prompt verbatim to the LLM (no wrapper mutation)', async () => {
    const llm = fakeLLM('{"entities": [], "themes": []}');
    const ex = new TopicExtractor({ llm });
    await ex.extract({ summary: 'anything' });
    const [systemPrompt] = llm.mock.calls[0];
    expect(systemPrompt).toBe(TOPIC_EXTRACTOR_SYSTEM_PROMPT);
  });
});

describe('sanitiseList (shared helper promoted per WM-BRAIN-01 spec)', () => {
  // These are the behaviours the classifier and the topic extractor
  // both rely on. Pinned here so a future refactor can't drift the
  // classifier and extractor apart.
  it('dedups case-insensitively, preserves first-seen casing', () => {
    expect(sanitiseList(['Alpha', 'alpha', 'ALPHA'], 10)).toEqual(['Alpha']);
  });
  it('drops non-strings + empties + >80-char items', () => {
    expect(sanitiseList(['ok', '', '  ', 42, null, 'x'.repeat(81)], 10)).toEqual(['ok']);
  });
  it('caps at max items (after dedup)', () => {
    expect(sanitiseList(['a', 'b', 'c', 'd', 'e'], 3)).toEqual(['a', 'b', 'c']);
  });
  it('returns [] for non-array input', () => {
    expect(sanitiseList('abc', 10)).toEqual([]);
    expect(sanitiseList(undefined, 10)).toEqual([]);
    expect(sanitiseList({}, 10)).toEqual([]);
  });
  it('returns [] when max <= 0', () => {
    expect(sanitiseList(['a', 'b'], 0)).toEqual([]);
    expect(sanitiseList(['a', 'b'], -1)).toEqual([]);
  });
  it('trims whitespace before dedup', () => {
    expect(sanitiseList(['  abc  ', 'abc'], 10)).toEqual(['abc']);
  });

  // ----------------------------------------------------------------
  // Additional WM-TEST-06 sanitise cases — named 1:1 with the Python
  // test file so a future port audit can cross-check.
  // ----------------------------------------------------------------

  it('basic_trim_and_cap — trim + respect max (combined)', () => {
    // Whitespace-surrounded items are trimmed AND the list is then
    // capped at max. `x` appears twice (one padded) — dedup keeps
    // first. With max=2, final list is ['x', 'y'].
    expect(sanitiseList(['  x  ', 'x', 'y', 'z'], 2)).toEqual(['x', 'y']);
  });

  it('respects_limit — zero items out when max=1 < distinct-count', () => {
    expect(sanitiseList(['one', 'two', 'three'], 1)).toEqual(['one']);
  });

  it('non_list_input_returns_empty — mirrors `non_list_input_returns_empty`', () => {
    for (const bad of [null, undefined, 42, 'abc', {}, new Set(['a'])]) {
      expect(sanitiseList(bad, 5)).toEqual([]);
    }
  });
});
