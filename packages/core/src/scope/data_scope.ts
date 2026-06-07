/**
 * Data scope — the container a row belongs to, distinct from `source`
 * (provenance: manual / d2d / reminder_planner / service_response / …). The
 * normal scope is `'user'`; the first-run guided demo runs in an isolated
 * `'guided_demo:<run_id>'` scope so its data is perfectly removable without a
 * separate account, separate personas, or prompt hacks.
 *
 * V1 uses a SINGLETON runtime scope: the mobile app is local, single-user, and
 * the guided demo is exclusive while active, so a process-global "current
 * scope" is sound. Repositories default reads/writes to `currentDataScope()`.
 * Server / multi-actor paths should pass scope explicitly rather than relying
 * on this global (see the design doc's "Global Runtime Scope" risk).
 *
 * Source: docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md
 */

export type DataScope = 'user' | `guided_demo:${string}`;

/** The normal, permanent data scope. */
export const USER_SCOPE: DataScope = 'user';

/**
 * Valid `guided_demo:` run-id charset — URL/file-safe and, crucially, free of
 * `:` (the scope delimiter) so a scope string round-trips unambiguously.
 */
const GUIDED_DEMO_RE = /^guided_demo:[A-Za-z0-9_-]+$/;

/** True for any `guided_demo:<run_id>` scope. */
export function isGuidedDemoScope(scope: DataScope): boolean {
  return scope !== USER_SCOPE && scope.startsWith('guided_demo:');
}

/**
 * Runtime validator + type guard. Used at every boundary that accepts a scope
 * string (setter, factory output, persisted-state hydration) because a
 * malformed scope silently breaks isolation — better to fail loud.
 */
export function isValidDataScope(scope: string): scope is DataScope {
  return scope === USER_SCOPE || GUIDED_DEMO_RE.test(scope);
}

// ── run-id factory (injectable so tests are deterministic) ─────────────────

function defaultRunId(): string {
  // 12 hex chars from two draws. The run id is NOT a secret (it never gates
  // access — the scope only partitions local rows), so cryptographic
  // randomness isn't required; uniqueness across one local demo run is.
  const hi = Math.floor(Math.random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, '0');
  const lo = Math.floor(Math.random() * 0x1_0000)
    .toString(16)
    .padStart(4, '0');
  return `${hi}${lo}`;
}

let runIdFactory: () => string = defaultRunId;

/** Override the run-id factory (deterministic tests). */
export function setGuidedDemoIdFactory(fn: () => string): void {
  runIdFactory = fn;
}

/** Restore the default run-id factory. */
export function resetGuidedDemoIdFactory(): void {
  runIdFactory = defaultRunId;
}

/** Mint a fresh `guided_demo:<run_id>` scope. */
export function newGuidedDemoScope(): DataScope {
  const id = runIdFactory();
  const scope = `guided_demo:${id}` as const;
  // A bad factory must not produce a scope that fails validation — that would
  // silently isolate to a garbage container downstream.
  if (!isValidDataScope(scope)) {
    throw new Error(`scope: id factory produced an invalid run id "${id}"`);
  }
  return scope;
}

// ── singleton runtime scope ────────────────────────────────────────────────

let current: DataScope = USER_SCOPE;

/** The scope repositories default their reads/writes to. */
export function currentDataScope(): DataScope {
  return current;
}

/** Set the process-global current scope. Rejects malformed scopes. */
export function setCurrentDataScope(scope: DataScope): void {
  if (!isValidDataScope(scope)) {
    throw new Error(`scope: invalid data scope "${String(scope)}"`);
  }
  current = scope;
}

/**
 * Run a SYNCHRONOUS function with `scope` active, restoring the prior scope
 * afterward (even on throw). For the guided demo's long-lived async work, use
 * the persistent `setCurrentDataScope` instead — the demo holds one scope for
 * its whole run, so async remember/ask/reminder ops inherit it.
 */
export function runInDataScope<T>(scope: DataScope, fn: () => T): T {
  const prev = current;
  setCurrentDataScope(scope);
  try {
    return fn();
  } finally {
    current = prev;
  }
}

/** Reset to the default `'user'` scope (teardown / tests). */
export function resetDataScope(): void {
  current = USER_SCOPE;
}
