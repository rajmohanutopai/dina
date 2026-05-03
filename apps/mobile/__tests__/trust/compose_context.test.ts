/**
 * Unit tests for `apps/mobile/src/trust/compose_context.ts` —
 * LLM-driven compose-context inferer for the trust write/edit form.
 *
 * Pins the LLM contract (not classification quality — the LLM owns
 * that). Specifically:
 *   - No provider configured → empty result, no chat() call.
 *   - Empty inputs (no items / empty vocab / blank subject) → empty
 *     result, no chat() call.
 *   - Happy path: structured JSON response → values populated, sources
 *     mirror values.
 *   - Closed-vocabulary discipline: tags outside `vocabulary` drop on
 *     the floor (defense in depth — even if the LLM ignored the
 *     schema).
 *   - Bucket discipline: only `LastUsedBucket` enum members survive.
 *   - Cap honoured: at most 3 use_cases.
 *   - Tolerant parsing: ```json ... ``` fences accepted.
 *   - Quiet failure: chat() throw, malformed JSON, empty response —
 *     all map to the EMPTY_RESULT contract.
 */

import { describe, expect, it, jest } from '@jest/globals';

import {
  inferComposeContext,
  type ComposeVaultItem,
} from '../../src/trust/compose_context';
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  LLMProvider,
} from '@dina/brain/src/llm/adapters/provider';

const NOW = Date.parse('2026-05-02T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function item(overrides: Partial<ComposeVaultItem> & { id: string }): ComposeVaultItem {
  return {
    body: '',
    timestamp: NOW - DAY,
    ...overrides,
  };
}

const TECH_VOCAB = ['everyday', 'professional', 'travel', 'gaming', 'creative'];

/**
 * Build a stub `LLMProvider` whose `chat()` returns a queued list of
 * canned responses. Records every call so individual specs can pin
 * the systemPrompt / responseSchema / message shape the inferer sent.
 */
function stubLLM(responses: Array<string | Error>): {
  llm: LLMProvider;
  chatMock: jest.Mock<(messages: ChatMessage[], opts?: ChatOptions) => Promise<ChatResponse>>;
} {
  const queue = [...responses];
  const chatMock = jest.fn<(messages: ChatMessage[], opts?: ChatOptions) => Promise<ChatResponse>>();
  chatMock.mockImplementation(async () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error('stubLLM: response queue exhausted');
    }
    if (next instanceof Error) {
      throw next;
    }
    return {
      content: next,
      toolCalls: [],
      model: 'stub',
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: 'end',
    };
  });
  const llm: LLMProvider = {
    name: 'stub',
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsEmbedding: false,
    chat: chatMock,
    stream: async function* () {
      yield { type: 'done' };
    },
    embed: async () => ({
      embedding: new Float64Array(),
      model: 'stub',
      dimensions: 0,
    }),
  };
  return { llm, chatMock };
}

