/**
 * `schedule_reminder` — agentic-loop tool that creates a reminder.
 * Shared by BOTH the /ask agentic loop and the /remember agentic loop
 * (`remember_runtime.ts`): whenever the model decides a memory or
 * request is time-bound, it calls this to schedule the reminder.
 *
 * Why this exists: /ask had no way to schedule ("Remind me in 2
 * minutes to test reminders" used to fall through to vault-search and
 * return "no relevant information"; MT-15-I2). The /remember loop now
 * routes through it too — it replaced the separate `reminder_planner`
 * LLM call, so this tool is the single place birthdays, appointments,
 * deadlines, and payments become reminders. Its description must
 * therefore cover recurring dates (birthdays / anniversaries → next
 * occurrence), not just one-offs — earlier wording said "recurring
 * reminders are out of scope", which made the model link the person
 * and silently skip the reminder for "Emma's birthday is Nov 7". See
 * the description string below.
 *
 * Design notes:
 *
 *   - The LLM does the date math. The tool accepts a single `due_at`
 *     (epoch milliseconds OR ISO-8601). Anything the LLM understands
 *     ("in 5 minutes", "tomorrow at 9am", "next Tuesday") becomes a
 *     concrete number BEFORE this tool sees it. Mirrors the contract
 *     that `geocode` / `delegate_to_agent` use — Brain stays
 *     deterministic, the LLM does interpretation.
 *
 *   - Persona defaults to `general`. Sensitive/locked personas need
 *     approval; this tool does NOT add a guard wrapper because
 *     reminders aren't a vault read — they're a write into Core's
 *     reminder service, which is per-persona but not gated by the
 *     same approval flow as vault items. If a persona-write gate is
 *     ever added to reminders, plumb a guard here the same way
 *     `vault_tool.ts` does.
 *
 *   - Past `due_at` is rejected. A reminder for "yesterday at 5pm"
 *     would never fire and would just clutter the list — better to
 *     return a clear error so the LLM can re-ask the user.
 *
 *   - `source: 'agentic_ask'` lets reminder telemetry / drains
 *     distinguish these from staging-pipeline reminders (which use
 *     `'reminder_planner'`).
 */

import { type Reminder } from '@dina/core/reminders';

import { createReminderRouted, listRemindersByPersonaRouted } from '../reminders/backend';

import type { AgentTool } from './tool_registry';

export interface ScheduleReminderToolOptions {
  /**
   * Default persona used when the LLM doesn't supply one. Most callers
   * pass `'general'`; multi-persona installs can pin to whichever
   * persona the chat surface defaults to. Falls back to `'general'`
   * when omitted.
   */
  defaultPersona?: string;
  /**
   * Default IANA timezone string carried into the reminder (only used
   * for display in the UI; due_at is always epoch ms). Falls back to
   * the runtime's resolved tz, then UTC.
   */
  defaultTimezone?: string;
  /**
   * The staging item id this reminder originates from, when called from
   * the /remember agentic loop. Persisted as the reminder's
   * `source_item_id` so the chat orchestrator can find the reminder it
   * just created and render the "Reminders set" confirmation card
   * (the legacy `reminder_planner` path set this; the agentic path used
   * to leave it empty, so the card never rendered). Omitted by /ask.
   */
  sourceItemId?: string;
  /**
   * New memory text that authorizes reminder planning in the /remember path.
   *
   * When present, the model must quote a time-bearing excerpt from this text
   * in `source_excerpt`. Recalled vault facts may enrich the reminder, but
   * cannot independently create one. /ask omits this option because the ask
   * itself is already the direct reminder request.
   */
  sourceText?: string;
  /**
   * Fallback persona resolver, evaluated only when the LLM omits an
   * explicit `persona` arg. The /remember loop passes the persona the
   * item was just routed to (via `route_to_persona`) so the reminder
   * lands in the SAME vault the item did — otherwise it would default
   * to `general` while the item went to e.g. `social`, and the chat
   * card lookup (which queries the routed persona) would miss it. /ask
   * omits this and falls straight through to `defaultPersona`.
   */
  resolvePersona?: () => string | undefined;
  /** Clock hook for tests. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /**
   * Optional plan-only seam used by the /remember staging pipeline.
   *
   * A staged memory may still require owner approval after Brain has
   * classified it. Creating a reminder while classification is in flight
   * would let an unapproved agent/connector cause a durable side effect.
   * When this callback is present, the tool validates and records the plan
   * but does not read or write the reminder repository. The staging drain
   * applies the plan only after Core confirms the memory was stored.
   *
   * /ask omits this callback and retains its immediate-create behavior.
   */
  deferCreate?: (plan: DeferredReminderPlan) => Promise<void> | void;
}

