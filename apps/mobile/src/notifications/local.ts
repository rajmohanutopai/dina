/**
 * Local notifications — reminder fires → OS push at correct priority.
 *
 * Tasks 5.59 / 5.60 / 5.61 collapsed: install + permission gate +
 * real expo-notifications scheduler + cold-start reschedule.
 *
 * **Priority mapping** (matches `notifications/dnd.ts`):
 *   Tier 1 (fiduciary)  → fiduciary channel: heads-up + sound, IMPORTANCE_HIGH
 *   Tier 2 (solicited)  → solicited channel: notification shade, IMPORTANCE_DEFAULT
 *   Tier 3 (engagement) → engagement channel: bundled in briefing, IMPORTANCE_LOW
 *
 * **State model**:
 *   - The OS scheduler is the source of truth at runtime.
 *   - A SQLite-backed mirror in `kv_store` (namespace `notifications`)
 *     records each schedule's id + payload + triggerAt so a cold start
 *     can re-issue `scheduleNotificationAsync` for any pending entry
 *     whose triggerAt is still in the future. Once a notification has
 *     fired (triggerAt past), the mirror entry can be dropped.
 *   - Why kv_store and not a dedicated table? Per the project decision
 *     to avoid new SQLite migrations for ephemeral surfaces. The
 *     mirror is at most a few dozen pending schedules per device;
 *     kv_store handles that scale comfortably and inherits SQLCipher
 *     encryption transparently.
 *
 * **Permission model**:
 *   - `requestPushPermission()` is called once after first unlock; the
 *     result (granted / denied / undetermined) persists in kv_store
 *     so we don't re-prompt on every launch. Re-prompting only
 *     happens via an explicit settings-screen action.
 *   - When permission is denied, `scheduleNotification` STILL records
 *     in the mirror — the OS just won't fire a banner. The user can
 *     still see the entry on the Notifications screen (5.67).
 *
 * **DND**: this module does NOT consult `notifications/dnd.ts`. DND
 * is a *delivery-time* policy applied by the higher-level fan-in
 * code (the inbox bridges in 5.66 will gate banner fires through it).
 * Scheduling is pure mechanism.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { kvDelete, kvGet, kvList, kvSet } from '@dina/core/kv';

export type NotificationChannel = 'fiduciary' | 'solicited' | 'engagement';

const KV_NAMESPACE = 'notifications';
const PERMISSION_KEY = 'permission_status';

export interface ScheduleInput {
  title: string;
  body: string;
  channel: NotificationChannel;
  triggerAt: number;
  /** Optional caller-supplied id — useful for idempotent rescheduling
   *  (e.g. snooze re-issues with the same id and the OS replaces). */
  id?: string;
  /** Free-form payload threaded into the OS notification's `data`.
   *  The push-tap handler (5.68) reads this to deep-link. */
  data?: Record<string, unknown>;
}

export interface ScheduledNotification {
  id: string;
  title: string;
  body: string;
  channel: NotificationChannel;
  triggerAt: number;
  data?: Record<string, unknown>;
}

/** Persistence shape — what we store in kv_store under `notifications:<id>`. */
interface MirrorEntry {
  id: string;
  title: string;
  body: string;
  channel: NotificationChannel;
  triggerAt: number;
  data?: Record<string, unknown>;
}

/** Map a guardian priority tier to a notification channel. */
export function tierToChannel(tier: 1 | 2 | 3): NotificationChannel {
  switch (tier) {
    case 1:
      return 'fiduciary';
    case 2:
      return 'solicited';
    case 3:
      return 'engagement';
  }
}

// ---------------------------------------------------------------------------
// Channel setup (5.59)
// ---------------------------------------------------------------------------

/**
 * Configure the three Android notification channels. iOS has no
 * concept of channels — this is a no-op there. Idempotent: calling
 * twice doesn't error or duplicate.
 *
 * Call once at boot, after the first unlock (when the user has
 * implicitly consented by reaching that screen — we don't show OS
 * permission UI yet, that's `requestPushPermission`).
 */
