/**
 * Structural subset of the adapter contracts the conformance cases exercise.
 *
 * Defined LOCALLY (not imported from `@dina/core`) on purpose: the kit stays
 * ZERO-dependency so it loads cleanly in the React Native bundle without
 * dragging in core's full module graph (several core source files import
 * `@dina/test-harness`, which would pollute the kit's typecheck). Each runner
 * passes the REAL adapter — which has this shape plus more — and adds a
 * compile-time drift-guard (`assertExtends<RealDatabaseAdapter, ConformanceDatabaseAdapter>()`)
 * so a contract change in `@dina/core` is caught where the binding happens.
 */

/** The `DatabaseAdapter` surface the storage cases call. Synchronous, per the contract. */
export interface ConformanceDatabaseAdapter {
  execute(sql: string, params?: unknown[]): void;
  query(sql: string, params?: unknown[]): Record<string, unknown>[];
  run(sql: string, params?: unknown[]): number;
  transaction(fn: () => void): void;
  close(): void;
  readonly isOpen: boolean;
}

/**
 * Compile-time drift-guard helper. A runner calls
 * `assertExtends<RealType, KitType>()` so that if the real adapter ever stops
 * satisfying the conformance shape (e.g. `run()` becomes async), the runner
 * fails to compile — the kit's local types can't silently drift from `@dina/core`.
 */
export function assertExtends<_Sub extends _Super, _Super>(): void {
  /* type-level only */
}
