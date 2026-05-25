/**
 * Reminder route ⇄ CoreClient contract — drives the REAL router
 * (`registerReminderRoutes`) through `InProcessTransport`, so a path or
 * field mismatch between the client and the registered routes fails
 * here. This is the out-of-process (lite) reminder boundary: Brain
 * creates + reads reminders through Core so they land in Core's
 * authoritative store rather than Brain's process-local Map.
 */

import { InProcessTransport } from '../../../src/client/in-process-transport';
import { CoreRouter } from '../../../src/server/router';
import { registerReminderRoutes } from '../../../src/server/routes/reminders';
import { resetReminderState } from '../../../src/reminders/service';

function build(): InProcessTransport {
  const router = new CoreRouter();
  registerReminderRoutes(router);
  return new InProcessTransport(router);
}

describe('reminder routes ⇄ CoreClient contract', () => {
  beforeEach(() => resetReminderState());
  afterEach(() => resetReminderState());

  it('reminderCreate persists into Core and round-trips by persona', async () => {
    const t = build();
    const due = Date.now() + 60_000;
    const created = await t.reminderCreate({
      message: 'Call the dentist',
      due_at: due,
      persona: 'health',
      kind: 'manual',
      source: 'agentic_ask',
    });
    expect(created.id).toBeTruthy();
    expect(created.persona).toBe('health');
    expect(created.status).toBe('pending');

    // Visible to a persona read — and NOT leaking into another persona.
    const health = await t.reminderListByPersona('health');
    expect(health.map((r) => r.id)).toContain(created.id);
    expect(await t.reminderListByPersona('work')).toHaveLength(0);
  });

  it('reminderCreate dedups a true duplicate (source_item_id, kind, due_at, persona, message)', async () => {
    const t = build();
    const due = Date.now() + 120_000;
    const fields = {
      message: 'Pay rent',
      due_at: due,
      persona: 'general',
      kind: 'bill',
      source_item_id: 'item-1',
    };
    const a = await t.reminderCreate(fields);
    const b = await t.reminderCreate({ ...fields }); // identical → genuine duplicate
    expect(b.id).toBe(a.id);
    expect(await t.reminderListByPersona('general')).toHaveLength(1);
  });

  it('reminderListPending honours the now cutoff', async () => {
    const t = build();
    const now = Date.now();
    await t.reminderCreate({ message: 'due soon', due_at: now - 1000, persona: 'general' });
    await t.reminderCreate({ message: 'far future', due_at: now + 10_000_000, persona: 'general' });

    // Window just past the first reminder — the future one is excluded.
    const pending = await t.reminderListPending(now);
    expect(pending.map((r) => r.message)).toEqual(['due soon']);

    // Wider window includes both.
    const all = await t.reminderListPending(now + 20_000_000);
    expect(all).toHaveLength(2);
  });

  it('reminderListByPersona rejects an empty persona at the transport', async () => {
    const t = build();
    await expect(t.reminderListByPersona('')).rejects.toThrow(/persona is required/);
  });

  it('reminderComplete marks done (non-recurring → next null) and drops from pending', async () => {
    const t = build();
    const now = Date.now();
    const r = await t.reminderCreate({ message: 'one-off', due_at: now - 1000, persona: 'general' });
    expect(await t.reminderListPending(now)).toHaveLength(1);

    const next = await t.reminderComplete(r.id);
    expect(next).toBeNull(); // not recurring
    // No longer pending; the persona list shows it completed.
    expect(await t.reminderListPending(now)).toHaveLength(0);
    const all = await t.reminderListByPersona('general');
    expect(all.find((x) => x.id === r.id)?.completed).toBe(1);
  });

  it('reminderComplete on an unknown id is a 404 (transport surfaces it)', async () => {
    const t = build();
    await expect(t.reminderComplete('rem-nope')).rejects.toThrow();
  });

  it('reminderSnooze pushes due_at out + marks snoozed', async () => {
    const t = build();
    // Future due_at so snooze bases off due_at (not now): snoozeReminder
    // uses max(due_at, now) + snoozeMs. Capture the value (not the live
    // object, which the service mutates in place).
    const dueAt = Date.now() + 10_000;
    const r = await t.reminderCreate({ message: 'snooze me', due_at: dueAt, persona: 'general' });
    const updated = await t.reminderSnooze(r.id, 60_000);
    expect(updated?.status).toBe('snoozed');
    expect(updated?.due_at).toBe(dueAt + 60_000);
  });

  it('reminderSnooze rejects a non-positive duration', async () => {
    const t = build();
    const r = await t.reminderCreate({ message: 'x', due_at: Date.now(), persona: 'general' });
    await expect(t.reminderSnooze(r.id, 0)).rejects.toThrow();
  });

  it('reminderDelete removes the row', async () => {
    const t = build();
    const r = await t.reminderCreate({ message: 'gone', due_at: Date.now() + 1000, persona: 'general' });
    expect(await t.reminderDelete(r.id)).toBe(true);
    expect(await t.reminderListByPersona('general')).toHaveLength(0);
    // Idempotent-ish: deleting an unknown id returns false, no throw.
    expect(await t.reminderDelete('rem-nope')).toBe(false);
  });

  it('reminderFireMissed fires due reminders once (idempotent) + flips them off pending', async () => {
    const t = build();
    const now = Date.now();
    await t.reminderCreate({ message: 'due A', due_at: now - 2000, persona: 'general' });
    await t.reminderCreate({ message: 'due B', due_at: now - 1000, persona: 'general' });
    await t.reminderCreate({ message: 'future', due_at: now + 1_000_000, persona: 'general' });

    const fired = await t.reminderFireMissed(now);
    expect(fired.map((r) => r.message).sort()).toEqual(['due A', 'due B']);
    expect(fired.every((r) => r.status === 'fired')).toBe(true);

    // Idempotent: a second fire returns nothing (already fired).
    expect(await t.reminderFireMissed(now)).toHaveLength(0);
  });

  it('normalizes persona (+message) before storing — a " health " create reads back under "health"', async () => {
    const t = build();
    const created = await t.reminderCreate({
      message: '  drink water  ',
      due_at: Date.now() + 1000,
      persona: '  health  ',
    });
    expect(created.persona).toBe('health'); // trimmed at the boundary
    expect(created.message).toBe('drink water');
    // The whole point: a read for the canonical "health" finds it.
    const health = await t.reminderListByPersona('health');
    expect(health.map((r) => r.id)).toContain(created.id);
  });
});
