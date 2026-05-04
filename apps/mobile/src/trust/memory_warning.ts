/**
 * Trust-cache memory-warning hook (TN-MOB-006).
 *
 * Subscribes to React Native's `AppState.memoryWarning` event and
 * evicts the in-memory trust cache down to `MEMORY_WARNING_TARGET`
 * entries when the OS signals pressure. The eviction itself lives
 * in `@dina/core.evictTrustCacheTo()` — this file
 * just owns the platform glue.
 *
 * Notes on platform behaviour:
 *   - iOS fires `memoryWarning` reliably under pressure.
 *   - Android: React Native bridges Android's
 *     `onLowMemory` / `onTrimMemory` to the same event name, but
 *     trim-level filtering happens upstream.
 *   - Web / test runtimes: the event simply never fires, which is
 *     the right no-op behaviour.
 *
 * Caller wires this once at boot and disposes via the returned
 * `remove()` (e.g. on logout / persona switch).
 */

import { AppState } from 'react-native';
import { evictTrustCacheTo, MEMORY_WARNING_TARGET } from '@dina/core';

/** What `AppState.addEventListener` returns — a tiny disposable. */
export interface MemoryWarningSubscription {
  remove(): void;
}

/**
 * Subscribe to memory-warning events and shrink the trust cache
 * down to `MEMORY_WARNING_TARGET` whenever one fires.
 *
 * Returns the subscription so the caller can unsubscribe. Re-
 * registration is safe — each subscription is independent and
 * `evictTrustCacheTo` is idempotent.
 */
export function registerTrustCacheMemoryWarning(): MemoryWarningSubscription {
  // The cast keeps us compatible with the older RN typings shipped
  // by the mocks. Real RN treats 'memoryWarning' as a first-class
  // event type; the mock surfaces it as a generic listener slot.
  const sub = AppState.addEventListener(
    'memoryWarning' as unknown as 'change',
    () => {
      // Fire-and-forget — the eviction is async (KV deletes) but the
      // OS doesn't wait for our promise. Catching is defensive: if
      // KV is mid-flush and rejects, we don't want a runaway
      // unhandled-rejection log on a routine memory event.
      void evictTrustCacheTo(MEMORY_WARNING_TARGET).catch(() => {
        /* swallow — next event will retry */
      });
    },
  );
  return sub as unknown as MemoryWarningSubscription;
}
