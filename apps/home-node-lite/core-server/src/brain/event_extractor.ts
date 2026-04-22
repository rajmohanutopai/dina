/**
 * Task 5.38 — event extractor.
 *
 * Scans captured text for **explicit** temporal events — invoices,
 * appointments, birthdays. When a text mentions a dated commitment
 * ("Payment due March 15, 2026"), the extractor surfaces a
 * structured event that the caller wires into a reminder.
 *
 * **Explicit dates only**. No LLM guessing. No "next Tuesday"
 * resolution. The Python reference calls this out in the header
 * comment — we match the contract: if the text doesn't contain a
 * parseable absolute date, the event is not surfaced (even if the
 * kind-keyword is present).
 *
 * **Three event kinds** (pinned by tests):
 *   - `payment_due` — invoice / payment / bill / due / overdue / …
 *   - `appointment` — appointment / meeting / consultation / visit /
 *     check-up / session / call / interview / vaccination / …
 *   - `birthday` — birthday / bday / born / anniversary
 *
 * **Pure + stateless**. Injectable `nowMsFn` for tests that need to
 * freeze "current year" when parsing ordinal-day forms like
 * "27th March" (no year ⇒ assume current year).
 *
 * **Does NOT persist** — the caller owns the reminder-write step.
 * Matches the ReminderPlanner (5.41) pattern where planning is a
 * pure function + persistence is wired separately.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.38.
 */

export type EventKind = 'payment_due' | 'appointment' | 'birthday';

export interface ExtractedEvent {
  kind: EventKind;
  /** UTC ms of the parsed date. Always at 09:00 UTC. */
  triggerAtMs: number;
  /** Human-readable reminder message. */
  message: string;
  /** Original ISO-8601 of `triggerAtMs` — preserved for audit. */
  triggerAtIso: string;
}

export interface ExtractInput {
  /** Primary text to scan (body, summary). */
  text: string;
  /** Optional short label — used in the message prefix. */
  summary?: string;
  /** Optional "(from <sender>)" suffix for the message. */
  sender?: string;
}

export interface EventExtractorOptions {
  /** Injectable clock. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /** Minimum text length to even attempt extraction. Default 10. */
  minTextLength?: number;
}

export const DEFAULT_MIN_TEXT_LENGTH = 10;

// ── Keyword patterns ───────────────────────────────────────────────────

const PAYMENT_RE =
  /\b(?:invoice|payment|bill|due|overdue|amount|balance|owe|payable)\b/i;
const APPOINTMENT_RE =
  /\b(?:appointment|meeting|consultation|visit|check-?up|session|call|interview|vaccination|vaccine|jab)\b/i;
const BIRTHDAY_RE = /\b(?:birthday|birth\s*day|bday|born|anniversary)\b/i;

// Month index (0-based) for ISO constructors.
const MONTHS: ReadonlyMap<string, number> = new Map([
  ['january', 0], ['jan', 0],
  ['february', 1], ['feb', 1],
  ['march', 2], ['mar', 2],
  ['april', 3], ['apr', 3],
  ['may', 4],
  ['june', 5], ['jun', 5],
  ['july', 6], ['jul', 6],
  ['august', 7], ['aug', 7],
  ['september', 8], ['sep', 8], ['sept', 8],
  ['october', 9], ['oct', 9],
  ['november', 10], ['nov', 10],
  ['december', 11], ['dec', 11],
]);

const MONTH_ALTERNATION = Array.from(MONTHS.keys())
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * Date-presence probe — mirrors the Python reference's `_has_date`.
 * Any one of these shapes is sufficient to mark the text as "has an
 * explicit date".
 */
