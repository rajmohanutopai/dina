/**
 * Runtime warnings channel — post-boot, asynchronous warnings the UI
 * should surface after the initial boot banner has settled.
 *
 * Review #15: `createNode` accepts `onPublishSyncFailure` so an async
 * ServicePublisher sync failure (e.g., PDS 503 after a config change)
 * can be reported, but the shipped bootstrap path never wired it to
 * anything user-visible. This module is the seam: bootstrap pushes
 * warnings in; the layout banner hook pulls them out via
 * `useRuntimeWarnings()`.
 *
 * Distinct from `BootDegradation` because:
 *   - degradations are static: gathered at boot, never change later.
 *   - runtime warnings are dynamic: accumulate + clear over time as
 *     the node retries background sync work.
 */

export interface RuntimeWarning {
  /** Stable tag — used for dedupe + copy/paste into bug reports. */
  code: string;
  /** Operator-facing message. */
  message: string;
  /** When the warning was recorded (ms since epoch). */
  at: number;
}

const warnings: RuntimeWarning[] = [];
const listeners = new Set<() => void>();

// Cached immutable snapshot consumed by `useSyncExternalStore`. Returning
// `warnings.slice()` on every call would create a new array reference even
// when nothing changed, triggering an infinite render loop in React.
// Rebuild this only when the list actually mutates.
let snapshot: readonly RuntimeWarning[] = [];

function refreshSnapshot(): void {
  snapshot = warnings.slice();
}

function notify(): void {
  refreshSnapshot();
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* swallow — subscriber bug can't break emit */
    }
  }
}

/**
 * Emit a warning. Deduped by `code`: if the same code is already in
 * the list we update its message + `at` instead of growing the list.
 */
export function emitRuntimeWarning(code: string, message: string): void {
  const existing = warnings.find((w) => w.code === code);
  if (existing !== undefined) {
    existing.message = message;
    existing.at = Date.now();
  } else {
    warnings.push({ code, message, at: Date.now() });
  }
  notify();
}

/** Clear a specific warning (used by successful retries) or all. */
export function clearRuntimeWarning(code?: string): void {
  if (code === undefined) {
    warnings.length = 0;
  } else {
    const i = warnings.findIndex((w) => w.code === code);
    if (i >= 0) warnings.splice(i, 1);
  }
  notify();
}

export function getRuntimeWarnings(): readonly RuntimeWarning[] {
  return snapshot;
}

export function subscribeRuntimeWarnings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reset for tests. */
export function resetRuntimeWarningsForTest(): void {
  warnings.length = 0;
  snapshot = [];
  listeners.clear();
}
