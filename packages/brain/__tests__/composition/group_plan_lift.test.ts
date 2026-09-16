/**
 * translateLoopResult — group plan lift (GROUP_COORDINATION §9).
 *
 * A successful `coordinate_group` call rides beside the narrative as
 * `answer.groupPlan` (the plan id and intent), so the chat bridge can post the
 * organizer's plan card. The prose survives; a failed call lifts nothing.
 */

import { translateLoopResult } from '../../src/composition/ask_coordinator';

import type { AgenticLoopResult } from '../../src/reasoning/agentic_loop';

function completed(toolCalls: AgenticLoopResult['toolCalls']): AgenticLoopResult {
  return {
    answer: 'Asked the Garcias and the Millers privately.',
    toolCalls,
    finishReason: 'completed',
    usage: { inputTokens: 0, outputTokens: 0 },
    transcript: [],
  };
}

const OPENED = {
  status: 'pending',
  plan_id: 'gp_1',
  intent: "Emma's 8th birthday",
  guests: [{ contact_did: 'did:plc:garcia', display_name: 'The Garcias', required: true }],
  candidates: [{ start: 'Sat 26' }],
  window_closes_at: 1,
  note: 'x',
};

describe('translateLoopResult — group plan lift', () => {
  it('lifts the opened plan onto answer.groupPlan and keeps the narrative', () => {
    const out = translateLoopResult(
      completed([{ name: 'coordinate_group', arguments: {}, outcome: { success: true, result: OPENED } }]),
      "plan Emma's birthday with the Garcias",
    );
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') {
      expect(out.answer.groupPlan).toEqual({ planId: 'gp_1', intent: "Emma's 8th birthday" });
      expect(out.answer.text).toBe('Asked the Garcias and the Millers privately.');
    }
  });

  it('lifts nothing when the call failed, opened no plan, or never happened', () => {
    for (const calls of [
      [{ name: 'coordinate_group', arguments: {}, outcome: { success: false as const, error: 'refused' } }],
      [{ name: 'coordinate_group', arguments: {}, outcome: { success: true as const, result: { ...OPENED, plan_id: '' } } }],
      [],
    ]) {
      const out = translateLoopResult(completed(calls), 'x');
      expect(out.kind).toBe('answer');
      if (out.kind === 'answer') expect(out.answer.groupPlan).toBeUndefined();
    }
  });
});
