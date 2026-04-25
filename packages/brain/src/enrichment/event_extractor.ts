/**
 * Temporal event extraction — detects dates/deadlines in vault items
 * and creates reminder payloads.
 *
 * Detects: invoice due dates, appointments, birthdays, deadlines,
 * consultations, vaccinations, bills, anniversaries.
 *
 * Creates reminder payloads compatible with Core's /v1/reminder endpoint.
 *
 * Dual-gate logic (matching Python event_extractor.py):
 *   Requires BOTH a temporal keyword AND a parseable date.
 *   A date without a keyword (e.g., "Something on March 15") is ignored.
 *   This prevents false-positive reminders from arbitrary date mentions.
 *
 * Date formats supported:
 *   - "March 15, 2026" or "Mar 15 2026" (month-name first)
 *   - "2026-03-15" (ISO 8601)
 *   - "15/03/2026" (DD/MM/YYYY)
 *   - "27th March" or "March 27th" (ordinal dates)
 *
 * Source: brain/tests/test_event_extractor.py
 */

/**
 * The set of `kind` values the extractor + planner know how to handle.
 *
 * Promoted to a `const` tuple so we have a single source of truth for
 * both the type-level union ({@link ExtractedEventKind}) and the
 * runtime guard ({@link isExtractedEventKind}). Any code path that
 * receives a `kind` from outside (LLM output, persisted reminder row)
 * MUST validate against this guard before propagating — without it,
 * an unknown kind silently flows through `prioritizeKind` /
 * `consolidateReminders` / UI renderers and produces undefined
 * behavior.
 */
export const EXTRACTED_EVENT_KINDS = [
  'payment_due',
  'appointment',
  'birthday',
  'deadline',
  'arrival',
  'custom',
] as const;

/** Strict union of all kinds the extractor + planner emit. */
export type ExtractedEventKind = (typeof EXTRACTED_EVENT_KINDS)[number];

const EXTRACTED_EVENT_KIND_SET = new Set<string>(EXTRACTED_EVENT_KINDS);

/**
 * Runtime guard for arbitrary string → {@link ExtractedEventKind}.
 * Use at trust boundaries (LLM output, network, persistence) — the
 * type cast on its own gives you no actual safety.
 */
export function isExtractedEventKind(value: unknown): value is ExtractedEventKind {
  return typeof value === 'string' && EXTRACTED_EVENT_KIND_SET.has(value);
}

export interface ExtractedEvent {
  fire_at: string; // ISO 8601 timestamp for reminder
  message: string; // Human-readable reminder text
  kind: ExtractedEventKind;
  source_item_id: string;
}

/** Lead time before arrival when the reminder fires (e.g. arrive 19:30 → notify 19:25). */
export const ARRIVAL_LEAD_MS = 5 * 60 * 1000;
/** Floor — never schedule a reminder less than 60s out, even for imminent arrivals. */
const ARRIVAL_MIN_FUTURE_MS = 60 * 1000;
/** Sanity ceiling on relative time so "in 9999 minutes" doesn't poison reminders. */
const RELATIVE_TIME_MAX_MINUTES = 24 * 60;