export interface DeferredReminderPlan {
  message: string;
  dueAtMs: number;
  persona: string;
  timezone: string;
}

export interface ScheduleReminderOutcome {
  status: 'scheduled' | 'duplicate' | 'rejected';
  /** Event form: one outcome per derived reminder. */
  reminders?: ScheduleReminderOutcome[];
  reminder_id?: string;
  short_id?: string;
  due_at_ms?: number;
  message?: string;
  persona?: string;
  error?: string;
}

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}/;

const TEMPORAL_SOURCE_PATTERNS = [
  /\b(?:today|tomorrow|tonight|later|soon|next|this|every|daily|weekly|monthly|yearly|annually)\b/i,
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i,
  /\b(?:birthday|anniversary|appointment|deadline|meeting|arrival|arriving|depart(?:ure|ing)?|due)\b/i,
  /\b(?:in|within)\s+(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:minute|hour|day|week|month|year)s?\b/i,
  /\b(?:at|by|before|after)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\b/i,
  /\b\d{1,2}(?::\d{2})\s*(?:a\.?m\.?|p\.?m\.?)?\b/i,
  /\b\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/,
] as const;

function normalizeSourceText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function hasTemporalSourceBasis(value: string): boolean {
  return TEMPORAL_SOURCE_PATTERNS.some((pattern) => pattern.test(value));
}

function parseDueAt(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && raw !== '') {
    // ISO-8601 (e.g. "2026-05-06T18:00:00-07:00") — preferred shape
    // for the LLM since Date.parse handles it portably.
    if (ISO_LIKE.test(raw)) {
      const ms = Date.parse(raw);
      if (!Number.isNaN(ms)) return ms;
    }
    // Numeric string ("1714000000000") — accept as a fallback.
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  }
  return null;
}

/** A dated event the reminders are derived from (REAL_LIFE_FIXES §2.6). */
export interface ReminderEvent {
  /** `birthday` / `anniversary` recur yearly; `one_time` happens once. */
  kind: 'birthday' | 'anniversary' | 'one_time';
  month: number;
  day: number;
  /** Stated year, if the owner gave one. */
  year?: number;
  /** How the reminders name it, e.g. "Emma's birthday". */
  title: string;
  /** What Dina recalls that helps prepare (e.g. "she loves dinosaurs"). */
  prep_note?: string;
  /** "HH:MM" when the owner gave a time (one_time only). */
  time?: string;
}

function readEvent(raw: unknown): ReminderEvent | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const kind = e.kind;
  if (kind !== 'birthday' && kind !== 'anniversary' && kind !== 'one_time') return null;
  const month = Number(e.month);
  const day = Number(e.day);
  return {
    kind,
    month,
    day,
    ...(e.year !== undefined && Number.isInteger(Number(e.year)) ? { year: Number(e.year) } : {}),
    title: typeof e.title === 'string' ? e.title : '',
    ...(typeof e.prep_note === 'string' ? { prep_note: e.prep_note } : {}),
    ...(typeof e.time === 'string' ? { time: e.time } : {}),
  };
}

