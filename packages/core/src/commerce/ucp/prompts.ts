/**
 * A webhook's prompt (UCP plan §3.13 step 5, §3.14): "read this resource
 * now", kept durably on its row (`prompted_at`) until a read that began
 * after it succeeds. A read already in flight when the prompt lands cannot
 * clear it, and neither can a read that fails: the reconciliation is retried
 * until it succeeds.
 *
 * A failed prompted read is retried soon, not on the resource's normal
 * schedule (daily on a node that takes webhooks), and the wait grows with
 * the prompt's age, so a merchant that stays down is asked at most hourly.
 * A prompt lives a day: a read that fails after that drops it, and the
 * resource goes back to its own schedule (a session past its watch, none),
 * so no merchant is asked forever.
 */

const MINUTE = 60_000;
export const PROMPT_RETRY_MIN_MS = 2 * MINUTE;
export const PROMPT_RETRY_MAX_MS = 60 * MINUTE;
/** How long a prompt is retried before it is dropped (as long as an unverified delivery). */
export const PROMPT_LIFE_MS = 24 * 60 * MINUTE;

/** When a failed read of a resource prompted at `promptedAt` is tried again. */
export function promptRetryAt(promptedAt: number, now: number): number {
  const wait = Math.min(Math.max((now - promptedAt) / 4, PROMPT_RETRY_MIN_MS), PROMPT_RETRY_MAX_MS);
  return now + Math.round(wait);
}

/** How a read ended, for the prompt it may answer. */
export interface ReadOutcome {
  /** When the read was asked: only a prompt older than this is answered by it. */
  startedAt: number;
  /** Whether the merchant gave an answer Dina could use. */
  ok: boolean;
  /** The merchant asked not to be asked again before this (its Retry-After). */
  notBefore?: number;
}

/**
 * The next-due time once a read has ended, given the row's prompt: due at a
 * prompt the read began before; soon after a failed read of a prompt it
 * began after; otherwise `next` as the read chose. `clear`: the prompt is
 * answered and goes.
 */
export function afterPromptedRead(
  promptedAt: number | null,
  next: number | null,
  read: ReadOutcome,
  now: number,
): { next: number | null; clear: boolean } {
  if (promptedAt === null) return { next, clear: false };
  if (promptedAt > read.startedAt)
    return { next: next === null ? promptedAt : Math.min(next, promptedAt), clear: false };
  if (read.ok) return { next, clear: true };
  // A day of failed reads: the prompt goes, and the read's own choice stands.
  if (now - promptedAt >= PROMPT_LIFE_MS) return { next, clear: true };
  // Soon, but never before the merchant said it would answer.
  const retry = Math.max(promptRetryAt(promptedAt, now), read.notBefore ?? 0);
  return { next: next === null ? retry : Math.min(next, retry), clear: false };
}
