/**
 * Subscription-management data hook (PSVC-4) — list poll-mode watches + steer
 * them (pause / resume / cancel).
 *
 * Every call goes through the owner-only control client (`getOwnerRunClient`,
 * INTERACTIVE_SERVICES §12.5): an owner-marked `/v1/watch/*` dispatch. It does
 * NOT read the raw `getWatchService()` global directly — that global is reachable
 * by Brain on this same JS VM, so "trusted-in-process" is NOT the owner boundary
 * (§20). The client returns a safe list DTO.
 *
 * A watch is the durable anchor of a standing subscription (PUSH §3.2 / Phase
 * 0): Dina polls the provider on a schedule and surfaces answers through the
 * normal silence tiers. Cancelling ends the subscription.
 */

import { type WatchListItem } from '@dina/core';

import { getOwnerRunClient } from '../services/owner_run_client';

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
  const client = getOwnerRunClient();
  if (client === null) return [];
  try {
    const { watches } = await client.watchList();
    return watches.map((item) => ({ ...item, cadenceLabel: cadenceLabel(item.poll_interval_sec) }));
  } catch {
    return [];
  }
}

/** Pause polling (keeps the subscription; no queries fire until resumed). */
export async function pauseSubscription(watchId: string): Promise<boolean> {
  try {
    return (await getOwnerRunClient()?.watchPause(watchId))?.ok ?? false;
  } catch {
    return false;
  }
}

/** Resume polling on the subscription's cadence. */
export async function resumeSubscription(watchId: string): Promise<boolean> {
  try {
    return (await getOwnerRunClient()?.watchResume(watchId))?.ok ?? false;
  } catch {
    return false;
  }
}

/** Cancel the subscription (terminal — ends the standing watch). */
export async function cancelSubscription(watchId: string): Promise<boolean> {
  try {
    return (await getOwnerRunClient()?.watchCancel(watchId))?.ok ?? false;
  } catch {
    return false;
  }
}