const DATE_DETECT_PATTERNS: readonly RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/, // 2026-03-15
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/, // 15/03/2026 or 15-03-2026
  // "March 15, 2026" or "March 15 2026"
  new RegExp(`\\b(?:${MONTH_ALTERNATION})\\s+\\d{1,2},?\\s*\\d{4}\\b`, 'i'),
  // "15th March 2026" (ordinal + month [+ year])
  new RegExp(
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_ALTERNATION})\\b`,
    'i',
  ),
  // "March 15th" (month + ordinal day)
  new RegExp(
    `\\b(?:${MONTH_ALTERNATION})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`,
    'i',
  ),
];

// Parse patterns with capture groups — each returns (y, m, d) or null.
const RE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const RE_NUMERIC_SLASH = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/;
const RE_MONTH_DAY_YEAR = new RegExp(
  `\\b(${MONTH_ALTERNATION})\\s+(\\d{1,2}),?\\s*(\\d{4})\\b`,
  'i',
);
const RE_DAY_MONTH = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALTERNATION})\\b`,
  'i',
);
const RE_MONTH_DAY = new RegExp(
  `\\b(${MONTH_ALTERNATION})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,
  'i',
);

export class EventExtractor {
  private readonly nowMsFn: () => number;
  private readonly minTextLength: number;

  constructor(opts: EventExtractorOptions = {}) {
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.minTextLength = opts.minTextLength ?? DEFAULT_MIN_TEXT_LENGTH;
  }

  /**
   * Extract every event from `input.text`. Only returns events whose
   * kind-keyword + parseable date are BOTH present. Never throws.
   */
  extract(input: ExtractInput): ExtractedEvent[] {
    const text = typeof input.text === 'string' ? input.text : '';
    if (text.length < this.minTextLength) return [];

    // Must have at least one parseable absolute date.
    if (!hasDate(text)) return [];

    const triggerAtMs = parseDate(text, this.nowMsFn);
    if (triggerAtMs === null) return [];
    const triggerAtIso = new Date(triggerAtMs).toISOString();
    const out: ExtractedEvent[] = [];

    if (PAYMENT_RE.test(text)) {
      out.push({
        kind: 'payment_due',
        triggerAtMs,
        triggerAtIso,
        message: buildMessage('Payment due', input),
      });
    }
    if (APPOINTMENT_RE.test(text)) {
      out.push({
        kind: 'appointment',
        triggerAtMs,
        triggerAtIso,
        message: buildMessage('Appointment', input),
      });
    }
    if (BIRTHDAY_RE.test(text)) {
      out.push({
        kind: 'birthday',
        triggerAtMs,
        triggerAtIso,
        message: buildMessage('Birthday', input),
      });
    }

    return out;
  }

  /**
   * Cheap probe — does `text` contain both a date AND at least one
   * recognised event kind? Useful for pipeline gating before calling
   * `extract()`.
   */
  hasAnyEvent(text: string): boolean {
    if (typeof text !== 'string' || text.length < this.minTextLength) return false;
    if (!hasDate(text)) return false;
    return (
      PAYMENT_RE.test(text) ||
      APPOINTMENT_RE.test(text) ||
      BIRTHDAY_RE.test(text)
    );
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function hasDate(text: string): boolean {
  return DATE_DETECT_PATTERNS.some((re) => re.test(text));
}

function parseDate(text: string, nowMsFn: () => number): number | null {
  // Try ISO first — unambiguous.
  const iso = RE_ISO.exec(text);
  if (iso) {
    const [, y, m, d] = iso;
    const ts = buildTs(+y!, +m! - 1, +d!);
    if (ts !== null) return ts;
  }

  // "Month DD, YYYY" — unambiguous month-first.
  const mdy = RE_MONTH_DAY_YEAR.exec(text);
  if (mdy) {
    const [, monthName, day, year] = mdy;
    const month = MONTHS.get(monthName!.toLowerCase());
    if (month !== undefined) {
      const ts = buildTs(+year!, month, +day!);
      if (ts !== null) return ts;
    }
  }

  // "DD/MM/YYYY" or "DD-MM-YYYY" — ambiguous with US-format. We try
  // D/M/Y first (European default — matches Python reference which
  // tries %d/%m/%Y first), then M/D/Y if that fails validation.
  const slash = RE_NUMERIC_SLASH.exec(text);
  if (slash) {
    const [, a, b, year] = slash;
    const ts =
      buildTs(+year!, +b! - 1, +a!) ?? buildTs(+year!, +a! - 1, +b!);
    if (ts !== null) return ts;
  }

  const currentYear = new Date(nowMsFn()).getUTCFullYear();

  // "15th March" or "15 March" (ordinal day + month, no year).
  const dm = RE_DAY_MONTH.exec(text);
  if (dm) {
    const [, day, monthName] = dm;
    const month = MONTHS.get(monthName!.toLowerCase());
    if (month !== undefined) {
      const ts = buildTs(currentYear, month, +day!);
      if (ts !== null) return ts;
    }
  }

  // "March 15" or "March 15th" (month + ordinal day, no year).
  const md = RE_MONTH_DAY.exec(text);
  if (md) {
    const [, monthName, day] = md;
    const month = MONTHS.get(monthName!.toLowerCase());
    if (month !== undefined) {
      const ts = buildTs(currentYear, month, +day!);
      if (ts !== null) return ts;
    }
  }

  return null;
}

/**
 * Build a UTC 09:00 timestamp. Returns `null` for invalid
 * year/month/day combinations (e.g. Feb 30) — JS's `Date.UTC` is
 * lenient + silently rolls over, so we cross-check after building.
 */
function buildTs(year: number, month: number, day: number): number | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (year < 1900 || year > 9999) return null;
  if (month < 0 || month > 11) return null;
  if (day < 1 || day > 31) return null;
  const ts = Date.UTC(year, month, day, 9, 0, 0, 0);
  const d = new Date(ts);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month ||
    d.getUTCDate() !== day
  ) {
    // JS rolled over (e.g. month=1 day=30 → March 2).
    return null;
  }
  return ts;
}

function buildMessage(prefix: string, input: ExtractInput): string {
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  const sender = typeof input.sender === 'string' ? input.sender.trim() : '';
  const body = summary !== '' ? summary : input.text.slice(0, 100);
  let msg = `${prefix}: ${body}`;
  if (sender !== '') msg += ` (from ${sender})`;
  return msg;
}
