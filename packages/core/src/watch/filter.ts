/**
 * R2-04 — the watch WAKE FILTER: a bounded, structured condition that decides
 * whether a poll RESULT is worth surfacing (PUSH_SERVICES_ARCHITECTURE.md §19 /
 * Silence First). Without it a standing watch would notify on EVERY poll — the
 * cry-wolf noise the First Law forbids. A watch like "tell me if BA117 is
 * delayed" carries `filter = { contains: 'delayed' }` and fires ONLY when the
 * rendered result text matches; an unfiltered watch (`wake_policy: 'always'`)
 * fires on every resolved poll.
 *
 * V1 keeps the predicate deliberately small + deterministic (a case-insensitive
 * substring over the bounded, already-validated result text) so it is pure,
 * testable, and safe to run on untrusted provider output. Richer structured
 * predicates (field/op/value, significant-change) are a documented next
 * increment layered on this same seam.
 */

/** A bounded wake condition for a poll-mode watch. */
export interface WatchFilter {
  /** Fire only when the rendered result text contains this (case-insensitive)
   *  substring. */
  contains: string;
}

/** Parse an untrusted stored/wire filter value → a `WatchFilter` or undefined.
 *  NOTE: this collapses "absent" and "present-but-malformed" into `undefined`;
 *  callers that must fail closed on a corrupt filter (R5-07) use
 *  `classifyWatchFilter` to tell those two apart first. */
export function parseWatchFilter(v: unknown): WatchFilter | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const c = (v as Record<string, unknown>).contains;
  if (typeof c !== 'string' || c.trim() === '') return undefined;
  return { contains: c };
}

/**
 * R5-07 — distinguish an ABSENT filter (legitimately unfiltered → fire always)
 * from a PRESENT-but-INVALID one (a corrupt/half-formed condition that must fail
 * CLOSED, never silently be reinterpreted as "notify on every poll" — Silence
 * First). `undefined`/`null` = absent; anything else that doesn't yield a valid
 * `{ contains: <non-empty string> }` = invalid.
 */
export function classifyWatchFilter(v: unknown): 'absent' | 'valid' | 'invalid' {
  if (v === undefined || v === null) return 'absent';
  return parseWatchFilter(v) !== undefined ? 'valid' : 'invalid';
}

/**
 * Evaluate a watch's wake condition against the rendered result text (the bounded
 * title + body Core already validated). No filter → always fires. A filter fires
 * only on a case-insensitive substring match — the cry-wolf guard that keeps a
 * conditional watch silent until its condition is actually met.
 */
export function watchFilterMatches(filter: WatchFilter | undefined, resultText: string): boolean {
  if (filter === undefined) return true;
  return resultText.toLowerCase().includes(filter.contains.toLowerCase());
}
