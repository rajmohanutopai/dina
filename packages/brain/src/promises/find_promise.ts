/**
 * Find a promise in one Talk message (docs/PROMISES_AND_WAITS.md §4). One
 * short model call through the caller's `ask` (on the phone the shared
 * `LLMRouter`, so PII is scrubbed on the way out). The answer is checked
 * before anyone sees it; with no model, a failed call or a muddled answer,
 * there is no promise: missing one is better than inventing one.
 */

import type { PlannerAsk } from '../plan/day_planner';

export interface TalkMessageInput {
  text: string;
  /** True when the owner wrote it; false when the contact did. */
  fromOwner: boolean;
  contactName: string;
  now: number;
  /** The messages just before it, oldest first, for context only. */
  earlier?: { fromOwner: boolean; text: string }[];
}

export interface FoundPromise {
  /** `owed_to_me`: the contact promised the owner. `owed_by_me`: the owner promised. */
  direction: 'owed_to_me' | 'owed_by_me';
  /** What will be done, one short line, as a task title. */
  what: string;
  dueAt: number | null;
}

const MAX_TEXT = 2000;
const MAX_EARLIER = 4;
const MAX_EARLIER_TEXT = 400;
const MAX_WHAT = 120;
const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 366 * DAY_MS;

export const FIND_PROMISE_PROMPT = `You read the latest message in a private conversation between two people and say whether that message holds a promise: one of them saying they will do something for the other. Plans being discussed, questions, wishes, things already done and polite phrases that commit to nothing are not promises.

Earlier messages, when given, are only there to make the latest one clear (a "Sure, Friday" answering a request). Judge only the latest message.

Answer in JSON:
- "promise": true or false.
- "by": "writer" if the person who wrote the message made the promise, "reader" if the writer is recording a promise the reader made to them.
- "what": what will be done, as a short task title in the imperative, from the point of view of whoever will do it (e.g. "Send the slides"). At most 12 words.
- "due": when it was promised for, as local "YYYY-MM-DDTHH:MM", or null when no time was given. When only a day is given, use 18:00 on that day. Work out relative days ("Friday", "tomorrow") from the current date given below.`;

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    promise: { type: 'boolean' },
    by: { type: 'string', enum: ['writer', 'reader'] },
    what: { type: 'string' },
    due: { type: ['string', 'null'] },
  },
  required: ['promise'],
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Local `YYYY-MM-DDTHH:MM` → ms, or null. */
export function parseLocalDue(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(raw.trim());
  if (m === null) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4] ?? '18', m[5] ?? '00'].map(Number);
  const date = new Date(y, mo - 1, d, h, mi);
  // Reject dates JavaScript rolled over (Feb 30 → Mar 2).
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  if (h > 23 || mi > 59) return null;
  return date.getTime();
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Check the model's answer. Exported for tests. */
export function readFoundPromise(
  raw: string,
  input: Pick<TalkMessageInput, 'fromOwner' | 'now'>,
): FoundPromise | null {
  const v = extractJson(raw);
  if (v === null || v.promise !== true) return null;
  if (v.by !== 'writer' && v.by !== 'reader') return null;
  const what = typeof v.what === 'string' ? v.what.replace(/\s+/g, ' ').trim() : '';
  if (what === '' || what.length > MAX_WHAT) return null;
  const ownerPromised = v.by === 'writer' ? input.fromOwner : !input.fromOwner;
  let dueAt = parseLocalDue(v.due);
  // A date already gone (before today) or more than a year off is a misreading.
  if (dueAt !== null) {
    const start = new Date(input.now);
    const today = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
    if (dueAt < today || dueAt > input.now + YEAR_MS) dueAt = null;
  }
  return { direction: ownerPromised ? 'owed_by_me' : 'owed_to_me', what, dueAt };
}

export async function findPromise(
  ask: PlannerAsk | null,
  input: TalkMessageInput,
): Promise<FoundPromise | null> {
  if (ask === null) return null;
  const text = input.text.trim().slice(0, MAX_TEXT);
  if (text === '') return null;
  const writer = input.fromOwner ? 'the owner' : input.contactName || 'their contact';
  const reader = input.fromOwner ? input.contactName || 'their contact' : 'the owner';
  const earlier = (input.earlier ?? [])
    .slice(-MAX_EARLIER)
    .map(
      (m) =>
        `${m.fromOwner ? 'The owner' : input.contactName || 'Their contact'}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, MAX_EARLIER_TEXT)}`,
    )
    .filter((line) => !line.endsWith(': '));
  const context = earlier.length > 0 ? `Earlier messages:\n${earlier.join('\n')}\n\n` : '';
  const user = `Current date and time: ${localStamp(input.now)}\nWriter: ${writer}\nReader: ${reader}\n\n${context}Latest message:\n${text}`;
  try {
    const raw = await ask({
      systemPrompt: FIND_PROMISE_PROMPT,
      user,
      responseSchema: SCHEMA,
      maxTokens: 300,
    });
    return readFoundPromise(raw, input);
  } catch {
    return null;
  }
}