/** Offset (ms) of `timeZone` from UTC at `utcMs`; 0 when unknown. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (t: string): number => Number(parts.find((x) => x.type === t)?.value ?? '0');
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return asUtc - Math.floor(utcMs / 1000) * 1000;
  } catch {
    return 0;
  }
}

/** Epoch ms of a wall-clock time in `timeZone`. */
export function wallClockToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffsetMs(guess, timeZone);
  // Re-check across a DST change.
  return guess - zoneOffsetMs(first, timeZone);
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** The calendar day (y, m, d) of `ms` in `timeZone`. */
function localDate(ms: number, timeZone: string): { y: number; m: number; d: number } {
  const shifted = new Date(ms + zoneOffsetMs(ms, timeZone));
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

export interface DerivedReminder {
  message: string;
  dueAtMs: number;
}

/**
 * The reminders for a dated event, per dina_details.md 3.3 / 13.2: the day
 * before at 10:00 (carrying the prep note) and the day itself at 09:00, in
 * the owner's timezone. Birthdays and anniversaries recur: with no stated
 * year, a date already past this year moves to next year; 29 February falls
 * on 28 February in other years. A one-time event keeps its date, and a past
 * one is refused. A prep time already past is skipped.
 */
export function deriveEventReminders(
  ev: ReminderEvent,
  nowMs: number,
  timeZone: string,
): { ok: true; reminders: DerivedReminder[] } | { ok: false; error: string } {
  const { month, day } = ev;
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) {
    return { ok: false, error: 'event month/day are not a calendar date' };
  }
  const title = (ev.title ?? '').trim();
  if (title === '') return { ok: false, error: 'event title is required' };
  const recurring = ev.kind === 'birthday' || ev.kind === 'anniversary';
  const today = localDate(nowMs, timeZone);
  let dayOfHour = 9;
  let dayOfMinute = 0;
  if (!recurring && typeof ev.time === 'string' && /^\d{1,2}:\d{2}$/.test(ev.time)) {
    const [h, m] = ev.time.split(':').map(Number) as [number, number];
    if (h <= 23 && m <= 59) {
      dayOfHour = h;
      dayOfMinute = m;
    }
  }
  const dateIn = (y: number): { y: number; m: number; d: number } =>
    month === 2 && day === 29 && !isLeap(y) ? { y, m: 2, d: 28 } : { y, m: month, d: day };

  let target: { y: number; m: number; d: number };
  if (recurring) {
    const stated = typeof ev.year === 'number' && ev.year > today.y ? ev.year : today.y;
    target = dateIn(stated);
    const dayOfThisYear = wallClockToEpoch(target.y, target.m, target.d, 23, 59, timeZone);
    if (dayOfThisYear < nowMs) target = dateIn(target.y + 1);
  } else {
    target = dateIn(typeof ev.year === 'number' ? ev.year : today.y);
    const dayOf = wallClockToEpoch(target.y, target.m, target.d, dayOfHour, dayOfMinute, timeZone);
    if (dayOf < nowMs - 60_000) {
      return { ok: false, error: 'that date has already passed; ask the user which date they mean' };
    }
  }

  const dayOfMs = wallClockToEpoch(target.y, target.m, target.d, dayOfHour, dayOfMinute, timeZone);
  // The calendar day before (not "minus 24 h", which is wrong across DST).
  const before = new Date(Date.UTC(target.y, target.m - 1, target.d - 1));
  const prepMs = wallClockToEpoch(
    before.getUTCFullYear(),
    before.getUTCMonth() + 1,
    before.getUTCDate(),
    10,
    0,
    timeZone,
  );
  const note = (ev.prep_note ?? '').trim();
  const reminders: DerivedReminder[] = [];
  if (prepMs >= nowMs) {
    reminders.push({ message: `${title} is tomorrow${note !== '' ? ` — ${note}` : ''}`, dueAtMs: prepMs });
  }
  if (dayOfMs >= nowMs - 60_000) reminders.push({ message: `${title} is today`, dueAtMs: dayOfMs });
  return { ok: true, reminders };
}

