/**
 * Task 4.71 — auto-lock TTL for sensitive personas.
 *
 * Per the 4-tier gatekeeper model (default / standard / sensitive /
 * locked), **sensitive** personas auto-lock after a configurable
 * idle timeout — so if the operator unlocks `/health` to let Brain
 * answer a question + walks away, the persona locks itself rather
 * than sitting unlocked indefinitely.
 *
 * **Model**:
 *   - Each unlocked sensitive persona has a deadline.
 *   - Any activity on that persona (query, write, unlock) pushes
 *     the deadline forward by `ttlMs`.
 *   - A scheduler fires `lockFn(personaName)` when the deadline
 *     passes with no activity.
 *   - `lock(personaName)` cancels any pending timer + removes the
 *     entry — explicit lock short-circuits auto-lock.
 *
 * **Why not rely on a global ticker**: per-persona timers are
 * O(unlocked sensitive personas) which is typically <10, and each
 * gets exact semantics (exactly-once lock at the right moment).
 * A single global ticker would either under-precision the deadline
 * (fire on nearest tick) or add bookkeeping (priority queue) for
 * no payoff at this scale.
 *
 * **Default TTL**: 15 minutes — long enough for an operator to
 * complete a single task, short enough that an abandoned terminal
 * doesn't expose the vault indefinitely. Override per-persona via
 * `unlock({ttlMs})`.
 *
 * **Injectable timer + clock** for deterministic tests.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4i task 4.71.
 */

export const DEFAULT_AUTO_LOCK_TTL_MS = 15 * 60 * 1000;

export interface AutoLockOptions {
  /**
   * Called by the scheduler when a persona's idle deadline passes.
   * Consumer wires this to the gatekeeper's `lock(persona)` API.
   * Must NOT throw — if it does, the error is swallowed (logged via
   * `onEvent` if provided) so one misbehaving persona doesn't break
   * the scheduler for the others.
   */
  lockFn: (personaName: string) => void;
  /** Default TTL when `unlock` is called without an explicit `ttlMs`. */
  defaultTtlMs?: number;
  /** Injectable clock (ms). Default `Date.now`. */
  nowMsFn?: () => number;
  /**
   * Injectable timer scheduler. Default uses `setTimeout`/
   * `clearTimeout`. The returned handle is opaque; callers pass it
   * verbatim to `clearTimer`.
   */
  setTimerFn?: (fn: () => void, ms: number) => unknown;
  clearTimerFn?: (handle: unknown) => void;
  /** Diagnostic hook. */
  onEvent?: (event: AutoLockEvent) => void;
}

export type AutoLockEvent =
  | { kind: 'unlock'; persona: string; deadlineMs: number }
  | { kind: 'touch'; persona: string; deadlineMs: number }
  | { kind: 'lock_explicit'; persona: string }
  | { kind: 'lock_timeout'; persona: string }
  | { kind: 'lock_fn_threw'; persona: string; error: string };

interface Entry {
  deadlineMs: number;
  timer: unknown;
  /** The TTL used by the most recent unlock — remembered so `touch`
   *  without an explicit ttlMs extends the deadline by the SAME
   *  amount as the original unlock rather than reverting to the
   *  registry's defaultTtlMs. */
  lastTtlMs: number;
}

/**
 * Per-process registry of sensitive personas that are currently
 * unlocked + their auto-lock deadlines.
 */
