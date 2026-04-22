/**
 * Two named `QueryWindow` singletons used by the D2D send / receive paths
 * for public-service contact-gate bypass.
 *
 *   providerWindow    — opened when we accept an inbound `service.query` from
 *                       a stranger; consumed by our outbound `service.response`.
 *   requesterWindow   — opened when we send a `service.query` to a public
 *                       service; consumed by the matching inbound
 *                       `service.response`.
 *
 * Exposing named module-level instances (not a context-injected object) keeps
 * the D2D callsites short — callers don't need to thread a window pair into
 * every send/receive helper. `resetServiceWindows()` is available for tests.
 *
 * Source:
 *   core/cmd/dina-core/main.go — `providerQueryWindow` / `requesterQueryWindow`
 *   core/internal/service/query_window.go — constructor parity
 */

import { QueryWindow } from './query_window';

let _providerWindow: QueryWindow | null = null;
let _requesterWindow: QueryWindow | null = null;
let _cleanupDisposers: Array<() => void> = [];

/** Default sweeper interval when `startServiceWindowCleanup` is called. */
export const DEFAULT_WINDOW_CLEANUP_INTERVAL_MS = 30_000;

/**
 * Return the provider-side window (for outbound `service.response` egress).
 * Instantiated lazily on first call.
 */
export function providerWindow(): QueryWindow {
  if (_providerWindow === null) {
    _providerWindow = new QueryWindow();
  }
  return _providerWindow;
}

/**
 * Return the requester-side window (for inbound `service.response` ingress).
 * Instantiated lazily on first call.
 */
export function requesterWindow(): QueryWindow {
  if (_requesterWindow === null) {
    _requesterWindow = new QueryWindow();
  }
  return _requesterWindow;
}

/**
 * Start periodic expiry cleanup on both windows. Returns a single disposer
 * that stops both sweepers. Safe to call multiple times — each call returns
 * its own disposer; the underlying timers are idempotent (see QueryWindow).
 */
export function startServiceWindowCleanup(
  intervalMs: number = DEFAULT_WINDOW_CLEANUP_INTERVAL_MS,
): () => void {
  const dProv = providerWindow().startCleanupLoop(intervalMs);
  const dReq = requesterWindow().startCleanupLoop(intervalMs);
  const combined = () => {
    dProv();
    dReq();
  };
  _cleanupDisposers.push(combined);
  return combined;
}

/** Stop any cleanup loops started via `startServiceWindowCleanup`. */
export function stopServiceWindowCleanup(): void {
  for (const d of _cleanupDisposers) {
    d();
  }
  _cleanupDisposers = [];
}

// ---------------------------------------------------------------------------
// Thin named wrappers over the underlying window methods. These exist because
// several call sites only need to read/write ONE window — giving them a named
// API (`setProviderWindow`, `releaseProviderWindow`, …) is clearer than
// reaching through `providerWindow().reserve(…)`.
// ---------------------------------------------------------------------------

/**
 * Open the provider-side reply window. Called when Core accepts an inbound
 * `service.query` from a non-contact. `ttlSeconds` matches the query's TTL.
 */
export function setProviderWindow(
  peerDID: string,
  queryID: string,
  capability: string,
  ttlSeconds: number,
): void {
  providerWindow().open(peerDID, queryID, capability, ttlSeconds * 1000);
}

/**
 * Close the provider-side window without sending. Used when the send
 * pipeline fails after reservation but before enqueue — the entry returns
 * to the "available" state for retry.
 */
export function releaseProviderWindow(peerDID: string, queryID: string, capability: string): void {
  providerWindow().release(peerDID, queryID, capability);
}

/**
 * Open the requester-side response window. Called when Core sends a
 * `service.query` to a public service. The window authorises exactly one
 * inbound `service.response` matching the triple.
 */
export function setRequesterWindow(
  peerDID: string,
  queryID: string,
  capability: string,
  ttlSeconds: number,
): void {
  requesterWindow().open(peerDID, queryID, capability, ttlSeconds * 1000);
}

// ---------------------------------------------------------------------------
// Test-only utilities
// ---------------------------------------------------------------------------

/**
 * Reset both singletons — clears all window entries and stops any active
 * cleanup loops. Tests must call this in `beforeEach` to avoid cross-test
 * state leakage through the module-level windows.
 */
export function resetServiceWindows(): void {
  stopServiceWindowCleanup();
  _providerWindow?.stopCleanupLoop();
  _requesterWindow?.stopCleanupLoop();
  _providerWindow = null;
  _requesterWindow = null;
}
