/**
 * Event-extraction types + validators (LLM-only as of April 2026).
 *
 * Until April 2026 this file was a 591-LOC regex extractor — birthday
 * patterns, ARRIVAL keywords, RELATIVE_TIME_IN, MM/DD parsing, etc. —
 * called from `reminder_planner` as a deterministic gate before the
 * LLM. Real-world phrasings ("pay rent tomorrow at 5 pm", "drop off
 * the car next Tuesday") never matched the narrow keyword set, so the
 * gate dropped events the LLM would have caught. Per
 * `feedback_prompt_engineering.md` (memory): hand-coded "if X do Y"
 * rules are bandages for weak prompts; the planner is now LLM-only.
 *
 * What survives here is the *output schema* for whatever produces an
 * `ExtractedEvent` — currently the LLM via `parseReminderPlan`. The
 * validators (`isExtractedEventKind`, `isValidReminderPayload`) sit
 * at the trust boundary so a hallucinated `kind: "follow_up"` or a
 * malformed `fire_at` can't reach `createReminder`.
 */

/**
 * Canonical kinds the planner emits.
 *
 *   - payment_due: bills, invoices, rent, subscriptions
 *   - appointment: dentist, doctor, calendar slots
 *   - birthday: recurring annual reminders (year is bumped forward
 *               when the LLM returns a past timestamp)
 *   - deadline: project / form due dates
 *   - arrival: ETA-style ("I'm coming in 15 min") — short-horizon
 *   - custom: catch-all so an unknown LLM kind still produces a
 *             user-visible reminder rather than being dropped
 */
export const EXTRACTED_EVENT_KINDS = [
  'payment_due',
  'appointment',
  'birthday',
  'deadline',
  'arrival',
  'custom',
] as const;

/** Strict union of all kinds the planner emits. */
export type ExtractedEventKind = (typeof EXTRACTED_EVENT_KINDS)[number];

const EXTRACTED_EVENT_KIND_SET = new Set<string>(EXTRACTED_EVENT_KINDS);

/**
 * Runtime guard for arbitrary string → {@link ExtractedEventKind}.
 * Use at trust boundaries (LLM output, network, persistence) — the
 * type cast on its own gives you no actual safety. Callers that want
 * to keep an unknown-kind reminder rather than drop it should fold
 * to `'custom'` (see `reminder_planner.ts`).
 */
export function isExtractedEventKind(value: unknown): value is ExtractedEventKind {
  return typeof value === 'string' && EXTRACTED_EVENT_KIND_SET.has(value);
}

export interface ExtractedEvent {
  /** ISO 8601 timestamp the reminder should fire at. */
  fire_at: string;
  /** Human-readable reminder text. */
  message: string;
  /** Canonical kind — see {@link EXTRACTED_EVENT_KINDS}. */
  kind: ExtractedEventKind;
  /** Source vault item id, threaded through so the UI can deep-link. */
  source_item_id: string;
}

/** Check if an extraction result is a valid Core reminder payload. */
export function isValidReminderPayload(event: ExtractedEvent): boolean {
  if (!event.fire_at || event.fire_at.length === 0) return false;
  if (!event.message || event.message.length === 0) return false;
  if (!event.kind) return false;
  if (!event.source_item_id || event.source_item_id.length === 0) return false;

  // fire_at must be valid ISO 8601
  const date = new Date(event.fire_at);
  if (isNaN(date.getTime())) return false;

  return true;
}