export class AutoLockRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly lockFn: (persona: string) => void;
  private readonly defaultTtlMs: number;
  private readonly nowMsFn: () => number;
  private readonly setTimerFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimerFn: (handle: unknown) => void;
  private readonly onEvent?: (event: AutoLockEvent) => void;

  constructor(opts: AutoLockOptions) {
    if (typeof opts.lockFn !== 'function') {
      throw new Error('AutoLockRegistry: lockFn is required');
    }
    this.lockFn = opts.lockFn;
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_AUTO_LOCK_TTL_MS;
    if (!Number.isFinite(this.defaultTtlMs) || this.defaultTtlMs <= 0) {
      throw new Error(
        `AutoLockRegistry: defaultTtlMs must be > 0 (got ${this.defaultTtlMs})`,
      );
    }
    this.nowMsFn = opts.nowMsFn ?? Date.now;
    this.setTimerFn = opts.setTimerFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimerFn =
      opts.clearTimerFn ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.onEvent = opts.onEvent;
  }

  /**
   * Mark a persona as unlocked + schedule its auto-lock. If the
   * persona was already unlocked, the previous timer is cleared +
   * a fresh deadline set.
   */
  unlock(persona: string, opts: { ttlMs?: number } = {}): void {
    if (!persona) throw new Error('AutoLockRegistry.unlock: persona is required');
    const ttlMs = opts.ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`AutoLockRegistry.unlock: ttlMs must be > 0 (got ${ttlMs})`);
    }
    this.clearExisting(persona);
    const deadlineMs = this.nowMsFn() + ttlMs;
    const timer = this.setTimerFn(() => this.fireTimeout(persona), ttlMs);
    this.entries.set(persona, { deadlineMs, timer, lastTtlMs: ttlMs });
    this.onEvent?.({ kind: 'unlock', persona, deadlineMs });
  }

  /**
   * Record activity on a persona — resets the deadline to now + ttl.
   * No-op when the persona isn't currently unlocked (the persona may
   * already have been locked by timeout or explicit call).
   *
   * When `ttlMs` is omitted, inherits the prior entry's TTL (NOT the
   * registry's defaultTtlMs) — touch should extend by the SAME amount
   * as the original unlock, so a /health unlocked with 10s stays on
   * a 10s rolling window.
   */
  touch(persona: string, opts: { ttlMs?: number } = {}): void {
    const existing = this.entries.get(persona);
    if (existing === undefined) return;
    const ttlMs = opts.ttlMs ?? existing.lastTtlMs;
    this.unlock(persona, { ttlMs });
    // unlock emits its own 'unlock' event; override the kind to 'touch'
    // by re-dispatching so consumers can distinguish fresh unlocks
    // from activity-driven deadline bumps.
    const entry = this.entries.get(persona)!;
    this.onEvent?.({ kind: 'touch', persona, deadlineMs: entry.deadlineMs });
  }

  /** Explicit lock — cancel the timer + drop the entry. */
  lock(persona: string): void {
    if (!this.entries.has(persona)) return;
    this.clearExisting(persona);
    this.entries.delete(persona);
    this.onEvent?.({ kind: 'lock_explicit', persona });
  }

  /** True iff the persona is currently unlocked + has a live deadline. */
  isUnlocked(persona: string): boolean {
    const entry = this.entries.get(persona);
    if (entry === undefined) return false;
    return entry.deadlineMs > this.nowMsFn();
  }

  /** Deadline in ms-since-epoch for the given persona; null when not unlocked. */
  deadline(persona: string): number | null {
    return this.entries.get(persona)?.deadlineMs ?? null;
  }

  /** Count of currently-unlocked sensitive personas. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Lock ALL in-flight personas — called on graceful shutdown (task
   * 4.9) so the next boot starts with a clean vault.
   */
  lockAll(): number {
    const names = Array.from(this.entries.keys());
    for (const name of names) this.lock(name);
    return names.length;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private clearExisting(persona: string): void {
    const existing = this.entries.get(persona);
    if (existing === undefined) return;
    this.clearTimerFn(existing.timer);
  }

  private fireTimeout(persona: string): void {
    if (!this.entries.has(persona)) return; // raced with explicit lock
    this.entries.delete(persona);
    try {
      this.lockFn(persona);
      this.onEvent?.({ kind: 'lock_timeout', persona });
    } catch (err) {
      this.onEvent?.({
        kind: 'lock_fn_threw',
        persona,
        error: (err as Error).message,
      });
    }
  }
}