export interface ExtractionInput {
  item_id: string;
  type: string;
  summary: string;
  body: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------
// Month name → number mapping
// ---------------------------------------------------------------

const MONTH_MAP: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

// ---------------------------------------------------------------
// Event keyword patterns (the "gate" in dual-gate logic)
//
// Python requires BOTH keyword AND date for event extraction.
// These are all the temporal event keywords from Python's extractor.
// ---------------------------------------------------------------

/** Matches "birthday", "bday", "born", "anniversary" */
const BIRTHDAY_PATTERN = /\b(?:birthday|bday|birth\s*day|born|anniversary)\b/i;

/** Matches "appointment", "meeting", "consultation", "visit", "check-up",
 *  "session", "call", "interview" */
const APPOINTMENT_PATTERN =
  /\b(?:appointment|meeting|consultation|visit|check-?up|session|call|interview)\b/i;

/** Matches "invoice", "payment", "bill", "overdue", "amount", "balance",
 *  "owe", "payable" */
const INVOICE_PATTERN = /\b(?:invoice|payment|bill|overdue|amount|balance|owe|payable)\b/i;

/** Matches "deadline" keyword near a date */
const DEADLINE_PATTERN = /\b(?:deadline)\b/i;

/** Matches "vaccination", "vaccine", "jab" */
const VACCINATION_PATTERN = /\b(?:vaccination|vaccine|jab)\b/i;

/** Matches "due" followed by a date expression */
const DUE_DATE_PATTERN = /\bdue\s+(?:by\s+|date\s*:\s*)?(\w+\s+\d{1,2}(?:\s*,?\s*\d{4})?)\b/i;

/** Matches "at 2pm" or "at 2:00 PM" or "at 14:00" */
const TIME_PATTERN = /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i;

/**
 * Matches arrival language: "coming", "arriving", "on my way", "be there",
 * "reaching", "I'll be there", "on the way".
 *
 * Used by the relative-time arrival path — paired with RELATIVE_TIME_PATTERN
 * to detect "I am coming in 15 min" without a calendar date.
 */
const ARRIVAL_PATTERN =
  /\b(?:coming|arriving|arrive|on\s+(?:my|the)\s+way|be\s+there|reach(?:ing)?|i'?ll\s+be\s+there|i\s+am\s+coming|i'?m\s+coming)\b/i;

/**
 * Matches relative-time expressions for arrival:
 *   "in 15 minutes", "in 1 hour", "10 min away", "30 mins away".
 *
 * Captures: [1] number, [2] unit. Hours convert to minutes downstream.
 */
const RELATIVE_TIME_IN_PATTERN =
  /\bin\s+(\d{1,4})\s*(min|mins|minute|minutes|hr|hrs|hour|hours)\b/i;
const RELATIVE_TIME_AWAY_PATTERN =
  /\b(\d{1,4})\s*(min|mins|minute|minutes|hr|hrs|hour|hours)\s+away\b/i;

/**
 * Combined keyword gate — must match at least one for extraction to proceed.
 * This is the first gate in the dual-gate logic.
 */
function hasEventKeyword(text: string): boolean {
  return (
    BIRTHDAY_PATTERN.test(text) ||
    APPOINTMENT_PATTERN.test(text) ||
    INVOICE_PATTERN.test(text) ||
    DEADLINE_PATTERN.test(text) ||
    VACCINATION_PATTERN.test(text) ||
    DUE_DATE_PATTERN.test(text)
  );
}

// ---------------------------------------------------------------
// Date patterns
// ---------------------------------------------------------------

const MONTH_NAMES =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec';

/** Matches "March 15, 2026" or "March 15" or "Mar 15 2026" */
const MONTH_DAY_PATTERN = new RegExp(
  `\\b(${MONTH_NAMES})\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?\\b`,
  'gi',
);

/** Matches "2026-03-15" (ISO 8601 date) */
const ISO_DATE_PATTERN = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

/** Matches "15/03/2026" (DD/MM/YYYY) */
const DD_MM_YYYY_PATTERN = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;

/** Matches ordinal day + month: "27th March", "1st April", "3rd Dec 2026" */
const ORDINAL_MONTH_PATTERN = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)\\s+(${MONTH_NAMES})(?:\\s+(\\d{4}))?\\b`,
  'gi',
);

/** Matches month + ordinal day: "March 27th", "April 1st 2026" */
const MONTH_ORDINAL_PATTERN = new RegExp(
  `\\b(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)(?:\\s*,?\\s*(\\d{4}))?\\b`,
  'gi',
);

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Extract temporal events from a vault item.
 *
 * Dual-gate logic: requires BOTH an event keyword AND a parseable date.
 * Returns empty array if either gate fails.
 *
 * Special path: arrival events ("I am coming in 15 minutes") use relative
 * time instead of a calendar date — they bypass the date-keyword gate and
 * are extracted via {@link extractArrivalEvent} before the date logic runs.
 */
export function extractEvents(input: ExtractionInput): ExtractedEvent[] {
  const text = `${input.summary} ${input.body}`;

  // Path A: arrival events (relative-time, no calendar date required)
  const arrival = extractArrivalEvent(input, text);
  if (arrival) return [arrival];

  // Gate 1: Must have at least one event keyword
  if (!hasEventKeyword(text)) return [];

  // Extract time from text (e.g., "at 2pm") — used in date formatting
  const extractedTime = extractTime(text);

  // Normalize timestamp to seconds (callers may pass ms or s)
  // Fix: Codex #5 — extractDates multiplies by 1000, so input must be seconds
  const tsSeconds = input.timestamp > 1e12 ? Math.floor(input.timestamp / 1000) : input.timestamp;

  // Gate 2: Must have at least one parseable date
  const dates = extractDates(text, tsSeconds, extractedTime);
  if (dates.length === 0) return [];

  // Both gates passed — classify and build events
  const events: ExtractedEvent[] = [];

  for (const { dateStr, isoDate } of dates) {
    const kind = classifyEventKind(text);
    const message = buildMessage(kind, input.summary, dateStr);

    events.push({
      fire_at: isoDate,
      message,
      kind,
      source_item_id: input.item_id,
    });
  }

  return events;
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

/**
 * Extract a birthday date from text.
 * Looks for "birthday is March 15" or "birthday on March 15".
 *
 * @returns ISO date string (YYYY-MM-DD) or null if no parseable date found
 */
export function extractBirthdayDate(text: string): string | null {
  if (!BIRTHDAY_PATTERN.test(text)) return null;

  const dates = extractDates(text, Date.now() / 1000);
  if (dates.length === 0) return null;

  // Return just the date portion (YYYY-MM-DD)
  return dates[0].isoDate.split('T')[0];
}

/**
 * Parse a relative-time expression ("in 15 min", "20 mins away") to minutes.
 *
 * @returns total minutes (hours expanded), or null when no match.
 */
export function parseRelativeMinutes(text: string): number | null {
  const match =
    RELATIVE_TIME_IN_PATTERN.exec(text) ?? RELATIVE_TIME_AWAY_PATTERN.exec(text);
  if (!match) return null;

  const n = parseInt(match[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  const unit = match[2].toLowerCase();
  const minutes = unit.startsWith('h') ? n * 60 : n;
  if (minutes > RELATIVE_TIME_MAX_MINUTES) return null;
  return minutes;
}

/**
 * Extract an arrival event from text + arrive-language + relative time.
 *
 * Examples that trigger:
 *   "I am coming in 15 minutes"
 *   "On my way — be there in 30 mins"
 *   "Arriving in 1 hour"
 *   "10 mins away"
 *
 * Reminder semantics:
 *   - arrival_at = now + relative_minutes
 *   - fire_at    = max(now + 1min, arrival_at - 5min)
 *
 * Why `now` and not `input.timestamp`: the message body says "in 15
 * minutes" relative to the moment it was sent. The pipeline runs within
 * seconds of receive, so wall-clock now is the right reference. Using
 * the staging timestamp would slip the reminder by however long the
 * drain queue was backed up.
 */
function extractArrivalEvent(
  input: ExtractionInput,
  text: string,
): ExtractedEvent | null {
  if (!ARRIVAL_PATTERN.test(text)) return null;
  const minutes = parseRelativeMinutes(text);
  if (minutes === null) return null;

  const now = Date.now();
  const arrivalMs = now + minutes * 60 * 1000;
  const targetMs = arrivalMs - ARRIVAL_LEAD_MS;
  // Floor to "now + 1 min" so very-imminent arrivals still produce a
  // reminder instead of being dropped by the past-date filter in the
  // planner. The user is more useful with a slightly-late notification
  // than with no notification at all.
  const dueMs = Math.max(targetMs, now + ARRIVAL_MIN_FUTURE_MS);

  return {
    fire_at: new Date(dueMs).toISOString(),
    message: input.summary?.trim() || `Arrival in about ${minutes} min`,
    kind: 'arrival',
    source_item_id: input.item_id,
  };
}

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

interface ParsedDate {
  dateStr: string;
  isoDate: string;
}

/**
 * Extract all recognizable dates from text.
 * Returns ISO 8601 strings. Uses current year if year is missing.
 *
 * Supports: "March 15, 2026", "2026-03-15", "15/03/2026",
 *           "27th March", "March 27th"
 */
function extractDates(
  text: string,
  contextTimestamp: number,
  time?: { hour: number; minute: number } | null,
): ParsedDate[] {
  const results: ParsedDate[] = [];
  const currentYear = new Date(contextTimestamp * 1000).getUTCFullYear();
  const h = time?.hour;
  const m = time?.minute;

  // Pattern 1: "March 15, 2026" or "Mar 15"
  collectMonthDayDates(text, currentYear, results, h, m);

  // Pattern 2: "2026-03-15" (ISO)
  collectISODates(text, results, h, m);

  // Pattern 3: "15/03/2026" (DD/MM/YYYY)
  collectDDMMYYYYDates(text, results, h, m);

  // Pattern 4: "27th March" or "1st April 2026"
  collectOrdinalMonthDates(text, currentYear, results, h, m);

  // Pattern 5: "March 27th" or "April 1st 2026"
  collectMonthOrdinalDates(text, currentYear, results, h, m);

  return results;
}

function collectMonthDayDates(
  text: string,
  currentYear: number,
  out: ParsedDate[],
  h?: number,
  m?: number,
): void {
  MONTH_DAY_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = MONTH_DAY_PATTERN.exec(text)) !== null) {
    const monthName = match[1].toLowerCase();
    const day = parseInt(match[2], 10);
    const year = match[3] ? parseInt(match[3], 10) : currentYear;
    const month = MONTH_MAP[monthName];

    if (!month || !isValidDay(month, day, year)) continue;

    const isoDate = formatISO(year, month, day, h, m);
    out.push({ dateStr: match[0], isoDate });
  }
}

function collectISODates(text: string, out: ParsedDate[], h?: number, m?: number): void {
  ISO_DATE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ISO_DATE_PATTERN.exec(text)) !== null) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);

    if (month < 1 || month > 12 || !isValidDay(month, day, year)) continue;

    const isoDate = formatISO(year, month, day, h, m);
    out.push({ dateStr: match[0], isoDate });
  }
}

function collectDDMMYYYYDates(text: string, out: ParsedDate[], h?: number, m?: number): void {
  DD_MM_YYYY_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = DD_MM_YYYY_PATTERN.exec(text)) !== null) {
    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);

    if (month < 1 || month > 12 || !isValidDay(month, day, year)) continue;

    const isoDate = formatISO(year, month, day, h, m);
    out.push({ dateStr: match[0], isoDate });
  }
}

function collectOrdinalMonthDates(
  text: string,
  currentYear: number,
  out: ParsedDate[],
  h?: number,
  m?: number,
): void {
  ORDINAL_MONTH_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ORDINAL_MONTH_PATTERN.exec(text)) !== null) {
    const day = parseInt(match[1], 10);
    const monthName = match[2].toLowerCase();
    const year = match[3] ? parseInt(match[3], 10) : currentYear;
    const month = MONTH_MAP[monthName];

    if (!month || !isValidDay(month, day, year)) continue;

    const isoDate = formatISO(year, month, day, h, m);
    out.push({ dateStr: match[0], isoDate });
  }
}

function collectMonthOrdinalDates(
  text: string,
  currentYear: number,
  out: ParsedDate[],
  h?: number,
  m?: number,
): void {
  MONTH_ORDINAL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = MONTH_ORDINAL_PATTERN.exec(text)) !== null) {
    const monthName = match[1].toLowerCase();
    const day = parseInt(match[2], 10);
    const year = match[3] ? parseInt(match[3], 10) : currentYear;
    const month = MONTH_MAP[monthName];

    if (!month || !isValidDay(month, day, year)) continue;

    const isoDate = formatISO(year, month, day, h, m);
    out.push({ dateStr: match[0], isoDate });
  }
}

/** Basic day validation for a given month/year. */
function isValidDay(month: number, day: number, year: number): boolean {
  if (day < 1 || day > 31) return false;
  // Month-specific limits
  const daysInMonth = new Date(year, month, 0).getDate();
  return day <= daysInMonth;
}

/**
 * Format a date as ISO 8601 with extracted or default time.
 *
 * @param hour - Hour (0-23). Defaults to 9 (09:00 UTC) if not provided.
 * @param minute - Minute (0-59). Defaults to 0.
 */
function formatISO(
  year: number,
  month: number,
  day: number,
  hour: number = 9,
  minute: number = 0,
): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
}

/**
 * Extract time from text using TIME_PATTERN.
 *
 * Parses "at 2pm", "at 2:00 PM", "at 14:00", "at 3:30pm".
 * Returns { hour, minute } or null if no time found.
 * Wires the previously-unused TIME_PATTERN (Gap A24 #4).
 */
export function extractTime(text: string): { hour: number; minute: number } | null {
  TIME_PATTERN.lastIndex = 0;
  const match = TIME_PATTERN.exec(text);
  if (!match) return null;

  const raw = match[1].trim().toLowerCase();

  // Try HH:MM format first (e.g., "14:00", "2:30pm")
  const colonMatch = raw.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (colonMatch) {
    let hour = parseInt(colonMatch[1], 10);
    const minute = parseInt(colonMatch[2], 10);
    const ampm = colonMatch[3];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
  }

  // Try bare hour (e.g., "2pm", "14")
  const bareMatch = raw.match(/^(\d{1,2})\s*(am|pm)?$/);
  if (bareMatch) {
    let hour = parseInt(bareMatch[1], 10);
    const ampm = bareMatch[2];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23) {
      return { hour, minute: 0 };
    }
  }

  return null;
}

/** Classify the kind of event based on text context. */
function classifyEventKind(text: string): ExtractedEvent['kind'] {
  if (BIRTHDAY_PATTERN.test(text)) return 'birthday';
  if (INVOICE_PATTERN.test(text) || DUE_DATE_PATTERN.test(text)) return 'payment_due';
  if (APPOINTMENT_PATTERN.test(text)) return 'appointment';
  if (DEADLINE_PATTERN.test(text)) return 'deadline';
  if (VACCINATION_PATTERN.test(text)) return 'appointment'; // vaccination → appointment kind
  return 'custom';
}

/** Build a human-readable reminder message. */
function buildMessage(kind: ExtractedEvent['kind'], summary: string, dateStr: string): string {
  switch (kind) {
    case 'birthday':
      return summary || `Birthday on ${dateStr}`;
    case 'payment_due':
      return summary || `Payment due ${dateStr}`;
    case 'appointment':
      return summary || `Appointment on ${dateStr}`;
    case 'deadline':
      return summary || `Deadline: ${dateStr}`;
    default:
      return summary || `Event on ${dateStr}`;
  }
}