// ─── Short-circuit guards ─────────────────────────────────────────────
describe('inferComposeContext — short-circuit guards', () => {
  it('returns empty when no provider is configured (no chat call)', async () => {
    const { llm, chatMock } = stubLLM([]);
    void llm; // shadowed: the assertion is on chatMock, not on `llm`.
    const result = await inferComposeContext({
      llm: null,
      subjectName: 'Aeron chair',
      category: 'office_furniture',
      items: [item({ id: 'a', body: 'professional' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    expect(result).toEqual({ values: {}, sources: {} });
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('returns empty when items list is empty', async () => {
    const { llm, chatMock } = stubLLM([]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    expect(result).toEqual({ values: {}, sources: {} });
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('returns empty when vocabulary is empty', async () => {
    const { llm, chatMock } = stubLLM([]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'professional' })],
      vocabulary: [],
      nowMs: NOW,
    });
    expect(result).toEqual({ values: {}, sources: {} });
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('returns empty when subject name is blank', async () => {
    const { llm, chatMock } = stubLLM([]);
    const result = await inferComposeContext({
      llm,
      subjectName: '   ',
      category: null,
      items: [item({ id: 'a', body: 'professional' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    expect(result).toEqual({ values: {}, sources: {} });
    expect(chatMock).not.toHaveBeenCalled();
  });
});

// ─── Happy path ───────────────────────────────────────────────────────
describe('inferComposeContext — happy path', () => {
  it('parses structured JSON response and populates values + sources', async () => {
    const { llm, chatMock } = stubLLM([
      JSON.stringify({
        use_cases: ['professional', 'everyday'],
        last_used_bucket: 'today',
      }),
    ]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: 'office_furniture',
      items: [item({ id: 'a', body: 'I sit in this chair every day for work' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    expect(result.values.use_cases).toEqual(['professional', 'everyday']);
    expect(result.values.last_used_bucket).toBe('today');
    expect(result.sources.use_cases?.vault_item_count).toBe(1);
    expect(result.sources.last_used_bucket?.vault_item_count).toBe(1);
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('sends the closed vocabulary in the user prompt', async () => {
    const { llm, chatMock } = stubLLM([
      JSON.stringify({ use_cases: [], last_used_bucket: undefined }),
    ]);
    await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: 'office_furniture',
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    const call = chatMock.mock.calls[0];
    const messages = call[0];
    const opts = call[1];
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe('user');
    // Each vocab tag is enumerated verbatim in the prompt body.
    for (const v of TECH_VOCAB) {
      expect(messages[0].content).toContain(v);
    }
    // Subject name carried through to the prompt so the LLM scopes
    // its reasoning correctly.
    expect(messages[0].content).toContain('Aeron chair');
    // ChatOptions: structured-output schema present, low temperature
    // (classification not creativity), max 256 tokens.
    expect(opts?.responseSchema).toBeDefined();
    expect(opts?.systemPrompt).toBeDefined();
    expect(opts?.temperature).toBeLessThanOrEqual(0.2);
  });

  it('strips ```json ... ``` markdown fences from the LLM response', async () => {
    const { llm } = stubLLM([
      '```json\n{"use_cases":["professional"],"last_used_bucket":"past_week"}\n```',
    ]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    expect(result.values.use_cases).toEqual(['professional']);
    expect(result.values.last_used_bucket).toBe('past_week');
  });
});

// ─── Closed-vocabulary discipline ─────────────────────────────────────
describe('inferComposeContext — closed-vocabulary discipline', () => {
  it('drops use_case tags outside the provided vocabulary', async () => {
    const { llm } = stubLLM([
      JSON.stringify({
        // 'gardening' is NOT in TECH_VOCAB — must be filtered out.
        use_cases: ['professional', 'gardening', 'gaming'],
      }),
    ]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    expect(result.values.use_cases).toEqual(['professional', 'gaming']);
  });

  it('drops use_case duplicates while preserving order', async () => {
    const { llm } = stubLLM([
      JSON.stringify({
        use_cases: ['professional', 'professional', 'gaming'],
      }),
    ]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    expect(result.values.use_cases).toEqual(['professional', 'gaming']);
  });

  it('caps use_cases to 3 even if the LLM returns more', async () => {
    const { llm } = stubLLM([
      JSON.stringify({
        use_cases: ['everyday', 'professional', 'travel', 'gaming', 'creative'],
      }),
    ]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    expect(result.values.use_cases?.length).toBe(3);
    expect(result.values.use_cases).toEqual(['everyday', 'professional', 'travel']);
  });

  it('omits use_cases entirely when no LLM tag survives the filter', async () => {
    const { llm } = stubLLM([
      JSON.stringify({ use_cases: ['gardening', 'cooking'] }),
    ]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    expect(result.values.use_cases).toBeUndefined();
    expect(result.sources.use_cases).toBeUndefined();
  });

  it('drops last_used_bucket values outside the LastUsedBucket enum', async () => {
    const { llm } = stubLLM([
      JSON.stringify({ last_used_bucket: 'next_week' }),
    ]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    expect(result.values.last_used_bucket).toBeUndefined();
    expect(result.sources.last_used_bucket).toBeUndefined();
  });

  it('accepts every valid LastUsedBucket', async () => {
    const buckets = [
      'today',
      'past_week',
      'past_month',
      'past_6_months',
      'past_year',
      'over_a_year',
    ] as const;
    for (const bucket of buckets) {
      const { llm } = stubLLM([JSON.stringify({ last_used_bucket: bucket })]);
      const result = await inferComposeContext({
        llm,
        subjectName: 'Aeron chair',
        category: null,
        items: [item({ id: 'a', body: 'x' })],
        vocabulary: TECH_VOCAB,
        nowMs: NOW,
      });
      expect(result.values.last_used_bucket).toBe(bucket);
    }
  });
});

// ─── Quiet failure ────────────────────────────────────────────────────
describe('inferComposeContext — quiet failure', () => {
  it('returns empty when chat() throws', async () => {
    const { llm } = stubLLM([new Error('rate limited')]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    expect(result).toEqual({ values: {}, sources: {} });
  });

  it('returns empty when LLM response is not valid JSON', async () => {
    const { llm } = stubLLM(['not even close to JSON']);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    expect(result).toEqual({ values: {}, sources: {} });
  });

  it('returns empty when LLM response is empty string', async () => {
    const { llm } = stubLLM(['']);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    expect(result).toEqual({ values: {}, sources: {} });
  });

  it('returns empty when LLM returns JSON of the wrong shape', async () => {
    // Top-level array, not an object.
    const { llm } = stubLLM(['["professional"]']);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    // JSON.parse returns an array; the inferer treats use_cases as
    // missing → no values.
    expect(result.values.use_cases).toBeUndefined();
    expect(result.values.last_used_bucket).toBeUndefined();
  });
});

// ─── Composition: only fill what survived ─────────────────────────────
describe('inferComposeContext — composition', () => {
  it('populates only use_cases when last_used_bucket omitted', async () => {
    const { llm } = stubLLM([JSON.stringify({ use_cases: ['professional'] })]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    expect(result.values.use_cases).toEqual(['professional']);
    expect(result.values.last_used_bucket).toBeUndefined();
    expect(result.sources.use_cases).toBeDefined();
    expect(result.sources.last_used_bucket).toBeUndefined();
  });

  it('populates only last_used_bucket when use_cases omitted', async () => {
    const { llm } = stubLLM([JSON.stringify({ last_used_bucket: 'past_week' })]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    expect(result.values.use_cases).toBeUndefined();
    expect(result.values.last_used_bucket).toBe('past_week');
    expect(result.sources.use_cases).toBeUndefined();
    expect(result.sources.last_used_bucket).toBeDefined();
  });

  it('vault_item_count in sources reflects total items provided (not 1)', async () => {
    const { llm } = stubLLM([JSON.stringify({ use_cases: ['professional'], last_used_bucket: 'today' })]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [
        item({ id: 'a', body: 'a' }),
        item({ id: 'b', body: 'b' }),
        item({ id: 'c', body: 'c' }),
      ],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
    });
    expect(result.sources.use_cases?.vault_item_count).toBe(3);
    expect(result.sources.last_used_bucket?.vault_item_count).toBe(3);
  });
});

// ─── Draft-freeform mode ───────────────────────────────────────────────
//
// `draftFreeform: true` is the chat-driven `/ask write a review of <X>`
// flow — the LLM gets an expanded schema (sentiment / headline / body)
// and a prompt that asks it to draft, not just classify. The same
// closed-vocab discipline applies: anything malformed drops on the
// floor and the user fills in a blank field rather than seeing a
// truncated / invented one.
describe('inferComposeContext — draft-freeform mode', () => {
  it('populates sentiment / headline / body when LLM returns them', async () => {
    const { llm, chatMock } = stubLLM([
      JSON.stringify({
        use_cases: ['professional'],
        last_used_bucket: 'today',
        sentiment: 'positive',
        headline: 'Comfortable for long work-from-home days.',
        body: 'I sit in this chair every day for at least 8 hours. It is supportive for long sessions.',
      }),
    ]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: 'office_furniture',
      items: [item({ id: 'a', body: 'I sit in this chair daily for work.' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
      draftFreeform: true,
    });
    expect(result.values.sentiment).toBe('positive');
    expect(result.values.headline).toBe('Comfortable for long work-from-home days.');
    expect(result.values.body).toContain('I sit in this chair every day');
    expect(result.sources.sentiment?.vault_item_count).toBe(1);
    expect(result.sources.headline?.vault_item_count).toBe(1);
    expect(result.sources.body?.vault_item_count).toBe(1);
    // Draft mode picks the draft schema + prompt — verifies via the
    // chatOpts the inferer sent. Schema must include the new fields,
    // system prompt must mention drafting (vs classifying).
    const call = chatMock.mock.calls[0]!;
    const opts = call[1] as ChatOptions;
    expect(opts.systemPrompt).toMatch(/drafting/i);
    const schema = opts.responseSchema as { properties: Record<string, unknown> };
    expect(schema.properties.sentiment).toBeDefined();
    expect(schema.properties.headline).toBeDefined();
    expect(schema.properties.body).toBeDefined();
  });

  it('omits sentiment when LLM omits it (vault is mixed)', async () => {
    const { llm } = stubLLM([
      JSON.stringify({
        use_cases: ['everyday'],
        // no sentiment / headline / body — vault content is too thin
      }),
    ]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'I have one.' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
      draftFreeform: true,
    });
    expect(result.values.sentiment).toBeUndefined();
    expect(result.values.headline).toBeUndefined();
    expect(result.values.body).toBeUndefined();
    expect(result.sources.sentiment).toBeUndefined();
    expect(result.values.use_cases).toEqual(['everyday']);
  });

  it('drops sentiment values outside the closed enum', async () => {
    const { llm } = stubLLM([
      JSON.stringify({
        sentiment: 'enthusiastic', // not in {positive, neutral, negative}
        headline: 'Decent.',
      }),
    ]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
      draftFreeform: true,
    });
    expect(result.values.sentiment).toBeUndefined();
    expect(result.values.headline).toBe('Decent.');
  });

  it('drops over-length headlines rather than truncating', async () => {
    const longHeadline = 'A'.repeat(141); // HEADLINE_MAX_LENGTH = 140
    const { llm } = stubLLM([
      JSON.stringify({ headline: longHeadline, body: 'short' }),
    ]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
      draftFreeform: true,
    });
    expect(result.values.headline).toBeUndefined();
    expect(result.values.body).toBe('short');
  });

  it('drops over-length bodies rather than truncating', async () => {
    const longBody = 'B'.repeat(4001); // BODY_MAX_LENGTH = 4000
    const { llm } = stubLLM([
      JSON.stringify({ headline: 'short headline', body: longBody }),
    ]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
      draftFreeform: true,
    });
    expect(result.values.headline).toBe('short headline');
    expect(result.values.body).toBeUndefined();
  });

  it('trims whitespace + collapses 3+ newlines in body', async () => {
    const { llm } = stubLLM([
      JSON.stringify({ body: '  one\n\n\n\ntwo  \n\nthree   ' }),
    ]);
    const result = await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
      draftFreeform: true,
    });
    expect(result.values.body).toBe('one\n\ntwo  \n\nthree');
  });

  it('does NOT request draft schema/prompt when draftFreeform is false', async () => {
    const { llm, chatMock } = stubLLM([
      JSON.stringify({ use_cases: ['professional'], last_used_bucket: 'today' }),
    ]);
    await inferComposeContext({
      llm,
      subjectName: 'Aeron chair',
      category: null,
      items: [item({ id: 'a', body: 'x' })],
      vocabulary: TECH_VOCAB,
      nowMs: NOW,
      draftFreeform: false,
    });
    const call = chatMock.mock.calls[0]!;
    const opts = call[1] as ChatOptions;
    const schema = opts.responseSchema as { properties: Record<string, unknown> };
    expect(schema.properties.sentiment).toBeUndefined();
    expect(schema.properties.headline).toBeUndefined();
    expect(schema.properties.body).toBeUndefined();
    expect(opts.systemPrompt).not.toMatch(/drafting/i);
  });
});
