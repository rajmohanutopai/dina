/**
 * Local notifications scheduler — tasks 5.59 / 5.60 / 5.61.
 *
 * Tests run against the `expo-notifications` jest mock (see
 * `__mocks__/expo-notifications.ts`). The kv_store mirror runs purely
 * in-memory because no `setKVRepository` is wired in `beforeEach`.
 */

import {
  cancelAllNotifications,
  cancelNotification,
  ensureChannels,
  forceRequestPushPermission,
  getPersistedPermissionStatus,
  getScheduled,
  rescheduleAllReminders,
  requestPushPermission,
  resetNotifications,
  scheduleNotification,
  tierToChannel,
} from '../../src/notifications/local';
import * as NotificationsMock from 'expo-notifications';
import { resetKVStore } from '../../../../packages/core/src/kv/store';

// Cast to the mock's broader surface (test helpers prefixed `__`).
const Mock = NotificationsMock as unknown as typeof NotificationsMock & {
  __setPermissionResult: (r: { granted: boolean; canAskAgain?: boolean }) => void;
  __resetNotificationsMock: () => void;
  __getScheduled: () => Array<{ identifier: string }>;
};

beforeEach(async () => {
  resetKVStore();
  Mock.__resetNotificationsMock();
  await resetNotifications();
});

describe('tierToChannel', () => {
  it('Tier 1 → fiduciary', () => expect(tierToChannel(1)).toBe('fiduciary'));
  it('Tier 2 → solicited', () => expect(tierToChannel(2)).toBe('solicited'));
  it('Tier 3 → engagement', () => expect(tierToChannel(3)).toBe('engagement'));
});

describe('scheduleNotification (5.60)', () => {
  it('schedules with the OS scheduler AND mirrors to kv_store', async () => {
    const id = await scheduleNotification({
      title: 'Pay rent',
      body: 'Due today',
      channel: 'fiduciary',
      triggerAt: Date.now() + 60_000,
      data: { kind: 'reminder', sourceId: 'rem-1' },
    });
    expect(id).toMatch(/^notif-/);

    const osEntries = Mock.__getScheduled();
    expect(osEntries.map((e) => e.identifier)).toEqual([id]);

    const mirror = await getScheduled();
    expect(mirror).toHaveLength(1);
    expect(mirror[0]!).toMatchObject({
      id,
      title: 'Pay rent',
      body: 'Due today',
      channel: 'fiduciary',
      data: { kind: 'reminder', sourceId: 'rem-1' },
    });
  });

  it('caller-supplied id is honoured (idempotent re-schedule)', async () => {
    const id = await scheduleNotification({
      id: 'fixed-1',
      title: 'A',
      body: 'a',
      channel: 'solicited',
      triggerAt: Date.now() + 1000,
    });
    expect(id).toBe('fixed-1');
    // Re-schedule with the same id → OS replaces (the mock's
    // identifier match mirrors that behaviour).
    await scheduleNotification({
      id: 'fixed-1',
      title: 'A v2',
      body: 'a',
      channel: 'solicited',
      triggerAt: Date.now() + 2000,
    });
    expect(Mock.__getScheduled()).toHaveLength(1);
    expect((await getScheduled())[0]!.title).toBe('A v2');
  });

  it('clamps zero / negative triggerAt to fire immediately (>=1s)', async () => {
    await scheduleNotification({
      title: 'Already',
      body: '',
      channel: 'solicited',
      triggerAt: Date.now() - 5000,
    });
    const osEntries = Mock.__getScheduled() as unknown as Array<{
      trigger: { seconds: number };
    }>;
    expect(osEntries[0]!.trigger.seconds).toBeGreaterThanOrEqual(1);
  });
});

describe('cancelNotification', () => {
  it('cancels in OS scheduler + mirror', async () => {
    const id = await scheduleNotification({
      title: 't',
      body: 'b',
      channel: 'solicited',
      triggerAt: Date.now() + 1000,
    });
    await cancelNotification(id);
    expect(Mock.__getScheduled()).toHaveLength(0);
    expect(await getScheduled()).toHaveLength(0);
  });

  it('is a no-op for an unknown id', async () => {
    await expect(cancelNotification('does-not-exist')).resolves.toBeUndefined();
  });
});

