/**
 * `invoke_plugin` is terminal (PLUGIN_ARCHITECTURE §6/§15.5): the loop ends
 * on the tool's success with whatever prose the model wrote BEFORE the call,
 * which in the usual function-call shape is nothing. The owner must still
 * learn that a card is waiting or a grant ran the ask — so the tool's note
 * becomes the answer when the model said nothing, follows the model's line
 * when it did, and never appears when no plugin was asked or every ask was
 * refused (a refusal is a thrown tool error, not a success).
 */

import { translateLoopResult } from '../../src/composition/ask_coordinator';

import type { AgenticLoopResult } from '../../src/reasoning/agentic_loop';

function completed(answer: string, toolCalls: AgenticLoopResult['toolCalls']): AgenticLoopResult {
  return { answer, toolCalls, finishReason: 'completed', usage: { inputTokens: 0, outputTokens: 0 }, transcript: [] };
}

const NOTE = 'The exact request is waiting for your approval in Activity → Needs action (high risk). Nothing runs until you approve it.';
const INVOKED: AgenticLoopResult['toolCalls'][number] = {
  name: 'invoke_plugin',
  arguments: { install_id: 'pli', capability_id: 'com.dinakernel.country.in.upi-payment-status', params: {}, param_categories: ['payment'] },
  outcome: { success: true, result: { status: 'approval_required', task_id: 'plgx_1', note: NOTE } },
};

describe('translateLoopResult — the invoke_plugin note reaches the owner', () => {
  it('with no model prose the note IS the answer', () => {
    const out = translateLoopResult(completed('', [INVOKED]), 'did the UPI payment settle?');
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') expect(out.answer.text).toBe(NOTE);
  });

  it('with model prose the note follows it', () => {
    const out = translateLoopResult(completed('Checking with the India pack.', [INVOKED]), 'q');
    if (out.kind !== 'answer') throw new Error('unreachable');
    expect(out.answer.text).toBe(`Checking with the India pack.\n\n${NOTE}`);
  });

  it('a refused ask (a thrown tool error) adds nothing; an unrelated tool adds nothing', () => {
    const refused: AgenticLoopResult['toolCalls'][number] = {
      name: 'invoke_plugin',
      arguments: {},
      outcome: { success: false, error: 'invoke_plugin refused (params_invalid): …' },
    };
    const other: AgenticLoopResult['toolCalls'][number] = {
      name: 'vault_search',
      arguments: {},
      outcome: { success: true, result: { note: 'not a plugin note' } },
    };
    const out = translateLoopResult(completed('I could not ask the plugin.', [refused, other]), 'q');
    if (out.kind !== 'answer') throw new Error('unreachable');
    expect(out.answer.text).toBe('I could not ask the plugin.');
  });

  it('the last successful ask wins when the model asked twice', () => {
    const second = { ...INVOKED, outcome: { success: true as const, result: { status: 'dispatched', task_id: 'plgx_2', note: 'Asked under a standing approval.' } } };
    const out = translateLoopResult(completed('', [INVOKED, second]), 'q');
    if (out.kind !== 'answer') throw new Error('unreachable');
    expect(out.answer.text).toBe('Asked under a standing approval.');
  });
});
