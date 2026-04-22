/**
 * Staging lease heartbeat — extend lease during slow processing.
 *
 * When Brain claims a staging item for classification/enrichment,
 * it gets a 15-minute lease. For slow LLM operations, the heartbeat
 * extends the lease every interval to prevent the sweep from
 * reverting the item to 'received'.
 *
 * Usage:
 *   const hb = startHeartbeat(itemId, 300); // extend by 5 min every 5 min
 *   try { await slowLLMOperation(); } finally { stopHeartbeat(hb); }
 *
 * Source: ARCHITECTURE.md Task 3.17
 */

import { extendLease, getItem } from './service';

export interface Heartbeat {
  id: string;
  itemId: string;
  intervalMs: number;
  extensionSeconds: number;
  timer: ReturnType<typeof setInterval> | null;
  beats: number;
  active: boolean;
}

/** Active heartbeats keyed by heartbeat ID. */
const heartbeats = new Map<string, Heartbeat>();
let heartbeatCounter = 0;

/**
 * Start a lease heartbeat for a staging item.
 *
 * Extends the lease by `extensionSeconds` every `intervalMs`.
 * Returns a heartbeat handle for stopping.
 *
 * @param itemId — the staging item to keep alive
 * @param extensionSeconds — how many seconds to extend per beat (default 300 = 5 min)
 * @param intervalMs — how often to beat (default 300_000 = 5 min)
 */
export function startHeartbeat(
  itemId: string,
  extensionSeconds: number = 300,
  intervalMs: number = 300_000,
): Heartbeat {
  const id = `hb-${++heartbeatCounter}`;

  const heartbeat: Heartbeat = {
    id,
    itemId,
    intervalMs,
    extensionSeconds,
    timer: null,
    beats: 0,
    active: true,
  };

  heartbeat.timer = setInterval(() => {
    if (!heartbeat.active) {
      if (heartbeat.timer) clearInterval(heartbeat.timer);
      return;
    }

    try {
      // Only extend if item is still in 'classifying' state
      const item = getItem(itemId);
      if (item && item.status === 'classifying') {
        extendLease(itemId, extensionSeconds);
        heartbeat.beats++;
      } else {
        // Item no longer classifying — auto-stop
        stopHeartbeat(heartbeat);
      }
    } catch {
      // Item may have been resolved/failed — auto-stop
      stopHeartbeat(heartbeat);
    }
  }, intervalMs);

  heartbeats.set(id, heartbeat);
  return heartbeat;
}

/**
 * Stop a lease heartbeat.
 */
export function stopHeartbeat(heartbeat: Heartbeat): void {
  heartbeat.active = false;
  if (heartbeat.timer) {
    clearInterval(heartbeat.timer);
    heartbeat.timer = null;
  }
  heartbeats.delete(heartbeat.id);
}

/**
 * Manually trigger a single heartbeat (extend lease once).
 * Useful for testing without waiting for the interval.
 */
export function beatOnce(itemId: string, extensionSeconds: number = 300): boolean {
  try {
    const item = getItem(itemId);
    if (item && item.status === 'classifying') {
      extendLease(itemId, extensionSeconds);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Get count of active heartbeats. */
export function activeHeartbeatCount(): number {
  return heartbeats.size;
}

/** Stop all heartbeats (for testing). */
export function stopAllHeartbeats(): void {
  for (const hb of heartbeats.values()) {
    stopHeartbeat(hb);
  }
  heartbeats.clear();
  heartbeatCounter = 0;
}
