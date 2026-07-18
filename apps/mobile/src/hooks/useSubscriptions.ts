/**
 * Subscription-management data hook (PSVC-4) — list poll-mode watches + steer
 * them (pause / resume / cancel).
 *
 * On mobile the whole Home Node runs in-process and the user IS the owner, so
 * this reads the `WatchService` singleton directly (the same pattern the
 * reminders tab uses for the core reminders store) rather than round-tripping
 * through the owner-marked `/v1/watch/*` dispatch. The route + owner boundary
 * exist for out-of-process / server callers; in-process the owner is trusted.
 *
 * A watch is the durable anchor of a standing subscription (PUSH §3.2 / Phase
 * 0): Dina polls the provider on a schedule and surfaces answers through the
 * normal silence tiers. Cancelling ends the subscription.
 */

import { getWatchService, watchTaskToListItem, type WatchListItem } from '@dina/core';

export type SubscriptionUIItem = WatchListItem & {
  /** Human cadence label, e.g. "every 5 min". */
  cadenceLabel: string;
};

function cadenceLabel(sec: number): string {
  if (sec % 3600 === 0) {
    const h = sec / 3600;
    return h === 1 ? 'every hour' : `every ${h} hours`;
  }
  if (sec % 60 === 0) {
    const m = sec / 60;
    return m === 1 ? 'every minute' : `every ${m} min`;
  }
  return `every ${sec}s`;
}

/** The owner's active (running) subscriptions, most-recent first. */
export async function getActiveSubscriptions(): Promise<SubscriptionUIItem[]> {
  const svc = getWatchService();
  if (svc === null) return [];
  const items: SubscriptionUIItem[] = [];
  for (const task of svc.listActive()) {
    const item = watchTaskToListItem(task);
    if (item !== null) items.push({ ...item, cadenceLabel: cadenceLabel(item.poll_interval_sec) });
  }
  return items;
}

/** Pause polling (keeps the subscription; no queries fire until resumed). */
export async function pauseSubscription(watchId: string): Promise<boolean> {
  return getWatchService()?.pause(watchId) ?? false;
}

/** Resume polling on the subscription's cadence. */
export async function resumeSubscription(watchId: string): Promise<boolean> {
  return getWatchService()?.resume(watchId) ?? false;
}

/** Cancel the subscription (terminal — ends the standing watch). */
export async function cancelSubscription(watchId: string): Promise<boolean> {
  return getWatchService()?.cancel(watchId) ?? false;
}
