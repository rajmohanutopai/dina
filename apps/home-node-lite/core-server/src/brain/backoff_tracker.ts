/**
 * Backoff tracker — stateful per-key failure counter + next-delay
 * computation.
 *
 * Distinct from `http_retry.ts` (stateless wrapper around a single
 * call) and `jitter_scheduler.ts` (pure math). This primitive holds
 * STATE across calls:
 *
 *   recordFailure(key)   → increments fail count, returns next delay.
 *   recordSuccess(key)   → resets the counter.
 *   nextDelayMs(key)     → peek at current next delay (0 when fresh).
 *   failureCount(key)    → inspect current count.
 *
 * **Useful for**: long-lived RPC clients that want to track per-target
 * backoff state — e.g. "this AppView endpoint has failed 3 times in
 * a row; back off to 2s before retrying." Complements `http_retry.ts`
 * which is per-call.
 *
 * **Exponential base × factor^attempt, capped**:
 *
 *   delay = min(maxCap, base * factor^(attempt - 1))
 *
 * Optionally jittered via an injected RNG (default: full-jitter).
 *
 * **Cooldown recovery**: `onCooldownMs?` — after this many ms with
 * no failures the counter auto-resets on the next call. Models "the
 * service was flaky but it's been quiet; don't punish the next
 * request forever."
 *
 * **Max attempts**: `nextDelayMs` returns `null` when the key has
 * exceeded `maxAttempts` (circuit-breaker style). Caller interprets
 * `null` as "stop trying".
 *
 * **Inject the clock** for deterministic tests. No timers.
 */

export interface BackoffTrackerOptions {
  /** Base delay after first failure. Default 500ms. */
  baseMs?: number;
  /** Multiplier per attempt. Default 2 (exponential). */
  factor?: number;
  /** Cap on computed delay. Default 60s. */
  maxCapMs?: number;
  /** After this many ms with no failures, auto-reset. null disables. Default null. */
  onCooldownMs?: number | null;
  /** Max attempts before nextDelayMs returns null. null = unlimited. Default null. */
  maxAttempts?: number | null;
  /** RNG for jitter in [0, 1). Default Math.random. */
  rng?: () => number;
  /** Clock. Default Date.now. */
  nowMsFn?: () => number;
  /** Enable full-jitter on the computed delay. Default false. */
  jitter?: boolean;
}

export interface BackoffSnapshot {
  key: string;
  failures: number;
  nextDelayMs: number | null;
  lastFailureAtMs: number | null;
}

export const DEFAULT_BACKOFF_BASE_MS = 500;
export const DEFAULT_BACKOFF_FACTOR = 2;
export const DEFAULT_BACKOFF_MAX_CAP_MS = 60_000;

interface Entry {
  failures: number;
  lastFailureAtMs: number;
}

export class BackoffTracker {
  private readonly baseMs: number;
  private readonly factor: number;
  private readonly maxCapMs: number;
  private readonly onCooldownMs: number | null;
  private readonly maxAttempts: number | null;
  private readonly rng: () => number;
  private readonly nowMsFn: () => number;
  private readonly jitterEnabled: boolean;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: BackoffTrackerOptions = {}) {
    this.baseMs = opts.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
    if (!Number.isFinite(this.baseMs) || this.baseMs <= 0) {
      throw new RangeError('baseMs must be > 0');
    }
    this.factor = opts.factor ?? DEFAULT_BACKOFF_FACTOR;
    if (!Number.isFinite(this.factor) || this.factor <= 0) {
      throw new RangeError('factor must be > 0');
    }
    this.maxCapMs = opts.maxCapMs ?? DEFAULT_BACKOFF_MAX_CAP_MS;
    if (!Number.isFinite(this.maxCapMs) || this.maxCapMs < this.baseMs) {
      throw new RangeError('maxCapMs must be ≥ baseMs');
    }
    this.onCooldownMs = opts.onCooldownMs ?? null;
    if (this.onCooldownMs !== null && (!Number.isFinite(this.onCooldownMs) || this.onCooldownMs <= 0)) {
      throw new RangeError('onCooldownMs must be > 0 or null');
    }
    this.maxAttempts = opts.maxAttempts ?? null;
    if (this.maxAttempts !== null && (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1)) {
      throw new RangeError('maxAttempts must be a positive integer or null');
    }
    this.rng = opts.rng ?? Math.random;
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.jitterEnabled = opts.jitter === true;
  }

  /** Keys currently tracked. */
  size(): number {
    return this.entries.size;
  }

  failureCount(key: string): number {
    this.maybeCooldown(key);
    return this.entries.get(key)?.failures ?? 0;
  }

  /**
   * Record a failure for `key`. Returns the backoff delay for the
   * NEXT attempt, or `null` if `maxAttempts` reached.
   */
  recordFailure(key: string): number | null {
    if (typeof key !== 'string' || key === '') {
      throw new TypeError('recordFailure: key must be non-empty string');
    }
    this.maybeCooldown(key);
    const existing = this.entries.get(key);
    const failures = (existing?.failures ?? 0) + 1;
    const now = this.nowMsFn();
    this.entries.set(key, { failures, lastFailureAtMs: now });
    return this.delayFor(failures);
  }

  /** Reset the failure counter. Returns true if an entry was cleared. */
  recordSuccess(key: string): boolean {
    if (typeof key !== 'string' || key === '') {
      throw new TypeError('recordSuccess: key must be non-empty string');
    }
    return this.entries.delete(key);
  }

  /**
   * Peek at the NEXT attempt's delay WITHOUT recording a failure.
   * Returns 0 for fresh keys (no backoff yet), null when past
   * maxAttempts.
   */
  nextDelayMs(key: string): number | null {
    this.maybeCooldown(key);
    const failures = this.entries.get(key)?.failures ?? 0;
    if (failures === 0) return 0;
    return this.delayFor(failures);
  }

  /** Snapshot one key's state. */
  snapshot(key: string): BackoffSnapshot {
    this.maybeCooldown(key);
    const entry = this.entries.get(key);
    return {
      key,
      failures: entry?.failures ?? 0,
      nextDelayMs: this.nextDelayMs(key),
      lastFailureAtMs: entry?.lastFailureAtMs ?? null,
    };
  }

  /** Drop every tracked key. */
  clear(): void {
    this.entries.clear();
  }

  // ── Internals ────────────────────────────────────────────────────────

  private delayFor(failures: number): number | null {
    if (this.maxAttempts !== null && failures > this.maxAttempts) return null;
    const raw = this.baseMs * Math.pow(this.factor, failures - 1);
    let delay = Math.min(this.maxCapMs, raw);
    if (this.jitterEnabled) {
      delay = Math.floor(this.rng() * delay);
    }
    return Math.max(0, Math.floor(delay));
  }

  private maybeCooldown(key: string): void {
    if (this.onCooldownMs === null) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    if (this.nowMsFn() - entry.lastFailureAtMs >= this.onCooldownMs) {
      this.entries.delete(key);
    }
  }
}
