/**
 * `draft_quote_request` (ASK_FOR_QUOTES_PLAN §2) — the chat hand-off. The
 * model's arguments become a bounded draft; amounts become minor units;
 * nothing unusable survives; the tool ends the turn and has no way to send.
 */

import { addLifecycleMessage, readLifecycle, resetThreads } from '../../src/chat/thread';
import { translateLoopResult } from '../../src/composition/ask_coordinator';
import {
  createDraftQuoteRequestTool,
  draftFromToolArgs,
} from '../../src/reasoning/quote_request_tool';

import type { AgenticLoopResult } from '../../src/reasoning/agentic_loop';

describe('draftFromToolArgs', () => {
  it('keeps the items, the search phrase and the limits, in minor units', () => {
    expect(
      draftFromToolArgs({
        items: [
          { description: ' Floral celebration cake, 20 servings ', quantity: 1, unit: 'each' },
          { description: 'Basmati rice', quantity: 2.5, unit: 'kg' },
        ],
        supplier_search: 'cakes',
        target_amount: 2500,
        ceiling_amount: '3,000',
        max_rounds: 2,
        reply_within_seconds: 3600,
      }),
    ).toEqual({
      lines: [
        { text: 'Floral celebration cake, 20 servings', quantity: '1', unit_code: 'each' },
        { text: 'Basmati rice', quantity: '2.5', unit_code: 'kg' },
      ],
      supplier_query: 'cakes',
      limits: {
        target_minor: '250000',
        ceiling_minor: '300000',
        max_rounds: 2,
        deadline_seconds: 3600,
      },
    });
  });

  it('drops what cannot be used rather than guessing', () => {
    expect(
      draftFromToolArgs({
        items: [{ description: '' }, { description: 'Cupcakes', quantity: -3, unit: 'dozen' }],
        target_amount: 'about three thousand',
        max_rounds: 50,
        reply_within_seconds: 5,
      }),
    ).toEqual({ lines: [{ text: 'Cupcakes', quantity: '1', unit_code: 'each' }] });
  });

  it('with no item it refuses and says what it needs', () => {
    expect(() => draftFromToolArgs({ items: [] })).toThrow(/describe at least one item/);
    expect(() => draftFromToolArgs({})).toThrow(/describe at least one item/);
  });

  it('bounds the draft: ten items, 200 characters each', () => {
    const draft = draftFromToolArgs({
      items: Array.from({ length: 12 }, () => ({ description: 'x'.repeat(250) })),
    });
    expect(draft.lines).toHaveLength(10);
    expect(draft.lines[0]?.text).toHaveLength(200);
  });
});

describe('currency and what was remembered (iPhone demo 2026-09-29)', () => {
  const cake = [{ description: 'Floral celebration cake, 20 servings', quantity: 1 }];

  it('keeps a named currency as a three-letter code, and drops anything else', () => {
    expect(draftFromToolArgs({ items: cake, currency: ' usd ' }).currency).toBe('USD');
    for (const currency of ['dollars', '$', 'US', 'USDT', 42]) {
      expect(draftFromToolArgs({ items: cake, currency }).currency).toBeUndefined();
    }
  });

  it('carries what Dina drew from the notes in one bounded line, and never an empty one', () => {
    const draft = draftFromToolArgs({
      items: cake,
      from_memory: '  You love floral\n celebration   cakes ',
    });
    expect(draft.from_memory).toBe('You love floral celebration cakes');
    expect(
      draftFromToolArgs({ items: cake, from_memory: 'x'.repeat(500) }).from_memory,
    ).toHaveLength(140);
    expect('from_memory' in draftFromToolArgs({ items: cake, from_memory: '   ' })).toBe(false);
    expect('from_memory' in draftFromToolArgs({ items: cake })).toBe(false);
  });

  it('tells the model a cake for 20 people is one cake', () => {
    const tool = createDraftQuoteRequestTool();
    const items = (
      tool.parameters as {
        properties: Record<
          string,
          { items?: { properties: Record<string, { description?: string }> } }
        >;
      }
    ).properties.items;
    expect(items?.items?.properties.quantity?.description).toMatch(
      /Not the number of people or servings/,
    );
  });
});

describe('the tool', () => {
  it('ends the turn and returns the draft; it is built with no Core client', async () => {
    const tool = createDraftQuoteRequestTool();
    expect(tool.terminal).toBe(true);
    expect(await tool.execute({ items: [{ description: 'Cake' }] })).toEqual({
      drafted: true,
      draft: { lines: [{ text: 'Cake', quantity: '1', unit_code: 'each' }] },
    });
  });
});

function completed(toolCalls: AgenticLoopResult['toolCalls']): AgenticLoopResult {
  return {
    answer: 'Your request for quotes is ready to review.',
    toolCalls,
    finishReason: 'completed',
    usage: { inputTokens: 0, outputTokens: 0 },
    transcript: [],
  };
}

const DRAFT = {
  lines: [{ text: 'Cake', quantity: '1', unit_code: 'each' }],
  supplier_query: 'cakes',
};

describe('the lift and the card', () => {
  beforeEach(() => resetThreads());

  it('a drafted request rides on the answer beside the one-line ack', () => {
    const out = translateLoopResult(
      completed([
        {
          name: 'draft_quote_request',
          arguments: {},
          outcome: { success: true, result: { drafted: true, draft: DRAFT } },
        },
      ]),
      'ask bakeries for a cake',
    );
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') {
      expect(out.answer.quoteRequestDraft).toEqual(DRAFT);
      expect(out.answer.text).toBe('Your request for quotes is ready to review.');
    }
  });

  it('a failed or empty draft lifts nothing', () => {
    for (const calls of [
      [
        {
          name: 'draft_quote_request',
          arguments: {},
          outcome: { success: false as const, error: 'no item' },
        },
      ],
      [
        {
          name: 'draft_quote_request',
          arguments: {},
          outcome: { success: true as const, result: { drafted: true, draft: { lines: [] } } },
        },
      ],
      [],
    ]) {
      const out = translateLoopResult(completed(calls), 'x');
      if (out.kind === 'answer') expect(out.answer.quoteRequestDraft).toBeUndefined();
    }
  });

  it('the card is keyed by its draft id and read back strictly', () => {
    const msg = addLifecycleMessage('t', '', {
      kind: 'quote_request_draft',
      status: 'ready',
      draftId: 'qd_1',
      draft: DRAFT,
    });
    expect(msg.sources).toEqual(['qd_1']);
    expect(readLifecycle(msg)).toEqual({
      kind: 'quote_request_draft',
      status: 'ready',
      draftId: 'qd_1',
      draft: DRAFT,
    });
    const base = { id: 'm', threadId: 't', type: 'dina' as const, content: '', timestamp: 1 };
    for (const lifecycle of [
      { kind: 'quote_request_draft', status: 'ready', draftId: '', draft: DRAFT },
      { kind: 'quote_request_draft', status: 'sent', draftId: 'q', draft: DRAFT },
      { kind: 'quote_request_draft', status: 'ready', draftId: 'q', draft: { lines: 'x' } },
    ]) {
      expect(readLifecycle({ ...base, metadata: { lifecycle } })).toBeNull();
    }
  });
});