describe('cancelAllNotifications', () => {
  it('wipes the schedule but keeps the persisted permission status', async () => {
    await forceRequestPushPermission(); // writes 'granted'
    await scheduleNotification({
      title: 'a',
      body: '',
      channel: 'solicited',
      triggerAt: Date.now() + 1000,
    });
    await cancelAllNotifications();
    expect(await getScheduled()).toHaveLength(0);
    expect(await getPersistedPermissionStatus()).toBe('granted');
  });
});

describe('rescheduleAllReminders (5.61 cold-start)', () => {
  it('re-issues entries whose triggerAt is still in the future', async () => {
    const NOW = 1_700_000_000_000;
    await scheduleNotification({
      title: 'future',
      body: '',
      channel: 'solicited',
      triggerAt: NOW + 60_000,
    });
    // Simulate a cold start: the OS scheduler was wiped, the mirror
    // survived in kv_store.
    Mock.__resetNotificationsMock();
    expect(Mock.__getScheduled()).toHaveLength(0);

    const count = await rescheduleAllReminders(NOW);
    expect(count).toBe(1);
    expect(Mock.__getScheduled()).toHaveLength(1);
  });

  it('drops entries whose triggerAt is past', async () => {
    const NOW = 1_700_000_000_000;
    await scheduleNotification({
      title: 'past',
      body: '',
      channel: 'solicited',
      triggerAt: NOW - 60_000,
    });
    Mock.__resetNotificationsMock();
    const count = await rescheduleAllReminders(NOW);
    expect(count).toBe(0);
    expect(await getScheduled()).toHaveLength(0); // mirror cleaned too
  });

  it('drops malformed mirror entries silently', async () => {
    // Inject a broken mirror entry to confirm the cold-start loop
    // doesn't crash on garbage from a prior version.
    const { kvSet } = await import('../../../../packages/core/src/kv/store');
    await kvSet('broken-1', '{not valid json}', 'notifications');
    const count = await rescheduleAllReminders();
    expect(count).toBe(0);
  });

  it('returns 0 when nothing is mirrored', async () => {
    expect(await rescheduleAllReminders()).toBe(0);
  });
});

describe('ensureChannels (5.59)', () => {
  it('is a no-op on iOS without throwing', async () => {
    // The mock react-native sets Platform.OS = 'ios' by default; the
    // channel call short-circuits.
    await expect(ensureChannels()).resolves.toBeUndefined();
  });
});

describe('permissions (5.59)', () => {
  it('requestPushPermission persists "granted" and short-circuits on next call', async () => {
    Mock.__setPermissionResult({ granted: true });
    expect(await requestPushPermission()).toBe('granted');
    expect(await getPersistedPermissionStatus()).toBe('granted');

    // Flip the mock to "denied" and call again — the persisted answer wins.
    Mock.__setPermissionResult({ granted: false, canAskAgain: false });
    expect(await requestPushPermission()).toBe('granted');
  });

  it('requestPushPermission persists "denied" when user blocks (canAskAgain=false)', async () => {
    Mock.__setPermissionResult({ granted: false, canAskAgain: false });
    expect(await requestPushPermission()).toBe('denied');
    expect(await getPersistedPermissionStatus()).toBe('denied');
  });

  it('requestPushPermission returns "undetermined" when user dismissed but can re-prompt', async () => {
    Mock.__setPermissionResult({ granted: false, canAskAgain: true });
    expect(await requestPushPermission()).toBe('undetermined');
  });

  it('forceRequestPushPermission re-prompts even when persisted', async () => {
    Mock.__setPermissionResult({ granted: true });
    await requestPushPermission();
    Mock.__setPermissionResult({ granted: false, canAskAgain: false });
    expect(await forceRequestPushPermission()).toBe('denied');
  });
});

describe('no PII in notification payload', () => {
  it('design invariant: callers control title/body/data — no defaults that leak vault content', () => {
    // This test is a placeholder reminder — the scheduler doesn't add
    // any default content. Producers (reminder fire, approval bridge,
    // etc.) are responsible for keeping payload PII-free.
    expect(true).toBe(true);
  });
});
