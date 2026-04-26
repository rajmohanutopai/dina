/**
 * Reminder → OS-push bridge (5.60 producer wiring).
 *
 * Pins: every `createReminder` fires `scheduleNotification` with the
 * right shape; tier mapping; idempotency on dedup-hit; disposer
 * detaches.
 */

import {
  createReminder,
  resetReminderState,
} from '../../../../packages/core/src/reminders/service';
import { installReminderPushBridge } from '../../src/notifications/reminder_push_bridge';
import {
  getScheduled,
  resetNotifications,
} from '../../src/notifications/local';
import * as NotificationsMock from 'expo-notifications';
import { resetKVStore } from '../../../../packages/core/src/kv/store';

const Mock = NotificationsMock as unknown as typeof NotificationsMock & {
  __resetNotificationsMock: () => void;
};

beforeEach(async () => {
  resetKVStore();
  Mock.__resetNotificationsMock();
  await resetNotifications();
  resetReminderState();
});

async function flushMicrotasks(): Promise<void> {
  // The bridge fires `void scheduleNotification(...)` (fire-and-forget
  // from a sync subscribe callback), so tests need a microtask flush
  // before asserting against the kv mirror / OS scheduler.
  await Promise.resolve();
  await Promise.resolve();
}

describe('installReminderPushBridge (5.60)', () => {
  it('schedules a Tier-2 OS notification when a regular reminder is created', async () => {
    const dispose = installReminderPushBridge();
    const r = createReminder({
      message: 'Pay rent',
      due_at: Date.now() + 60_000,
      persona: 'general',
    });
    await flushMicrotasks();

    const scheduled = await getScheduled();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      id: `notif-rem-${r.id}`,
      title: 'Pay rent',
      channel: 'solicited',
      data: {
        inboxId: `nt-rem-${r.id}`,
        deepLink: `dina://chat/main?focus=${r.id}`,
        kind: 'reminder',
        reminderId: r.id,
      },
    });
    dispose();
  });

  it('elevates health_alert to fiduciary channel (Tier 1)', async () => {
    installReminderPushBridge();
    createReminder({
      message: 'Lab results back',
      due_at: Date.now() + 60_000,
      persona: 'health',
      kind: 'health_alert',
    });
    await flushMicrotasks();
    expect((await getScheduled())[0]!.channel).toBe('fiduciary');
  });

  it('elevates payment_due to fiduciary', async () => {
    installReminderPushBridge();
    createReminder({
      message: 'Mortgage due',
      due_at: Date.now() + 60_000,
      persona: 'financial',
      kind: 'payment_due',
    });
    await flushMicrotasks();
    expect((await getScheduled())[0]!.channel).toBe('fiduciary');
  });

  it('omits the body when persona is general (no /persona suffix)', async () => {
    installReminderPushBridge();
    createReminder({
      message: 'Test',
      due_at: Date.now() + 60_000,
      persona: 'general',
    });
    await flushMicrotasks();
    expect((await getScheduled())[0]!.body).toBe('');
  });

  it('shows /persona body for non-general personas', async () => {
    installReminderPushBridge();
    createReminder({
      message: 'BP check',
      due_at: Date.now() + 60_000,
      persona: 'health',
    });
    await flushMicrotasks();
    expect((await getScheduled())[0]!.body).toBe('/health');
  });

  it('dedup hit upserts on the same identifier (no duplicate banner)', async () => {
    installReminderPushBridge();
    // First create.
    const r1 = createReminder({
      message: 'BP',
      due_at: 1_700_000_000_000,
      persona: 'health',
      kind: 'appointment',
      source_item_id: 'item-1',
    });
    // Same dedup key → returns existing reminder.
    const r2 = createReminder({
      message: 'BP',
      due_at: 1_700_000_000_000,
      persona: 'health',
      kind: 'appointment',
      source_item_id: 'item-1',
    });
    expect(r1.id).toBe(r2.id);
    await flushMicrotasks();
    // Dedup short-circuits BEFORE the listener fires, so only one
    // schedule is recorded — proves the bridge isn't an O(n) leak on
    // duplicate creates.
    const scheduled = await getScheduled();
    expect(scheduled).toHaveLength(1);
  });

  it('disposer detaches — subsequent reminders are not scheduled', async () => {
    const dispose = installReminderPushBridge();
    dispose();
    createReminder({
      message: 'After dispose',
      due_at: Date.now() + 60_000,
      persona: 'general',
    });
    await flushMicrotasks();
    expect(await getScheduled()).toHaveLength(0);
  });
});
