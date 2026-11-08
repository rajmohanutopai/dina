/**
 * Real-model check of the Talk promise prompt (docs/PROMISES_AND_WAITS.md §4).
 * Skipped unless RUN_PROMISE_EVAL=1 and ANTHROPIC_API_KEY is set, so `npm test`
 * never calls a model. Runs the phone's default lite model unless EVAL_MODEL.
 */

import { createAnthropic } from '@ai-sdk/anthropic';

import { DEFAULT_CLAUDE_LITE_MODEL } from '../../src/constants';
import { AISDKAdapter } from '../../src/llm/adapters/aisdk';
import { findPromise, type FoundPromise } from '../../src/promises/find_promise';

import type { PlannerAsk } from '../../src/plan/day_planner';

const KEY = process.env.ANTHROPIC_API_KEY ?? '';
const ENABLED = process.env.RUN_PROMISE_EVAL === '1' && KEY !== '';
const MODEL = process.env.EVAL_MODEL ?? DEFAULT_CLAUDE_LITE_MODEL;
const suite = ENABLED ? describe : describe.skip;

// Sunday 8 November 2026, 10:00 local.
const NOW = new Date(2026, 10, 8, 10, 0).getTime();
const FRIDAY = new Date(2026, 10, 13).getTime();
const MONDAY = new Date(2026, 10, 9).getTime();

interface Case {
  name: string;
  text: string;
  fromOwner: boolean;
  earlier?: { fromOwner: boolean; text: string }[];
  /** null: no promise. */
  expect: null | { direction: FoundPromise['direction']; day?: number | null };
}

const CASES: Case[] = [
  {
    name: 'contact promises with a day',
    text: "I'll send you the deck by Friday.",
    fromOwner: false,
    expect: { direction: 'owed_to_me', day: FRIDAY },
  },
  {
    name: 'owner promises with a day',
    text: 'I will confirm the dinner booking tomorrow.',
    fromOwner: true,
    expect: { direction: 'owed_by_me', day: MONDAY },
  },
  {
    name: 'contact promises, no day',
    text: "Leave it with me, I'll sort out the tickets.",
    fromOwner: false,
    expect: { direction: 'owed_to_me', day: null },
  },
  {
    name: 'short reply that is a promise in context',
    text: 'Sure, Friday.',
    fromOwner: false,
    earlier: [{ fromOwner: true, text: 'Could you send me the signed lease?' }],
    expect: { direction: 'owed_to_me', day: FRIDAY },
  },
  {
    name: 'owner records what the contact agreed',
    text: 'Thanks for agreeing to drop the forms off on Monday.',
    fromOwner: true,
    expect: { direction: 'owed_to_me', day: MONDAY },
  },
  { name: 'a question', text: 'Can you send me the deck?', fromOwner: true, expect: null },
  { name: 'already done', text: 'I sent the deck this morning.', fromOwner: false, expect: null },
  { name: 'vague wish', text: 'We should catch up sometime!', fromOwner: false, expect: null },
  { name: 'thanks', text: 'Thanks, that was really helpful.', fromOwner: false, expect: null },
  {
    name: 'plan being discussed',
    text: 'Maybe we could go to the coast next month, what do you think?',
    fromOwner: true,
    expect: null,
  },
];

suite(`find_promise real model (${MODEL})`, () => {
  // Built the way the phone builds it (apps/mobile/src/ai/provider.ts).
  const llm = new AISDKAdapter({ name: 'claude', model: createAnthropic({ apiKey: KEY })(MODEL) });
  const ask: PlannerAsk = async ({ systemPrompt, user, responseSchema, maxTokens }) => {
    const res = await llm.chat([{ role: 'user', content: user }], {
      systemPrompt,
      responseSchema,
      maxTokens,
    });
    return res.content;
  };

  const sameDay = (a: number | null, b: number | null | undefined): boolean => {
    if (b === undefined) return true;
    if (a === null || b === null) return a === b;
    const x = new Date(a);
    const y = new Date(b);
    return (
      x.getFullYear() === y.getFullYear() &&
      x.getMonth() === y.getMonth() &&
      x.getDate() === y.getDate()
    );
  };

  it.each(CASES)(
    '$name',
    async (c) => {
      const found = await findPromise(ask, {
        text: c.text,
        fromOwner: c.fromOwner,
        contactName: 'Mike',
        now: NOW,
        ...(c.earlier !== undefined ? { earlier: c.earlier } : {}),
      });
      if (c.expect === null) {
        expect(found).toBeNull();
        return;
      }
      expect(found).not.toBeNull();
      expect(found?.direction).toBe(c.expect.direction);
      expect(sameDay(found?.dueAt ?? null, c.expect.day)).toBe(true);
    },
    60_000,
  );
});
