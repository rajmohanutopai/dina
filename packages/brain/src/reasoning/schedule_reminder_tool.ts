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
  reminder_id?: string;
  short_id?: string;
  due_at_ms?: number;
  message?: string;
  persona?: string;
  error?: string;
}

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}/;

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
  const resolvePersona = opts.resolvePersona;

  return {
    name: 'schedule_reminder',
    description:
      "Schedule a reminder that fires once at a specific time. Use it whenever the memory or request is time-bound and the user would want a heads-up — an appointment, a deadline, a payment, an arrival, OR a birthday / anniversary. Don't use it to store plain facts (those just go in a persona vault). You resolve the timing yourself: turn 'in 5 minutes', 'tomorrow at 9am', or a bare date into a concrete due_at (ISO-8601 string OR epoch milliseconds) BEFORE calling. For an annually-recurring date like a birthday or anniversary, schedule its NEXT occurrence — if this year's date has already passed, use next year — and fire ahead of time (e.g. a few days before) when the user would want to prepare. Call the tool more than once when a single event deserves multiple reminders (e.g. a prep reminder a few days out and a day-of reminder).",
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
        persona: {
          type: 'string',
          description:
            "OPTIONAL. The persona vault the reminder belongs to (e.g. 'general', 'health', 'work'). Defaults to 'general' when omitted. Use the same persona the user implied — health-related reminders go to 'health', work tasks to 'work'.",
        },
      },
      required: ['message', 'due_at'],
    },
    async execute(args): Promise<ScheduleReminderOutcome> {
      const message = String(args.message ?? '').trim();
      if (message === '') {
        return { status: 'rejected', error: 'message is required' };
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

      // Persona precedence: the LLM's explicit arg wins; otherwise fall
      // back to the persona the item was just routed to (remember loop),
      // and only then to the static default. This keeps the reminder in
      // the same vault as the item so the chat-card lookup finds it.
      const explicitPersona =
        typeof args.persona === 'string' && args.persona !== '' ? args.persona : '';
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
    },
  };
}
