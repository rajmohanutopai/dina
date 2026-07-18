/**
 * Watch display DTO + the `WorkflowTask → WatchListItem` mapping (PSVC-4).
 * Shared by the owner `/v1/watch/list` route AND any in-process owner surface
 * (the mobile subscription-management hook) so the shape + rules live in ONE
 * place.
 */

import { parseWatchPollPayload } from './payload';

import type { WorkflowTask } from '../workflow/domain';

/** A watch as shown in the subscription-management surface. */
export interface WatchListItem {
  watch_id: string;
  subscription_id: string;
  persona: string;
  provider_did: string;
  capability: string;
  condition: string | null;
  poll_interval_sec: number;
  /** Poll cadence anchor (SECONDS); null when paused. */
  next_run_at: number | null;
  /** 'active' (scheduled) | 'paused' (no next_run_at). */
  status: 'active' | 'paused';
}

/** Map a `kind='watch'` task to its display item. Returns null for a
 *  foreign/legacy/malformed watch row (never shown). */
export function watchTaskToListItem(task: WorkflowTask): WatchListItem | null {
  const payload = parseWatchPollPayload(task.payload);
  if (payload === null) return null;
  const nextRun = task.next_run_at !== undefined && task.next_run_at !== 0 ? task.next_run_at : null;
  return {
    watch_id: task.id,
    subscription_id: payload.subscription_id,
    persona: payload.persona,
    provider_did: payload.provider_did,
    capability: payload.capability,
    condition: payload.condition ?? null,
    poll_interval_sec: payload.poll_interval_sec,
    next_run_at: nextRun,
    status: nextRun === null ? 'paused' : 'active',
  };
}
