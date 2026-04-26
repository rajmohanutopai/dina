/**
 * Jest mock for `expo-notifications` (5.59 / 5.60 / 5.61 / 5.68).
 *
 * Implements the surface our `notifications/local.ts` actually uses:
 *   - `setNotificationChannelAsync` — no-op on the mock (channels are
 *     a real OS construct; tests don't need a fake registry).
 *   - `requestPermissionsAsync` — returns a configurable result.
 *     Tests can override via `__setPermissionResult(result)`.
 *   - `scheduleNotificationAsync` — appends to an in-memory map keyed
 *     by identifier. Replaces on duplicate identifier (matches OS).
 *   - `cancelScheduledNotificationAsync` — deletes by identifier.
 *   - `cancelAllScheduledNotificationsAsync` — wipes the map.
 *   - `addNotificationResponseReceivedListener` — installs a listener
 *     into a settable global; `__fireNotificationResponse(payload)`
 *     fires it (used by 5.68 deep-link tests).
 *   - `getLastNotificationResponseAsync` — settable via
 *     `__setLastNotificationResponse(payload)` (cold-start path).
 *
 * Constants:
 *   - `AndroidImportance.HIGH/DEFAULT/LOW` — matches real values.
 *   - `AndroidNotificationVisibility.PUBLIC` — matches real value.
 *   - `SchedulableTriggerInputTypes.TIME_INTERVAL` — string literal.
 *
 * Tests reset state via `__resetNotificationsMock()` in `beforeEach`.
 */

interface ScheduledRecord {
  identifier: string;
  content: { title: string; body: string; data: Record<string, unknown> };
  trigger: { type: string; seconds: number; channelId?: string };
}

type ResponseListener = (response: { notification: { request: { content: { data: Record<string, unknown> } } } }) => void;

let permissionResult: {
  granted: boolean;
  canAskAgain: boolean;
  ios?: { status: number };
} = { granted: true, canAskAgain: true };

const scheduled = new Map<string, ScheduledRecord>();
const responseListeners = new Set<ResponseListener>();
let lastResponse: { notification: { request: { content: { data: Record<string, unknown> } } } } | null = null;

export const AndroidImportance = {
  UNKNOWN: 0,
  UNSPECIFIED: 1,
  NONE: 2,
  MIN: 3,
  LOW: 4,
  DEFAULT: 5,
  HIGH: 6,
  MAX: 7,
} as const;

export const AndroidNotificationVisibility = {
  UNKNOWN: 0,
  PUBLIC: 1,
  PRIVATE: 0,
  SECRET: -1,
} as const;

export const SchedulableTriggerInputTypes = {
  TIME_INTERVAL: 'timeInterval',
  DAILY: 'daily',
  WEEKLY: 'weekly',
  CALENDAR: 'calendar',
  DATE: 'date',
} as const;

export async function setNotificationChannelAsync(
  _channelId: string,
  _channel: unknown,
): Promise<void> {
  /* no-op — channels are an OS-side construct */
}

export async function requestPermissionsAsync(_opts?: unknown): Promise<{
  granted: boolean;
  canAskAgain: boolean;
}> {
  return { granted: permissionResult.granted, canAskAgain: permissionResult.canAskAgain };
}

export async function scheduleNotificationAsync(req: {
  identifier?: string;
  content: { title: string; body: string; data?: Record<string, unknown> };
  trigger: { type: string; seconds: number; channelId?: string };
}): Promise<string> {
  const id = req.identifier ?? `auto-${scheduled.size + 1}`;
  scheduled.set(id, {
    identifier: id,
    content: {
      title: req.content.title,
      body: req.content.body,
      data: req.content.data ?? {},
    },
    trigger: req.trigger,
  });
  return id;
}

export async function cancelScheduledNotificationAsync(id: string): Promise<void> {
  scheduled.delete(id);
}

export async function cancelAllScheduledNotificationsAsync(): Promise<void> {
  scheduled.clear();
}

export async function getAllScheduledNotificationsAsync(): Promise<ScheduledRecord[]> {
  return [...scheduled.values()];
}

export function addNotificationResponseReceivedListener(listener: ResponseListener): {
  remove: () => void;
} {
  responseListeners.add(listener);
  return {
    remove: () => {
      responseListeners.delete(listener);
    },
  };
}

export async function getLastNotificationResponseAsync(): Promise<
  { notification: { request: { content: { data: Record<string, unknown> } } } } | null
> {
  return lastResponse;
}

// ---------------------------------------------------------------------------
// Test helpers — exported with `__` prefix to mark them as mock-only.
// ---------------------------------------------------------------------------

export function __setPermissionResult(result: {
  granted: boolean;
  canAskAgain?: boolean;
}): void {
  permissionResult = {
    granted: result.granted,
    canAskAgain: result.canAskAgain ?? true,
  };
}

export function __setLastNotificationResponse(data: Record<string, unknown> | null): void {
  lastResponse =
    data === null ? null : { notification: { request: { content: { data } } } };
}

export function __fireNotificationResponse(data: Record<string, unknown>): void {
  const response = { notification: { request: { content: { data } } } };
  for (const fn of responseListeners) {
    try {
      fn(response);
    } catch {
      /* swallow */
    }
  }
}

export function __getScheduled(): ScheduledRecord[] {
  return [...scheduled.values()];
}

export function __resetNotificationsMock(): void {
  scheduled.clear();
  responseListeners.clear();
  lastResponse = null;
  permissionResult = { granted: true, canAskAgain: true };
}

// Default export so `import * as Notifications from 'expo-notifications'` works.
export default {
  AndroidImportance,
  AndroidNotificationVisibility,
  SchedulableTriggerInputTypes,
  setNotificationChannelAsync,
  requestPermissionsAsync,
  scheduleNotificationAsync,
  cancelScheduledNotificationAsync,
  cancelAllScheduledNotificationsAsync,
  getAllScheduledNotificationsAsync,
  addNotificationResponseReceivedListener,
  getLastNotificationResponseAsync,
  __setPermissionResult,
  __setLastNotificationResponse,
  __fireNotificationResponse,
  __getScheduled,
  __resetNotificationsMock,
};
