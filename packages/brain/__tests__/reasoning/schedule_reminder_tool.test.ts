/**
 * Tests for `schedule_reminder` — the agentic-loop tool that creates
 * a one-off reminder on /ask. Closes MT-15-I2 (the gap where "Remind
 * me in 5 minutes to test" via /ask used to fall through to
 * vault_search).
 *
 * Coverage:
 *   1. Happy path: ISO due_at → reminder created, status 'scheduled'.
 *   2. Epoch-ms due_at also accepted (numeric + numeric-string).
 *   3. Empty / missing message → 'rejected' with explanatory error.
 *   4. Missing or malformed due_at → 'rejected', no reminder created.
 *   5. Past due_at (older than 60s back-window) → 'rejected'.
 *   6. Within back-window (clock skew) is accepted to keep tests + real
 *      devices stable.
 *   7. Persona defaults to 'general' when omitted; explicit persona
 *      survives.
 *   8. The tool's JSON Schema declares the right required fields and
 *      LLM-facing wire shape.
 */

import { describe, expect, it, beforeEach } from '@jest/globals';

import {
  resetReminderState,
  listByPersona,
} from '@dina/core/reminders';

function listAllReminders() {
  // Tests stage reminders into a small set of personas; this covers
  // every persona the suite uses without exposing an
  // all-personas listing helper from the reminders service (which
  // doesn't have one — listByPersona is the per-persona path; the
  // app surfaces global listings by iterating personas).
  return [...listByPersona('general'), ...listByPersona('health'), ...listByPersona('work')];
}

import {
  createScheduleReminderTool,
  type ScheduleReminderOutcome,
} from '../../src/reasoning/schedule_reminder_tool';

const FIXED_NOW = Date.UTC(2026, 4, 6, 12, 0, 0); // 2026-05-06T12:00:00Z

beforeEach(() => {
  resetReminderState();
});

function build(now = FIXED_NOW) {
  return createScheduleReminderTool({
    defaultPersona: 'general',
    defaultTimezone: 'UTC',
    nowMsFn: () => now,
  });
}

describe('schedule_reminder tool', () => {
  it('creates a reminder when given a future ISO due_at', async () => {
    const tool = build();
    const inOneHour = new Date(FIXED_NOW + 60 * 60_000).toISOString();
    const out = (await tool.execute({
      message: 'Test reminders',
      due_at: inOneHour,
    })) as ScheduleReminderOutcome;

    expect(out.status).toBe('scheduled');
    expect(out.reminder_id).toMatch(/^rem-/);
    expect(out.short_id).toMatch(/^[0-9a-f]{4}$/);
    expect(out.due_at_ms).toBe(Date.parse(inOneHour));
    expect(out.message).toBe('Test reminders');
    expect(out.persona).toBe('general');

    // Persisted into the reminder service.
    const all = listAllReminders();
    expect(all).toHaveLength(1);
    expect(all[0]?.message).toBe('Test reminders');
    expect(all[0]?.source).toBe('agentic_ask');
    expect(all[0]?.kind).toBe('manual');
  });

  it('accepts epoch milliseconds as a number', async () => {
    const tool = build();
    const dueAt = FIXED_NOW + 5 * 60_000;
    const out = (await tool.execute({
      message: 'Take pills',
      due_at: dueAt,
    })) as ScheduleReminderOutcome;

    expect(out.status).toBe('scheduled');
    expect(out.due_at_ms).toBe(dueAt);
  });

  it('accepts a numeric string for due_at (LLM sometimes stringifies)', async () => {
    const tool = build();
    const dueAt = FIXED_NOW + 2 * 60_000;
    const out = (await tool.execute({
      message: 'Stretch',
      due_at: String(dueAt),
    })) as ScheduleReminderOutcome;

    expect(out.status).toBe('scheduled');
    expect(out.due_at_ms).toBe(dueAt);
  });

  it('rejects an empty message without creating a reminder', async () => {
    const tool = build();
    const out = (await tool.execute({
      message: '   ',
      due_at: new Date(FIXED_NOW + 60_000).toISOString(),
    })) as ScheduleReminderOutcome;

    expect(out.status).toBe('rejected');
    expect(out.error).toMatch(/message/i);
    expect(listAllReminders()).toHaveLength(0);
  });

  it('rejects a malformed due_at without creating a reminder', async () => {
    const tool = build();
    const out = (await tool.execute({
      message: 'Bad time',
      due_at: 'sometime tomorrow',
    })) as ScheduleReminderOutcome;

    expect(out.status).toBe('rejected');
    expect(out.error).toMatch(/due_at/i);
    expect(listAllReminders()).toHaveLength(0);
  });

  it('rejects a due_at in the past (older than the 60s skew window)', async () => {
    const tool = build();
    const out = (await tool.execute({
      message: 'Past reminder',
      due_at: new Date(FIXED_NOW - 5 * 60_000).toISOString(),
    })) as ScheduleReminderOutcome;

    expect(out.status).toBe('rejected');
    expect(out.error).toMatch(/in the past/i);
    expect(listAllReminders()).toHaveLength(0);
  });

  it('accepts a due_at within the 60s clock-skew window', async () => {
    const tool = build();
    const out = (await tool.execute({
      message: 'Right now-ish',
      due_at: new Date(FIXED_NOW - 10_000).toISOString(),
    })) as ScheduleReminderOutcome;

    expect(out.status).toBe('scheduled');
    expect(listAllReminders()).toHaveLength(1);
  });

  it('honours an explicit persona arg', async () => {
    const tool = build();
    const out = (await tool.execute({
      message: 'Take medication',
      due_at: new Date(FIXED_NOW + 60_000).toISOString(),
      persona: 'health',
    })) as ScheduleReminderOutcome;

    expect(out.status).toBe('scheduled');
    expect(out.persona).toBe('health');
    expect(listAllReminders()[0]?.persona).toBe('health');
  });

  it('declares a tool schema the LLM can wire (name, required fields)', () => {
    const tool = build();
    expect(tool.name).toBe('schedule_reminder');
    expect(tool.description).toMatch(/remind/i);
    const schema = tool.parameters as {
      type: string;
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['message', 'due_at']);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['message', 'due_at', 'persona']),
    );
  });
});