export async function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('fiduciary', {
    name: 'Important alerts',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 250, 250, 250],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
  await Notifications.setNotificationChannelAsync('solicited', {
    name: 'Replies & follow-ups',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
  await Notifications.setNotificationChannelAsync('engagement', {
    name: 'Daily briefing items',
    importance: Notifications.AndroidImportance.LOW,
    showBadge: false,
  });
}

// ---------------------------------------------------------------------------
// Permission (5.59)
// ---------------------------------------------------------------------------

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

/**
 * Request OS push permission and persist the user's answer. Returns
 * the resolved status. Subsequent calls are cheap — they read the
 * persisted value rather than re-prompting (callers who want to
 * re-prompt explicitly call `forceRequestPushPermission`).
 *
 * iOS provisional auth is requested so the modal doesn't interrupt
 * onboarding; user can promote to "allow with sound" via Settings or
 * the in-app DND screen.
 */
export async function requestPushPermission(): Promise<PermissionStatus> {
  const persisted = await kvGet(PERMISSION_KEY, KV_NAMESPACE);
  if (persisted === 'granted' || persisted === 'denied') return persisted;
  return forceRequestPushPermission();
}

export async function forceRequestPushPermission(): Promise<PermissionStatus> {
  const result = await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowSound: true,
      allowBadge: true,
      provideAppNotificationSettings: true,
      allowProvisional: true,
    },
  });
  const status: PermissionStatus =
    result.granted === true
      ? 'granted'
      : result.canAskAgain === false
        ? 'denied'
        : 'undetermined';
  await kvSet(PERMISSION_KEY, status, KV_NAMESPACE);
  return status;
}

/** Read the persisted permission status without prompting. */
export async function getPersistedPermissionStatus(): Promise<PermissionStatus> {
  const v = await kvGet(PERMISSION_KEY, KV_NAMESPACE);
  if (v === 'granted' || v === 'denied' || v === 'undetermined') return v;
  return 'undetermined';
}

// ---------------------------------------------------------------------------
// Scheduling (5.60)
// ---------------------------------------------------------------------------

/**
 * Schedule a local notification at a specific absolute time
 * (`triggerAt` ms since epoch).
 *
 * Returns the OS-issued identifier. When the caller passes an `id`,
 * the OS replaces any existing schedule with the same identifier
 * (iOS uses `identifier` for replace semantics; Android matches
 * notification id when re-posted).
 *
 * Mirror semantics: every successful schedule is also written to
 * `kv_store` (namespace `notifications`) so the cold-start reschedule
 * loop (5.61) can re-issue if the OS has been wiped between sessions.
 *
 * If `triggerAt` is already past, we still schedule (OS fires almost
 * immediately) AND mirror — leaves the entry visible to the inbox /
 * Notifications screen, then a subsequent purge removes it.
 */
export async function scheduleNotification(input: ScheduleInput): Promise<string> {
  const id = input.id ?? `notif-${Math.random().toString(36).slice(2, 12)}`;
  const triggerSeconds = Math.max(1, Math.round((input.triggerAt - Date.now()) / 1000));
  const trigger: Notifications.TimeIntervalTriggerInput = {
    type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
    seconds: triggerSeconds,
    channelId: input.channel,
  };
  await Notifications.scheduleNotificationAsync({
    identifier: id,
    content: {
      title: input.title,
      body: input.body,
      data: input.data ?? {},
    },
    trigger,
  });
  const mirror: MirrorEntry = {
    id,
    title: input.title,
    body: input.body,
    channel: input.channel,
    triggerAt: input.triggerAt,
    ...(input.data !== undefined && { data: input.data }),
  };
  await kvSet(id, JSON.stringify(mirror), KV_NAMESPACE);
  return id;
}

/**
 * Cancel a scheduled notification. Idempotent — calling twice or
 * with an unknown id is a no-op.
 */
export async function cancelNotification(notificationId: string): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(notificationId);
  await kvDelete(notificationId, KV_NAMESPACE);
}

