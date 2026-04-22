/**
 * Task 5.56 — Brain background-loop supervisor registry.
 *
 * The brain runs several long-running loops that must survive
 * individual iteration errors + restart with exponential backoff:
 *
 *   - **Guardian loop** (task 5.30) — processes inbound events.
 *   - **Scratchpad refresh** — sweeps expired checkpoints.
 *   - **MsgBox poll** — relays inbound messages.
 *   - **PersonaRegistry refresh** — 60s polling from Core.
 *   - **Service config reload** (task 5.13) — 60s polling.
 *
 * Each loop is wrapped in `SupervisedLoop` (task 4.90) which handles
 * per-iteration error isolation + backoff. This registry is the
 * **top-level coordinator** that owns the fleet:
 *
 *   - **Register / start / stop** individual loops by name.
 *   - `startAll()` / `stopAll()` for boot + graceful shutdown.
 *   - `stats()` returns consolidated counters across every loop.
 *   - **Fail-safe shutdown**: `stopAll()` stops every loop even when
 *     one `stop()` rejects — an errored stop doesn't leave others
 *     running.
 *
 * **Why separate from `SupervisedLoop`**: individual loops need the
 * backoff / iteration semantics (4.90). The registry adds fleet-
 * level orchestration: naming, start-all semantics, fail-safe
 * shutdown, consolidated stats. The two are complementary; a caller
 * can use `SupervisedLoop` without the registry if they only run
 * one background task.
 *
 * **Event stream** surfaces fleet transitions (added, started,
 * stopped, fleet-started, fleet-stopped) so the admin UI can render
 * "Guardian OK for 2h, Scratchpad restarted 3× today".
 *
 * **Registration is separate from startup** — `add()` just records
 * the loop; `startAll()` (or `start(name)`) actually fires it. This
 * avoids fire-and-forget semantics where a start failure during
 * registration would become an unhandled rejection. Boot code
 * registers all loops, then awaits `startAll()`.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5h task 5.56.
 */

/**
 * Minimal interface a registry member satisfies. `SupervisedLoop`
 * satisfies this shape; tests can pass a lightweight stub without
 * pulling in the full loop primitive.
 */
export interface ManagedLoop {
  start(): void | Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export interface BrainLoopRegistryOptions {
  /** Diagnostic hook. */
  onEvent?: (event: BrainLoopRegistryEvent) => void;
}

export type BrainLoopRegistryEvent =
  | { kind: 'added'; name: string }
  | { kind: 'started'; name: string }
  | { kind: 'stopped'; name: string; error?: string }
  | { kind: 'fleet_started'; started: string[]; failed: Array<{ name: string; error: string }> }
  | { kind: 'fleet_stopped'; stopped: string[]; failed: Array<{ name: string; error: string }> };

export interface LoopFleetStats {
  /** Names of loops that `isRunning()` returns true for. */
  running: string[];
  /** Total number of registered loops. */
  total: number;
}

/**
 * Fleet manager for brain background loops. One instance per brain
 * process, constructed during boot + shared with the shutdown
 * coordinator.
 */
export class BrainLoopRegistry {
  private readonly loops: Map<string, ManagedLoop> = new Map();
  private readonly onEvent?: (event: BrainLoopRegistryEvent) => void;

  constructor(opts: BrainLoopRegistryOptions = {}) {
    this.onEvent = opts.onEvent;
  }

  /**
   * Register a loop. Does NOT start it — call `start(name)` or
   * `startAll()` afterward. Throws on duplicate name or malformed
   * loop.
   */
  add(name: string, loop: ManagedLoop): void {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('BrainLoopRegistry: name must be a non-empty string');
    }
    if (
      !loop ||
      typeof loop.start !== 'function' ||
      typeof loop.stop !== 'function' ||
      typeof loop.isRunning !== 'function'
    ) {
      throw new TypeError(
        `BrainLoopRegistry: loop "${name}" must implement { start, stop, isRunning }`,
      );
    }
    if (this.loops.has(name)) {
      throw new Error(`BrainLoopRegistry: loop "${name}" already registered`);
    }
    this.loops.set(name, loop);
    this.onEvent?.({ kind: 'added', name });
  }

  /** True when the given loop is registered. */
  has(name: string): boolean {
    return this.loops.has(name);
  }

  /** Number of registered loops. */
  size(): number {
    return this.loops.size;
  }

  /**
   * Start a specific loop. Returns a promise that resolves when the
   * loop's `start()` returns (or immediately if it returns `void`).
   * Rejects with a descriptive error if the name is unknown or
   * `start()` throws.
   */
  async start(name: string): Promise<void> {
    const loop = this.loops.get(name);
    if (!loop) {
      throw new Error(`BrainLoopRegistry: no loop registered as "${name}"`);
    }
    await Promise.resolve(loop.start());
    this.onEvent?.({ kind: 'started', name });
  }

  /**
   * Stop a specific loop. Rejects with the underlying error if
   * `stop()` throws + emits `stopped` with the error message.
   */
  async stop(name: string): Promise<void> {
    const loop = this.loops.get(name);
    if (!loop) {
      throw new Error(`BrainLoopRegistry: no loop registered as "${name}"`);
    }
    try {
      await loop.stop();
      this.onEvent?.({ kind: 'stopped', name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onEvent?.({ kind: 'stopped', name, error: msg });
      throw err;
    }
  }

  /**
   * Start every registered loop in registration order. Errors on
   * individual loops are collected — one loop failing to start does
   * NOT abort the fleet. Returns a summary.
   */
  async startAll(): Promise<{
    started: string[];
    failed: Array<{ name: string; error: string }>;
  }> {
    const started: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const [name, loop] of this.loops) {
      try {
        await Promise.resolve(loop.start());
        this.onEvent?.({ kind: 'started', name });
        started.push(name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failed.push({ name, error: msg });
      }
    }
    this.onEvent?.({ kind: 'fleet_started', started, failed });
    return { started, failed };
  }

  /**
   * Stop every registered loop — fail-safe. Loops stop in REVERSE
   * registration order so dependents stop before their dependencies
   * (mirrors Unix signal propagation for service trees). An error
   * on one loop's stop is captured + the next loop still runs.
   */
  async stopAll(): Promise<{
    stopped: string[];
    failed: Array<{ name: string; error: string }>;
  }> {
    const stopped: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    const reversed = Array.from(this.loops).reverse();
    for (const [name, loop] of reversed) {
      try {
        await loop.stop();
        this.onEvent?.({ kind: 'stopped', name });
        stopped.push(name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.onEvent?.({ kind: 'stopped', name, error: msg });
        failed.push({ name, error: msg });
      }
    }
    this.onEvent?.({ kind: 'fleet_stopped', stopped, failed });
    return { stopped, failed };
  }

  /** Consolidated fleet stats. */
  stats(): LoopFleetStats {
    const running: string[] = [];
    for (const [name, loop] of this.loops) {
      if (loop.isRunning()) running.push(name);
    }
    return { running, total: this.loops.size };
  }

  /** List every registered loop name in registration order. */
  names(): string[] {
    return Array.from(this.loops.keys());
  }
}
