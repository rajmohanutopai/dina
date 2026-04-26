/**
 * `fireRemindersToThread` — pin the fire-time → chat-thread post
 * behaviour (5.64). Drives the pure function the hook wraps so we
 * don't need `@testing-library/react-native` (not installed). The
 * hook itself is just a `useEffect` that calls this function on a
 * setInterval — the side-effect logic lives here.
 *
 * Pins:
 *   - past-due reminders fire and post a `'reminder'`-typed thread
 *     message with structured metadata for the inline card
 *   - subsequent calls don't re-post the same reminder (service
 *     transitions it to `'fired'` after the first fire)
 *   - future-dated reminders don't fire
 *   - `threadId` arg routes correctly
 */

import { fireRemindersToThread } from '../../src/hooks/useReminderFireWatcher';
import {
  createReminder,
  resetReminderState,
} from '../../../../packages/core/src/reminders/service';
import { getThread, resetThreads } from '../../../../packages/brain/src/chat/thread';
import {
  listNotifications,
  resetNotifications,
} from '../../../../packages/brain/src/notifications/inbox';

const NOW = 1_700_000_000_000; // arbitrary fixed clock

beforeEach(() => {
  resetReminderState();
  resetThreads();
  resetNotifications();
});

describe('fireRemindersToThread', () => {
  it('fires a past-due reminder and writes a reminder-typed message with metadata', () => {
    createReminder({
      message: 'Pay rent',
      due_at: NOW - 1000,
      persona: 'financial',
      kind: 'payment_due',
    });

    const fired = fireRemindersToThread('main', NOW);
    expect(fired).toBe(1);

    const thread = getThread('main');
    expect(thread).toHaveLength(1);
    const msg = thread[0]!;
    expect(msg.type).toBe('reminder');
    expect(msg.content).toBe('Pay rent');
    expect(msg.metadata).toMatchObject({
      kind: 'reminder',
      persona: 'financial',
      reminderKind: 'payment_due',
      dueAt: NOW - 1000,
    });
    expect(typeof msg.metadata?.reminderId).toBe('string');
    expect((msg.metadata?.reminderId as string).length).toBeGreaterThan(0);
  });

  it('does NOT re-fire the same reminder on a second call', () => {
    createReminder({
      message: 'Pay rent',
      due_at: NOW - 1000,
      persona: 'financial',
    });

    expect(fireRemindersToThread('main', NOW)).toBe(1);
    expect(getThread('main')).toHaveLength(1);

    // Second call: the service flipped the status to 'fired', so
    // listPending no longer returns it.
    expect(fireRemindersToThread('main', NOW + 60_000)).toBe(0);
    expect(getThread('main')).toHaveLength(1);
  });

  it('skips reminders whose due_at is still in the future', () => {
    createReminder({
      message: 'Tomorrow lunch',
      due_at: NOW + 86_400_000,
      persona: 'general',
    });

    expect(fireRemindersToThread('main', NOW)).toBe(0);
    expect(getThread('main')).toEqual([]);
  });

  it('routes to the configured threadId', () => {
    createReminder({
      message: 'BP check',
      due_at: NOW - 1000,
      persona: 'health',
    });

    fireRemindersToThread('/health', NOW);
    expect(getThread('/health')).toHaveLength(1);
    expect(getThread('main')).toEqual([]);
  });

  it('fires multiple past-due reminders in one call', () => {
    createReminder({ message: 'A', due_at: NOW - 3000, persona: 'general' });
    createReminder({ message: 'B', due_at: NOW - 2000, persona: 'general' });
    createReminder({ message: 'C', due_at: NOW + 5000, persona: 'general' }); // future, skip

    expect(fireRemindersToThread('main', NOW)).toBe(2);
    const thread = getThread('main');
    expect(thread.map((m) => m.content).sort()).toEqual(['A', 'B']);
  });

  it('defaults to threadId="main" when omitted', () => {
    createReminder({
      message: 'Default thread test',
      due_at: NOW - 1000,
      persona: 'general',
    });

    fireRemindersToThread(undefined, NOW);
    expect(getThread('main')).toHaveLength(1);
  });

  it('mirrors fired reminders into the unified notifications inbox (5.66)', () => {
    const r = createReminder({
      message: 'BP check',
      due_at: NOW - 1000,
      persona: 'health',
      kind: 'appointment',
    });
    fireRemindersToThread('health', NOW);

    const inbox = listNotifications();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      id: `nt-rem-${r.id}`,
      kind: 'reminder',
      title: 'BP check',
      body: '/health',
      sourceId: r.id,
      deepLink: `dina://chat/health?focus=${r.id}`,
    });
  });
});
