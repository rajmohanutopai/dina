/**
 * Jitter scheduler — pure helpers for computing jittered next-fire times.
 *
 * Per AWS exponential-backoff-and-jitter paper
 * (https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/),
 * three variants are useful for different stampede-resistance
 * properties:
 *
 *   - **Full jitter**: `delay = random(0, cap)` — maximum variance;
 *     flattens the retry distribution but can produce tiny delays.
 *   - **Equal jitter**: `delay = cap/2 + random(0, cap/2)` — keeps
 *     minimum spacing while still spreading.
 *   - **Decorrelated jitter**: `delay = min(maxCap, random(base,
 *     prev * 3))` — carries state across attempts; converges to a
 *     geometric progression without cliff bursts.
 *
 * This primitive is a PURE helper — each variant is a function that
 * takes `(attempt, opts) → delayMs`, plus an injectable RNG so tests
 * are deterministic. Composes with `http_retry.ts` and any custom
 * scheduler that wants jitter without re-deriving the math.
 *
 * **RNG contract** — `rng()` must return a number in `[0, 1)`.
 * Default uses `Math.random` (non-crypto; fine for jitter).
 */

export type RandomFn = () => number;

export interface JitterOptions {
  /** Base delay before any jitter, in ms. Required. */
  baseMs: number;
  /** Upper cap on the computed delay, in ms. Must be ≥ baseMs. */
  maxCapMs: number;
  /** Multiplier per attempt. Default 2 (exponential). */
  factor?: number;
  /** RNG. Defaults to `Math.random`. */
  rng?: RandomFn;
}

export interface DecorrelatedJitterInput {
  /** Previous computed delay. Pass `baseMs` on the first call. */
  prevMs: number;
  /** Base delay. */
  baseMs: number;
  /** Upper cap on the computed delay. */
  maxCapMs: number;
  /** RNG. */
  rng?: RandomFn;
}

export class JitterSchedulerError extends Error {
  constructor(
    public readonly code: 'invalid_range' | 'invalid_attempt' | 'invalid_factor',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'JitterSchedulerError';
  }
}

/**
 * Full jitter: `delay = random(0, min(cap, base * factor^attempt))`.
 */
export function fullJitter(attempt: number, opts: JitterOptions): number {
  validateOpts(opts, attempt);
  const rng = opts.rng ?? Math.random;
  const ceiling = boundedCeiling(opts, attempt);
  return Math.floor(rng() * ceiling);
}

/**
 * Equal jitter: `delay = c/2 + random(0, c/2)` where
 * `c = min(cap, base * factor^attempt)`.
 */
export function equalJitter(attempt: number, opts: JitterOptions): number {
  validateOpts(opts, attempt);
  const rng = opts.rng ?? Math.random;
  const ceiling = boundedCeiling(opts, attempt);
  const half = Math.floor(ceiling / 2);
  return half + Math.floor(rng() * half);
}

/**
 * Decorrelated jitter: `delay = min(cap, random(base, prev * 3))`.
 * Carries the previous delay forward; initialise with `prevMs = baseMs`.
 */
export function decorrelatedJitter(input: DecorrelatedJitterInput): number {
  if (!input || typeof input !== 'object') {
    throw new JitterSchedulerError('invalid_range', 'input required');
  }
  if (!Number.isFinite(input.baseMs) || input.baseMs <= 0) {
    throw new JitterSchedulerError('invalid_range', 'baseMs must be > 0');
  }
  if (!Number.isFinite(input.maxCapMs) || input.maxCapMs < input.baseMs) {
    throw new JitterSchedulerError('invalid_range', 'maxCapMs must be ≥ baseMs');
  }
  if (!Number.isFinite(input.prevMs) || input.prevMs <= 0) {
    throw new JitterSchedulerError('invalid_range', 'prevMs must be > 0');
  }
  const rng = input.rng ?? Math.random;
  const upper = Math.min(input.maxCapMs, input.prevMs * 3);
  const range = upper - input.baseMs;
  if (range <= 0) return input.baseMs;
  return input.baseMs + Math.floor(rng() * range);
}

// ── Internals ──────────────────────────────────────────────────────────

function validateOpts(opts: JitterOptions, attempt: number): void {
  if (!opts || typeof opts !== 'object') {
    throw new JitterSchedulerError('invalid_range', 'opts required');
  }
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new JitterSchedulerError('invalid_attempt', 'attempt must be non-negative integer');
  }
  if (!Number.isFinite(opts.baseMs) || opts.baseMs <= 0) {
    throw new JitterSchedulerError('invalid_range', 'baseMs must be > 0');
  }
  if (!Number.isFinite(opts.maxCapMs) || opts.maxCapMs < opts.baseMs) {
    throw new JitterSchedulerError('invalid_range', 'maxCapMs must be ≥ baseMs');
  }
  if (opts.factor !== undefined) {
    if (!Number.isFinite(opts.factor) || opts.factor <= 0) {
      throw new JitterSchedulerError('invalid_factor', 'factor must be > 0');
    }
  }
}

function boundedCeiling(opts: JitterOptions, attempt: number): number {
  const factor = opts.factor ?? 2;
  const raw = opts.baseMs * Math.pow(factor, attempt);
  return Math.min(opts.maxCapMs, raw);
}
