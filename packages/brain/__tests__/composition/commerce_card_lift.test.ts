/**
 * translateLoopResult — commerce comparison lift (§5.A4/A5).
 *
 * The product-research loop's `search_products` tool returns a money-free
 * `ComparisonCard`. These pin that the coordinator lifts it onto
 * `answer.commerceCard` as a validated `CardSpec` (so the chat bridge can post a
 * structured where-to-buy card), keeps the narrative, takes the LAST card when a
 * turn researched twice, and lifts nothing when no research produced a card.
 */

import { translateLoopResult } from '../../src/composition/ask_coordinator';

import type { AgenticLoopResult } from '../../src/reasoning/agentic_loop';

function completed(toolCalls: AgenticLoopResult['toolCalls']): AgenticLoopResult {
  return {
    answer: 'Here are the best options I found.',
    toolCalls,
    finishReason: 'completed',
    usage: { inputTokens: 0, outputTokens: 0 },
    transcript: [],
  };
}

const CARD = {
  kind: 'commerce_comparison',
  fields: [
    { label: 'Requested', value: 'oak chair — 1 each' },
    { label: 'Recommended', value: 'did:plc:seller' },
  ],
  primaryAction: 'where_to_buy',
  alternatives: [],
  incomparable: [],
  handoff: [{ supplierDid: 'did:plc:seller', serviceUri: 'at://did:plc:seller/svc' }],
};

describe('translateLoopResult — commerce comparison lift', () => {
  it('lifts a search_products card onto answer.commerceCard as a validated CardSpec', () => {
    const out = translateLoopResult(
      completed([
        {
          name: 'search_products',
          arguments: { query: 'oak chair' },
          outcome: { success: true, result: { card: CARD } },
        },
      ]),
      'best oak chair',
    );
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') {
      const card = out.answer.commerceCard as { version: number; blocks: unknown[] };
      expect(card.version).toBe(1);
      expect(Array.isArray(card.blocks)).toBe(true);
      // The narrative survives — the card is evidence beside it, not instead of it.
      expect(out.answer.text).toBe('Here are the best options I found.');
    }
  });

  it('lifts nothing when the search_products call failed', () => {
    const out = translateLoopResult(
      completed([
        { name: 'search_products', arguments: {}, outcome: { success: false, error: 'appview down' } },
      ]),
      'x',
    );
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') expect(out.answer.commerceCard).toBeUndefined();
  });

  it('lifts nothing on a turn that never researched', () => {
    const out = translateLoopResult(completed([]), 'hello');
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') expect(out.answer.commerceCard).toBeUndefined();
  });

  it('a recommend_offer card that followed the research wins — the card and the prose must agree (§5.A6)', () => {
    const decided = {
      ...CARD,
      fields: [
        { label: 'Recommended', value: 'Steady Seats (did:plc:steady)' },
        { label: 'Chosen for', value: 'your rule: a proven seller over the cheapest' },
      ],
    };
    const out = translateLoopResult(
      completed([
        { name: 'search_products', arguments: {}, outcome: { success: true, result: { card: CARD, researchId: 'r1' } } },
        {
          name: 'recommend_offer',
          arguments: { research_id: 'r1', supplier_did: 'did:plc:steady', reason: 'x' },
          outcome: { success: true, result: { card: decided, recommended: 'did:plc:steady', note: '' } },
        },
      ]),
      'x',
    );
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') {
      const card = out.answer.commerceCard as { blocks: { kind: string; label?: string; value?: string }[] };
      expect(card.blocks.some((b) => b.kind === 'keyValue' && b.value === 'Steady Seats (did:plc:steady)')).toBe(true);
      expect(card.blocks.some((b) => b.kind === 'keyValue' && b.label === 'Chosen for')).toBe(true);
      expect(card.blocks.some((b) => b.value === 'did:plc:seller')).toBe(false);
    }
  });

  it('a REFUSED recommend_offer leaves the research card standing', () => {
    const out = translateLoopResult(
      completed([
        { name: 'search_products', arguments: {}, outcome: { success: true, result: { card: CARD, researchId: 'r1' } } },
        { name: 'recommend_offer', arguments: {}, outcome: { success: false, error: 'not among the ranked offers' } },
      ]),
      'x',
    );
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') {
      const card = out.answer.commerceCard as { blocks: { kind: string; value?: string }[] };
      expect(card.blocks.some((b) => b.kind === 'keyValue' && b.value === 'did:plc:seller')).toBe(true);
    }
  });

  it('takes the last search_products card when a turn researched twice', () => {
    const second = {
      ...CARD,
      fields: [{ label: 'Recommended', value: 'did:plc:secondwin' }],
    };
    const out = translateLoopResult(
      completed([
        { name: 'search_products', arguments: {}, outcome: { success: true, result: { card: CARD } } },
        { name: 'search_products', arguments: {}, outcome: { success: true, result: { card: second } } },
      ]),
      'x',
    );
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') {
      const card = out.answer.commerceCard as { blocks: { kind: string; value?: string }[] };
      expect(
        card.blocks.some((b) => b.kind === 'keyValue' && b.value === 'did:plc:secondwin'),
      ).toBe(true);
    }
  });
});
