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

/** #7 — owner-initiated creation of a poll-mode standing subscription. Mints a
 *  stable `subscription_id` (the idempotency key) and creates the watch through
 *  the owner-only `/v1/watch/create` route. Returns the created watch id, or null
 *  on failure. */
export interface CreateSubscriptionInput {
  persona: string;
  serviceUri: string;
  providerDid: string;
  capability: string;
  pollIntervalSec: number;
  query?: Record<string, unknown>;
  /** R3-06 — the poll TARGET as `key=value` pairs (comma-separated), e.g.
   *  "flight=BA117". Parsed into the `service.query` params so a parameterized watch
   *  polls the right subject. Distinct from the wake `condition`. */
  target?: string;
  /** R2-04 — a wake condition keyword: only notify when a poll result contains it
   *  (case-insensitive). Stored both as the display `condition` and the executable
   *  `filter`. Empty/omitted → notify on every resolved poll. */
  condition?: string;
}

/** Parse a bounded `key=value, key2=value2` target string into a query record.
 *  Ignores malformed pairs; empty → undefined (no params). */
function parseTargetQuery(target: string | undefined): Record<string, unknown> | undefined {
  if (target === undefined || target.trim() === '') return undefined;
  const out: Record<string, string> = {};
  for (const pair of target.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key !== '' && value !== '') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function createSubscription(input: CreateSubscriptionInput): Promise<string | null> {
  const client = getOwnerRunClient();
  if (client === null) return null;
  try {
    const subscriptionId = `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const condition = input.condition !== undefined ? input.condition.trim() : '';
    // R3-06 — the poll target (what to poll) is distinct from the wake filter (when
    // to notify): an explicit `query` wins, else derive it from the `target` string.
    const query = input.query ?? parseTargetQuery(input.target);
    const res = await client.watchCreate({
      subscription_id: subscriptionId,
      persona: input.persona,
      service_uri: input.serviceUri,
      provider_did: input.providerDid,
      capability: input.capability,
      poll_interval_sec: input.pollIntervalSec,
      ...(query !== undefined ? { query } : {}),
      ...(condition !== '' ? { condition, filter: { contains: condition } } : {}),
    });
    return res.watch_id;
  } catch {
    return null;
  }
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
