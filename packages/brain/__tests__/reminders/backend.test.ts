/**
 * Reminder backend seam — verifies the `*Routed` wrappers go through a
 * registered backend (lite / out-of-process) and fall back to the
 * in-process reminder service when none is set (mobile / tests).
 *
 * This is the test that catches a regression of the Brain/Core reminder
 * boundary: if a consumer ever calls `@dina/core/reminders` directly
 * again, its writes would bypass the backend and never reach Core in
 * lite. The wrappers are the single choke point that keeps that honest.
 */

import { MockCoreClient } from '@dina/test-harness';
import {
  listByPersona as listByPersonaInProcess,
  resetReminderState,
} from '@dina/core/reminders';
import {
  setReminderBackend,
  getReminderBackend,
  createReminderRouted,
  listRemindersByPersonaRouted,
  listPendingRemindersRouted,
} from '../../src/reminders/backend';

describe('reminder backend routing', () => {
  afterEach(() => {
    setReminderBackend(null);
    resetReminderState();
  });

  describe('in-process fallback (no backend set)', () => {
    it('createReminderRouted writes to the in-process service', async () => {
      const due = Date.now() + 60_000;
      const r = await createReminderRouted({ message: 'standup', due_at: due, persona: 'work' });
      expect(r.id).toBeTruthy();
      // The in-process service Map now holds it.
      expect(listByPersonaInProcess('work').map((x) => x.id)).toContain(r.id);
    });

    it('listRemindersByPersonaRouted + listPendingRemindersRouted read in-process', async () => {
      const now = Date.now();
      await createReminderRouted({ message: 'due', due_at: now - 1000, persona: 'general' });
      await createReminderRouted({ message: 'later', due_at: now + 10_000_000, persona: 'general' });
      expect(await listRemindersByPersonaRouted('general')).toHaveLength(2);
      expect((await listPendingRemindersRouted(now)).map((r) => r.message)).toEqual(['due']);
    });
  });

  describe('routed through a registered backend (lite)', () => {
    let core: MockCoreClient;
    beforeEach(() => {
      core = new MockCoreClient();
      setReminderBackend({
        reminderCreate: (input) => core.reminderCreate(input),
        reminderListByPersona: (persona) => core.reminderListByPersona(persona),
        reminderListPending: (now) => core.reminderListPending(now),
      });
    });

    it('createReminderRouted hits the backend, NOT the in-process service', async () => {
      const due = Date.now() + 60_000;
      const r = await createReminderRouted({ message: 'remote', due_at: due, persona: 'work' });
      expect(core.callCountOf('reminderCreate')).toBe(1);
      // It landed in the backend's store, and the in-process service is
      // untouched (the boundary bug this whole feature fixes).
      expect((await listRemindersByPersonaRouted('work')).map((x) => x.id)).toEqual([r.id]);
      expect(listByPersonaInProcess('work')).toHaveLength(0);
    });

    it('listPendingRemindersRouted forwards the now cutoff to the backend', async () => {
      const now = Date.now();
      await createReminderRouted({ message: 'soon', due_at: now - 1000, persona: 'general' });
      await createReminderRouted({ message: 'far', due_at: now + 10_000_000, persona: 'general' });
      const pending = await listPendingRemindersRouted(now);
      expect(pending.map((r) => r.message)).toEqual(['soon']);
      expect(core.callCountOf('reminderListPending')).toBe(1);
    });

    it('getReminderBackend reflects the registered backend', () => {
      expect(getReminderBackend()).not.toBeNull();
    });
  });
});
