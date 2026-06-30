/**
 * Talk composer routing — the pure control-point logic behind `chat/[did].tsx`.
 *
 * The per-peer chat screen isn't render-tested in this repo, so the routing
 * DECISION (the part with correctness stakes — Contact Services §7's
 * suggest-not-auto-fire control point) lives here as a pure function the suite
 * pins. The screen's `onSubmit` is a thin wrapper that dispatches on the route
 * this returns.
 *
 * Three routes for a submitted draft:
 *   - `schedule` → a `/schedule …` command. Contact-scoped: it asks the LOCAL
 *     Dina to coordinate a time with THIS peer, so it routes through the
 *     orchestrator (`runChatTurn(text, peerDID)`) — NOT sent over D2D as peer
 *     text. This is the only slash command that runs from a Talk thread.
 *   - `slash` → any other `/command`. Addressed to the local Dina, not the
 *     peer; the screen blocks + redirects (so a stray `/ask` doesn't surface as
 *     a confusing peer message).
 *   - `send` → plain text → a normal peer chat message.
 *
 * The chip SEEDS `SCHEDULE_SEED` into the composer; it NEVER submits. The user
 * confirms by pressing send — only then does `routeComposerText` return
 * `schedule` and the dispatch happens. That separation is the whole point of
 * the control point (misreading "let's hang out sometime" as a service call is
 * the failure mode §7 warns about).
 */

/** What the chip seeds into the composer. A trailing space lets the user type
 *  the rest of the intent right after it. */
export const SCHEDULE_SEED = '/schedule ';

export type ComposerRoute = 'schedule' | 'slash' | 'send';

/** True iff `text` is a `/schedule` command (bare or with an argument). The
 *  SINGLE source of this predicate — both the submit router and the chip-show
 *  condition use it, so they can never drift. Case-insensitive; tolerant of
 *  leading whitespace. */
export function isScheduleCommand(text: string): boolean {
  return /^\s*\/schedule(\s|$)/i.test(text);
}

/**
 * Classify a submitted (already non-empty) draft into its route. Pure — no side
 * effects, no dispatch. Empty/whitespace input returns `send` (the caller
 * guards empties before calling, but we stay total).
 */
export function routeComposerText(text: string): ComposerRoute {
  const trimmed = text.trim();
  if (trimmed === '') return 'send';
  if (isScheduleCommand(trimmed)) return 'schedule';
  if (trimmed.startsWith('/')) return 'slash';
  return 'send';
}
