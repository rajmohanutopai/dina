/**
 * translateLoopResult — forced-lane budget bail (release fix).
 *
 * Repro: a forced Services turn ("/services Book me a seat in the sports
 * center") where the agentic loop kept searching instead of deciding and hit
 * `max_iterations`. Before the fix that fell through to the generic
 * "I wasn't able to complete this in the available steps. Try a simpler query."
 * — with no Services framing and no card. These pin the fix:
 *   - Services/Reviews bail → a lane-framed "couldn't finish" answer;
 *   - it is NOT a missing_capability card (discovery may have succeeded);
 *   - plain Ask is unchanged (still a generic failure).
 */

import { translateLoopResult } from '../../src/composition/ask_coordinator';
import {
  REVIEWS_INCOMPLETE_ANSWER,
  SERVICES_INCOMPLETE_ANSWER,
} from '../../src/reasoning/forced_lane';

import type { AgenticLoopResult } from '../../src/reasoning/agentic_loop';
import type { IntentSource } from '../../src/reasoning/intent_classifier';

const SERVICES: readonly IntentSource[] = ['provider_services'];
const REVIEWS: readonly IntentSource[] = ['peerlens'];

function bail(finishReason: 'max_iterations' | 'max_tool_calls'): AgenticLoopResult {
  return {
    answer: '',
    toolCalls: [],
    finishReason,
    usage: { inputTokens: 0, outputTokens: 0 },
    transcript: [],
  };
}

describe('translateLoopResult — forced-lane budget bail', () => {
  it('Services lane + max_iterations → clean Services answer (not a generic failure)', () => {
    const out = translateLoopResult(bail('max_iterations'), 'Book me a seat in the sports center', SERVICES);
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') expect(out.answer.text).toBe(SERVICES_INCOMPLETE_ANSWER);
  });

  it('Services lane + max_tool_calls → clean Services answer', () => {
    const out = translateLoopResult(bail('max_tool_calls'), 'Book me a seat', SERVICES);
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') expect(out.answer.text).toBe(SERVICES_INCOMPLETE_ANSWER);
  });

  it('Reviews lane + max_iterations → clean Reviews answer', () => {
    const out = translateLoopResult(bail('max_iterations'), 'best ergonomic chair', REVIEWS);
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') expect(out.answer.text).toBe(REVIEWS_INCOMPLETE_ANSWER);
  });

  it('does NOT mint a missing_capability card on a Services bail', () => {
    const out = translateLoopResult(bail('max_iterations'), 'Book me a seat', SERVICES);
    expect(out.kind).toBe('answer');
    if (out.kind === 'answer') {
      expect(out.answer.missingCapabilities).toBeUndefined();
      expect(out.answer.serviceQueries).toBeUndefined();
    }
  });

  it('plain Ask (no forced lane) + max_iterations → generic failure (unchanged)', () => {
    const out = translateLoopResult(bail('max_iterations'), 'whatever', undefined);
    expect(out.kind).toBe('failure');
  });
});
