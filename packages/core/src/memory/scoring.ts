/**
 * Working-memory scoring + normalisation helpers (WM-CORE-04).
 *
 * Port of `core/internal/adapter/sqlite/topic_store.go::computeSalience`
 * + `stemLite` + `isConsonant` from main-dina. Kept in a standalone
 * module (not inside the repository) so the service layer, the handler,
 * and the tests can share one authoritative implementation — matches
 * the design doc §5 rationale of "one formula, load-bearing, doc-
 * coupled."
 *
 * Both functions are PURE — no I/O, no `Date.now()` inside them.
 * Callers supply `nowUnix` explicitly so tests can pin deterministic
 * time without monkey-patching.
 */

import { TOPIC_SHORT_MIX, TOPIC_TAU_LONG_DAYS, TOPIC_TAU_SHORT_DAYS, type Topic } from './domain';

const SECONDS_PER_DAY = 86_400;

/**
 * Salience for a topic row at a given moment.
 *
 *   salience = s_long * exp(-dt/tau_long)
 *            + TOPIC_SHORT_MIX * s_short * exp(-dt/tau_short)
 *
 * `dt` is in days. A topic touched right now (dt = 0) yields
 * `s_long + 0.3 * s_short`. A topic untouched for 14 days (one
 * short-tau) keeps its s_long almost intact (exp(-14/180) ≈ 0.925) but
 * sees s_short drop to 1/e (≈ 0.368) of its stored value.
 *
 * Negative-dt guard: if `nowUnix < row.last_update` the clock has
 * gone backwards (device time drift, daylight-savings, test harness).
 * Clamp `dt` to 0 rather than amplify — mirrors the Go impl and keeps
 * salience monotonic-under-time for any given row.
 *
 * Design doc §5.
 */
export function computeSalience(row: Topic, nowUnix: number): number {
  const dtDays = Math.max(0, (nowUnix - row.last_update) / SECONDS_PER_DAY);
  return (
    row.s_long * Math.exp(-dtDays / TOPIC_TAU_LONG_DAYS) +
    TOPIC_SHORT_MIX * row.s_short * Math.exp(-dtDays / TOPIC_TAU_SHORT_DAYS)
  );
}

/**
 * Minimal English stemmer used by the repository's `resolveAlias`
 * tier-2 lookup so "tax plan", "tax plans", and "tax planning" all
 * collapse to the same canonical row.
 *
 * Deliberate shape — matches the Go port byte-for-byte:
 *   1. Trim whitespace and lowercase.
 *   2. Greedy suffix strip in two tiers:
 *        A. `ings` or `ing` — strip, then if the revealed tail has a
 *           doubled consonant (e.g. `plann` after stripping `ing`),
 *           drop one. "planning" → "plann" → "plan".
 *        B. `ers`, `er`, or `s` — plain strip, no doubled-consonant
 *           collapse. "planners" → "plann" (yes, imperfect; the Go
 *           impl accepts this for V1 and our tests pin the behaviour).
 *   3. A suffix strip is only applied when it leaves ≥ 3 characters
 *      (`len(s) > len(suf) + 2`). Prevents chopping "sings" → "s".
 *
 * English-only by design — non-English corpora are a V2 concern per
 * the design doc §13 open question #1.
 *
 * Exported for unit tests; the repository calls it internally.
 */
export function stemLite(raw: string): string {
  const s = raw.trim().toLowerCase();

  // Tier A: -ings / -ing (order matters; try longer suffix first so
  // "plannings" doesn't accidentally hit the shorter "-ing" branch).
  for (const suf of ['ings', 'ing'] as const) {
    if (s.endsWith(suf) && s.length > suf.length + 2) {
      const base = s.slice(0, s.length - suf.length);
      if (
        base.length >= 2 &&
        base.charCodeAt(base.length - 1) === base.charCodeAt(base.length - 2) &&
        isConsonant(base.charCodeAt(base.length - 1))
      ) {
        return base.slice(0, base.length - 1);
      }
      return base;
    }
  }

  // Tier B: -ers / -er / -s (longer first).
  for (const suf of ['ers', 'er', 's'] as const) {
    if (s.endsWith(suf) && s.length > suf.length + 2) {
      return s.slice(0, s.length - suf.length);
    }
  }

  return s;
}

/**
 * ASCII lowercase consonant test. Used only by `stemLite`'s
 * doubled-consonant collapse; any non-ASCII or non-lowercase byte is
 * treated as "not a consonant" → no collapse. That's deliberate: we
 * don't want to collapse arbitrary UTF-8 code points or mix cases.
 *
 * Accepts the CHAR CODE (not the character) to avoid allocating a
 * one-character string per test.
 */
export function isConsonant(codePoint: number): boolean {
  // 'a'..'z' is 97..122.
  if (codePoint < 97 || codePoint > 122) return false;
  switch (codePoint) {
    case 97: // 'a'
    case 101: // 'e'
    case 105: // 'i'
    case 111: // 'o'
    case 117: // 'u'
    case 121: // 'y'
      return false;
    default:
      return true;
  }
}