/** Cancel everything — settings-screen "clear all" + identity reset. */
export async function cancelAllNotifications(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
  const entries = await kvList(KV_NAMESPACE);
  for (const e of entries) {
    if (e.key === `${KV_NAMESPACE}:${PERMISSION_KEY}`) continue; // keep permission state
    await kvDelete(stripNamespace(e.key), KV_NAMESPACE);
  }
}

// ---------------------------------------------------------------------------
// Cold-start reschedule (5.61)
// ---------------------------------------------------------------------------

/**
 * Walk the kv_store mirror, re-issue any pending entry whose
 * `triggerAt` is still in the future, and drop entries that have
 * already fired (or whose triggerAt is past).
 *
 * Idempotent — the OS uses identifier match, so re-issuing the same
 * id replaces rather than duplicates. Safe to call from multiple
 * boot paths (e.g. unlock + foreground) without coordination.
 *
 * Returns the count of entries re-scheduled (excluding ones dropped
 * because they were already past-due).
 */
export async function rescheduleAllReminders(now: number = Date.now()): Promise<number> {
  const entries = await kvList(KV_NAMESPACE);
  let rescheduled = 0;
  for (const e of entries) {
    if (e.key === `${KV_NAMESPACE}:${PERMISSION_KEY}`) continue;
    const mirror = parseMirror(e.value);
    if (mirror === null) {
      // Malformed entry — drop so it doesn't poison subsequent boots.
      await kvDelete(stripNamespace(e.key), KV_NAMESPACE);
      continue;
    }
    if (mirror.triggerAt <= now) {
      // Past-due. Drop the mirror entry; the OS would have fired (or
      // missed it during downtime). Either way it's no longer pending.
      await kvDelete(mirror.id, KV_NAMESPACE);
      continue;
    }
    // Re-issue with the same identifier; iOS replaces existing.
    const triggerSeconds = Math.max(1, Math.round((mirror.triggerAt - now) / 1000));
    const trigger: Notifications.TimeIntervalTriggerInput = {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: triggerSeconds,
      channelId: mirror.channel,
    };
    await Notifications.scheduleNotificationAsync({
      identifier: mirror.id,
      content: {
        title: mirror.title,
        body: mirror.body,
        data: mirror.data ?? {},
      },
      trigger,
    });
    rescheduled += 1;
  }
  return rescheduled;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Read the in-store mirror — bypasses the OS scheduler. */
export async function getScheduled(): Promise<ScheduledNotification[]> {
  const entries = await kvList(KV_NAMESPACE);
  const out: ScheduledNotification[] = [];
  for (const e of entries) {
    if (e.key === `${KV_NAMESPACE}:${PERMISSION_KEY}`) continue;
    const m = parseMirror(e.value);
    if (m !== null) out.push(m);
  }
  return out.sort((a, b) => a.triggerAt - b.triggerAt);
}

/**
 * Reset the mirror + cancel everything in the OS scheduler. Tests
 * call this in `beforeEach` to start clean.
 */
export async function resetNotifications(): Promise<void> {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {
    /* swallow — mocks may throw if not initialised */
  }
  const entries = await kvList(KV_NAMESPACE);
  for (const e of entries) {
    await kvDelete(stripNamespace(e.key), KV_NAMESPACE);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function parseMirror(value: string): MirrorEntry | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const o = parsed as Partial<MirrorEntry>;
    if (
      typeof o.id !== 'string' ||
      typeof o.title !== 'string' ||
      typeof o.body !== 'string' ||
      typeof o.triggerAt !== 'number' ||
      (o.channel !== 'fiduciary' && o.channel !== 'solicited' && o.channel !== 'engagement')
    ) {
      return null;
    }
    return {
      id: o.id,
      title: o.title,
      body: o.body,
      channel: o.channel,
      triggerAt: o.triggerAt,
      ...(typeof o.data === 'object' && o.data !== null ? { data: o.data } : {}),
    };
  } catch {
    return null;
  }
}

function stripNamespace(key: string): string {
  const prefix = `${KV_NAMESPACE}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}
