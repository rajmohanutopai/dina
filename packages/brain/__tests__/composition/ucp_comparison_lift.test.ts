/**
 * A UCP search's comparison card (UCP plan §4.2 U1): the coordinator lifts
 * the last successful search's card (from either tool that runs one) onto
 * the answer, as its search id alone; the chat
 * keeps it as a `ucp_comparison` lifecycle, and reading it back validates it.
 */

import { addLifecycleMessage, readLifecycle, resetThreads } from '../../src/chat/thread';
import { translateLoopResult } from '../../src/composition/ask_coordinator';

import type { AgenticLoopResult } from '../../src/reasoning/agentic_loop';

function completed(toolCalls: AgenticLoopResult['toolCalls']): AgenticLoopResult {
  return {
    answer: 'Two shops have it; the trusted one is cheaper.',
    toolCalls,
    finishReason: 'completed',
    usage: { inputTokens: 0, outputTokens: 0 },
    transcript: [],
  };
}

// Anything beside the search id is the model's to put there, and is dropped.
const card = (searchId: string) => ({
  kind: 'ucp_comparison',
  search_id: searchId,
  merchants: [{ origin: 'https://a-shop.example', trust: { recommendation: 'proceed' } }],
});

describe('translateLoopResult — UCP comparison lift', () => {
  it('lifts the last successful search’s card beside the narrative', () => {
    const out = translateLoopResult(
      completed([
        {
          name: 'search_ucp_catalog',
          arguments: { query: 'tea' },
          outcome: { success: true, result: { status: 'ok', card: card('ucp-search-1') } },
        },
        {
          name: 'request_ucp_search_approval',
          arguments: { query: 'green tea' },
          outcome: { success: true, result: { status: 'ok', card: card('ucp-search-2') } },
        },
      ]),
      'green tea',
    );
    expect(out.kind).toBe('answer');
    if (out.kind !== 'answer') return;
    expect(out.answer.ucpComparison).toEqual({ kind: 'ucp_comparison', search_id: 'ucp-search-2' });
    expect(out.answer.text).toBe('Two shops have it; the trusted one is cheaper.');
  });

  it('lifts nothing for a search waiting on the owner, a refusal, or a failed call', () => {
    const out = translateLoopResult(
      completed([
        {
          name: 'search_ucp_catalog',
          arguments: {},
          outcome: { success: true, result: { status: 'awaiting_approval' } },
        },
        {
          name: 'search_ucp_catalog',
          arguments: {},
          outcome: { success: true, result: { status: 'refused', reason: 'no_owner_turn' } },
        },
        { name: 'search_ucp_catalog', arguments: {}, outcome: { success: false, error: 'boom' } },
        {
          name: 'get_ucp_product',
          arguments: {},
          outcome: { success: true, result: { card: card('ucp-search-9') } },
        },
      ]),
      'tea',
    );
    expect(out.kind).toBe('answer');
    if (out.kind !== 'answer') return;
    expect(out.answer.ucpComparison).toBeUndefined();
  });
});

describe('the ucp_comparison lifecycle', () => {
  beforeEach(() => resetThreads());

  it('is kept on a dina message and read back', () => {
    const msg = addLifecycleMessage('main', '', {
      kind: 'ucp_comparison',
      status: 'ready',
      searchId: 'ucp-search-1',
      cardSpec: card('ucp-search-1'),
    });
    expect(readLifecycle(msg)).toMatchObject({ kind: 'ucp_comparison', searchId: 'ucp-search-1' });
  });

  it('a malformed one reads as no lifecycle', () => {
    for (const lifecycle of [
      { kind: 'ucp_comparison', status: 'ready', searchId: '', cardSpec: {} },
      { kind: 'ucp_comparison', status: 'pending', searchId: 's', cardSpec: {} },
      { kind: 'ucp_comparison', status: 'ready', searchId: 's', cardSpec: null },
    ]) {
      expect(
        readLifecycle({
          id: 'x',
          threadId: 'main',
          type: 'dina',
          content: '',
          metadata: { lifecycle },
          timestamp: 1,
        } as never),
      ).toBeNull();
    }
  });
});