export function createScheduleReminderTool(opts: ScheduleReminderToolOptions = {}): AgentTool {
  const defaultPersona = opts.defaultPersona ?? 'general';
  const defaultTimezone =
    opts.defaultTimezone ??
    (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch {
        return 'UTC';
      }
    })();
  const nowMsFn = opts.nowMsFn ?? (() => Date.now());
  const sourceItemId = opts.sourceItemId ?? '';
  const sourceText = opts.sourceText;
  const resolvePersona = opts.resolvePersona;

  return {
    name: 'schedule_reminder',
    description:
      "Schedule a reminder. Use it whenever the memory or request is time-bound and the user would want a heads-up — an appointment, a deadline, a payment, an arrival, OR a birthday / anniversary. Don't use it to store plain facts (those just go in a persona vault). For a birthday, an anniversary or another dated occasion, pass `event` (kind, month, day, optional year, title such as \"Emma's birthday\", and a prep_note with anything you recall that helps the user prepare) INSTEAD of message/due_at: Dina then sets a reminder the day before and one on the day. For anything else, pass message + due_at: resolve 'in 5 minutes', 'tomorrow at 9am', or a date into a concrete due_at (ISO-8601 string OR epoch milliseconds) BEFORE calling." +
      (sourceText === undefined
        ? ''
        : ' This Remember call is source-bound: source_excerpt MUST quote the exact words in the NEW memory that make it time-bound. Recalled vault facts may enrich the reminder but are not authority to schedule one.'),
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description:
            "What the reminder should say when it fires. Phrase as the user will read it — e.g. 'Test reminders' or 'Call mum about birthday', NOT 'Reminder set' or 'User wants to be reminded'.",
        },
        due_at: {
          anyOf: [{ type: 'string' }, { type: 'number' }],
          description:
            "When the reminder should fire. Preferred: ISO-8601 with timezone offset (e.g. '2026-05-06T18:00:00-07:00'). Also accepted: epoch milliseconds as a number or numeric string. Resolve relative phrases ('in 5 minutes', 'tomorrow at 9am') into a concrete value BEFORE calling — this tool will not re-interpret natural language.",
        },
        event: {
          type: 'object',
          description:
            "A dated event (use instead of message/due_at for birthdays, anniversaries and dated occasions). Dina derives a reminder the day before (with prep_note) and one on the day.",
          properties: {
            kind: { type: 'string', enum: ['birthday', 'anniversary', 'one_time'] },
            month: { type: 'number', description: '1-12' },
            day: { type: 'number', description: '1-31' },
            year: { type: 'number', description: 'OPTIONAL. Only when the user stated it.' },
            title: { type: 'string', description: "How to name it, e.g. \"Emma's birthday\"." },
            prep_note: {
              type: 'string',
              description: 'OPTIONAL. What helps the user prepare, from what Dina knows (e.g. "she loves dinosaurs").',
            },
            time: { type: 'string', description: 'OPTIONAL "HH:MM", one_time only, when the user gave a time.' },
          },
          required: ['kind', 'month', 'day', 'title'],
        },
        persona: {
          type: 'string',
          description:
            "OPTIONAL. The persona vault the reminder belongs to (e.g. 'general', 'health', 'work'). Defaults to 'general' when omitted. Use the same persona the user implied — health-related reminders go to 'health', work tasks to 'work'.",
        },
        ...(sourceText === undefined
          ? {}
          : {
              source_excerpt: {
                type: 'string',
                description:
                  'An exact quote from the new memory containing its date, time, deadline, or temporal event. Do not quote recalled vault context.',
              },
            }),
      },
      // message + due_at, OR event (checked in execute).
      required: sourceText === undefined ? [] : ['source_excerpt'],
    },
    async execute(args): Promise<ScheduleReminderOutcome> {
      // REAL_LIFE_FIXES §2.6: a dated event — Brain derives the reminders.
      const ev = readEvent(args.event);
      if (ev !== null) {
        if (sourceText !== undefined) {
          const excerpt = normalizeSourceText(String(args.source_excerpt ?? '').trim());
          if (excerpt === '' || !normalizeSourceText(sourceText).includes(excerpt) || !hasTemporalSourceBasis(String(args.source_excerpt ?? ''))) {
            return {
              status: 'rejected',
              error:
                'source_excerpt must quote time-bearing words from the new memory; recalled facts cannot create a reminder',
            };
          }
        }
        const derived = deriveEventReminders(ev, nowMsFn(), defaultTimezone);
        if (!derived.ok) return { status: 'rejected', error: derived.error };
        if (derived.reminders.length === 0) {
          return { status: 'rejected', error: 'both reminder times have passed' };
        }
        const outs: ScheduleReminderOutcome[] = [];
        for (const r of derived.reminders) outs.push(await scheduleOne(r.message, r.dueAtMs, args.persona));
        const ok = outs.filter((o) => o.status !== 'rejected');
        return ok.length === 0
          ? { status: 'rejected', error: outs[0]?.error ?? 'could not schedule', reminders: outs }
          : { status: 'scheduled', reminders: outs };
      }

      const message = String(args.message ?? '').trim();
      if (message === '') {
        return { status: 'rejected', error: 'message is required' };
      }

      if (sourceText !== undefined) {
        const sourceExcerpt = String(args.source_excerpt ?? '').trim();
        const normalizedSource = normalizeSourceText(sourceText);
        const normalizedExcerpt = normalizeSourceText(sourceExcerpt);
        if (
          normalizedExcerpt === '' ||
          !normalizedSource.includes(normalizedExcerpt) ||
          !hasTemporalSourceBasis(sourceExcerpt)
        ) {
          return {
            status: 'rejected',
            error:
              'source_excerpt must quote time-bearing words from the new memory; recalled facts cannot create a reminder',
          };
        }
      }

      const dueAtMs = parseDueAt(args.due_at);
      if (dueAtMs === null) {
        return {
          status: 'rejected',
          error: 'due_at is required and must be epoch milliseconds or an ISO-8601 datetime string',
        };
      }
      // Past due_at would never fire — return cleanly so the LLM can
      // re-ask the user. Allow a 60s back-window for clock skew (tests
      // and real devices can land a tick in the past after the LLM
      // round-trip).
      if (dueAtMs < nowMsFn() - 60_000) {
        return {
          status: 'rejected',
          error: `due_at is in the past (${new Date(dueAtMs).toISOString()})`,
        };
      }

      return scheduleOne(message, dueAtMs, args.persona);
    },
  };

  /** Create one reminder (shared by the single and event forms). */
  async function scheduleOne(
    message: string,
    dueAtMs: number,
    personaArg: unknown,
  ): Promise<ScheduleReminderOutcome> {
      // Persona precedence: the LLM's explicit arg wins; otherwise fall
      // back to the persona the item was just routed to (remember loop),
      // and only then to the static default. This keeps the reminder in
      // the same vault as the item so the chat-card lookup finds it.
      const explicitPersona =
        typeof personaArg === 'string' && personaArg !== '' ? personaArg : '';
      const fallbackPersona = (resolvePersona?.() ?? '').trim();
      const persona =
        explicitPersona !== ''
          ? explicitPersona
          : fallbackPersona !== ''
            ? fallbackPersona
            : defaultPersona;

      if (opts.deferCreate !== undefined) {
        try {
          await opts.deferCreate({
            message,
            dueAtMs,
            persona,
            timezone: defaultTimezone,
          });
        } catch (err) {
          return {
            status: 'rejected',
            error: err instanceof Error ? err.message : String(err),
          };
        }
        return {
          status: 'scheduled',
          due_at_ms: dueAtMs,
          message,
          persona,
        };
      }

      // Detect a true duplicate reliably + deterministically: check whether
      // an identical manual reminder already exists BEFORE creating. The
      // service dedupes on (source_item_id, kind, due_at, persona, message),
      // and agentic-ask always uses source_item_id='' + kind='manual', so a
      // match on (manual, due_at, message) in this persona is exactly the
      // row the create would dedup onto. (The old `source`-based heuristic
      // broke once `message` joined the dedup key — a dup returns a
      // same-source row, so it never tripped.)
      const alreadyExists = (await listRemindersByPersonaRouted(persona)).some(
        (r) =>
          r.kind === 'manual' &&
          r.due_at === dueAtMs &&
          r.message === message &&
          r.source_item_id === sourceItemId,
      );

      let reminder: Reminder;
      try {
        reminder = await createReminderRouted({
          message,
          due_at: dueAtMs,
          persona,
          kind: 'manual',
          source_item_id: sourceItemId,
          source: 'agentic_ask',
          timezone: defaultTimezone,
        });
      } catch (err) {
        return {
          status: 'rejected',
          error: err instanceof Error ? err.message : String(err),
        };
      }

      return {
        status: alreadyExists ? 'duplicate' : 'scheduled',
        reminder_id: reminder.id,
        short_id: reminder.short_id,
        due_at_ms: reminder.due_at,
        message: reminder.message,
        persona: reminder.persona,
      };
  }
}
