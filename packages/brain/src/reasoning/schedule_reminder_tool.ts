/**
 * `schedule_reminder` — agentic-loop tool that creates a reminder
 * directly from /ask flow.
 *
 * Why this exists: the `/remember` path runs the LLM-driven reminder
 * planner as a side-effect of staging an item — useful for "Pick up
 * dry cleaning tomorrow at 6pm" because the dry-cleaning fact itself
 * is also worth remembering. /ask has no equivalent: "Remind me in 2
 * minutes to test reminders" used to fall through to the vault-search
 * tool and return "no relevant information about that in my memory."
 * (MT-15-I2). This tool closes the gap by giving the LLM a first-class
 * way to schedule a one-off reminder when the user's intent is clearly
 * "schedule a reminder" rather than "store a fact".
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

import { createReminder, type Reminder } from '@dina/core/reminders';

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
  /** Clock hook for tests. Defaults to `Date.now`. */
  nowMsFn?: () => number;
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

export function createScheduleReminderTool(
  opts: ScheduleReminderToolOptions = {},
): AgentTool {
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

  return {
    name: 'schedule_reminder',
    description:
      "Schedule a one-off reminder. Use when the user's intent is clearly 'remind me to X at/in Y' — NOT for storing facts (use /remember for those). The LLM is responsible for resolving phrases like 'in 5 minutes' or 'tomorrow at 9am' into a concrete due_at (ISO-8601 string OR epoch milliseconds) BEFORE calling. The reminder fires once at due_at; recurring reminders are out of scope for this tool.",
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description:
            "What the reminder should say when it fires. Phrase as the user will read it — e.g. 'Test reminders' or 'Call mum about birthday', NOT 'Reminder set' or 'User wants to be reminded'.",
        },
        due_at: {
          type: 'string',
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
          error:
            'due_at is required and must be epoch milliseconds or an ISO-8601 datetime string',
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

      const persona =
        typeof args.persona === 'string' && args.persona !== ''
          ? args.persona
          : defaultPersona;

      let reminder: Reminder;
      try {
        reminder = createReminder({
          message,
          due_at: dueAtMs,
          persona,
          kind: 'manual',
          source: 'agentic_ask',
          timezone: defaultTimezone,
        });
      } catch (err) {
        return {
          status: 'rejected',
          error: err instanceof Error ? err.message : String(err),
        };
      }

      // `createReminder` dedupes on (source_item_id, kind, due_at,
      // persona). Agentic-ask calls leave source_item_id empty, so the
      // dedup essentially keys on (manual, due_at, persona): a
      // back-to-back "/ask remind me at 5pm to X" returns the same
      // reminder on the second call. Surface that as `duplicate` so
      // the LLM doesn't tell the user "scheduled" twice. We detect it
      // by the reminder's `source` — anything other than `'agentic_ask'`
      // came from a different code path (e.g. the staging reminder
      // planner) and is by definition a pre-existing row.
      const isExistingFromOtherSource = reminder.source !== 'agentic_ask';

      return {
        status: isExistingFromOtherSource ? 'duplicate' : 'scheduled',
        reminder_id: reminder.id,
        short_id: reminder.short_id,
        due_at_ms: reminder.due_at,
        message: reminder.message,
        persona: reminder.persona,
      };
    },
  };
}
