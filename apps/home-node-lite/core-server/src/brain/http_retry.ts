/**
 * Task 5.11 — retry with exponential backoff for outbound HTTP.
 *
 * Brain's signed-HTTP client (task 5.9) needs to retry transient
 * failures (Core restarting mid-boot, network blip, LLM provider 503)
 * without hammering. This module provides the retry wrapper.
 *
 * **Design vs `ReconnectPolicy` (task 4.44)**: both compute
 * exponential backoff, but 4.44 tracks reconnect-attempt state for
 * a single WebSocket session whereas this is a per-CALL retry wrapper
 * around an async fetch. Different lifecycle, different semantics:
 *
 *   ReconnectPolicy — stateful class, attempt counter survives
 *     across disconnects, `recordSuccess()` resets.
 *   retryWithBackoff — stateless function wrapper, attempt counter
 *     lives on the stack, each call is independent.
 *
 * **What counts as retryable**: the caller supplies an
 * `isRetryable` predicate; without it, the defaults are:
 *   - Network errors (fetch throws, ECONNREFUSED, ETIMEDOUT).
 *   - HTTP 5xx responses (server error; presumed transient).
 *   - HTTP 429 (rate-limited; respect retry-after if present).
 *   - HTTP 408 (request timeout, rare but valid).
 *
 * 4xx (other than 429 / 408) are NOT retryable — those are caller
 * bugs that won't self-resolve.
 *
 * **Retry-After header support**: when the response carries
 * `Retry-After` (seconds or HTTP-date), we honour it instead of the
 * computed backoff. Provider rate-limit UX demands this.
 *
 * **Idempotency**: this wrapper assumes the call is idempotent —
 * matches Brain's usage (every signed request carries a nonce, so
 * Core de-dupes via its replay-guard). Callers that need strict
 * exactly-once semantics (e.g. a non-idempotent POST to a third-party
 * API) must NOT use this wrapper.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5a task 5.11.
 */

export interface RetryOptions {
  /** Max total attempts (first call + retries). Default 4. */
  maxAttempts?: number;
  /** Initial backoff (ms). Default 500. */
  initialBackoffMs?: number;
  /** Max single-interval backoff (ms). Default 30_000. */
  maxBackoffMs?: number;
  /** Backoff multiplier. Default 2. */
  backoffFactor?: number;
  /**
   * Jitter fraction (0..1). Default 0.1. Final delay is in the range
   * `[base * (1 - jitter), base * (1 + jitter)]` — spreads retry
   * storms across synchronised clients.
   */
  jitter?: number;
  /** Predicate on the caught error / response. Default retries 5xx / 429 / 408 / network errors. */
  isRetryable?: (errorOrResponse: unknown) => boolean;
  /** Injected `setTimeout`. Default `global.setTimeout`. Tests pass a mock scheduler. */
  setTimerFn?: (fn: () => void, ms: number) => unknown;
  /** Injected `clearTimeout` — paired with `setTimerFn`. */
  clearTimerFn?: (handle: unknown) => void;
  /** Injected random source (0..1) for jitter — deterministic tests pass `() => 0.5`. */
  randomFn?: () => number;
  /** Diagnostic hook — fires on each retry decision. */
  onEvent?: (event: RetryEvent) => void;
  /** AbortSignal — if the caller aborts, retry halts immediately with the abort reason. */
  signal?: AbortSignal;
}

export type RetryEvent =
  | { kind: 'attempt_failed'; attempt: number; reason: string; willRetry: boolean; nextDelayMs?: number }
  | { kind: 'succeeded'; attempt: number }
  | { kind: 'exhausted'; attempt: number; reason: string }
  | { kind: 'aborted'; attempt: number };

export const DEFAULT_MAX_ATTEMPTS = 4;
export const DEFAULT_INITIAL_BACKOFF_MS = 500;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;
export const DEFAULT_BACKOFF_FACTOR = 2;
export const DEFAULT_JITTER = 0.1;

/**
 * Wrap an async `call` with retry. `call(attempt)` receives the
 * current 0-indexed attempt for logging; its return value is the
 * result type. Throws the final error after exhausting attempts.
 */
export async function retryWithBackoff<T>(
  call: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const backoffFactor = opts.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  const jitter = opts.jitter ?? DEFAULT_JITTER;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const setTimerFn = opts.setTimerFn ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimerFn = opts.clearTimerFn ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>));
  const randomFn = opts.randomFn ?? Math.random;
  const onEvent = opts.onEvent;
  const signal = opts.signal;

  validateOptions({ maxAttempts, initialBackoffMs, maxBackoffMs, backoffFactor, jitter });

  if (signal?.aborted) {
    onEvent?.({ kind: 'aborted', attempt: 0 });
    throw signalAbortError(signal);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await call(attempt);
      // If the caller returns a Response-like object with a non-2xx
      // status that the predicate deems retryable, treat it as a
      // retryable failure.
      if (isRetryable(result)) {
        lastError = result;
      } else {
        onEvent?.({ kind: 'succeeded', attempt });
        return result;
      }
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) {
        onEvent?.({
          kind: 'attempt_failed',
          attempt,
          reason: errorReason(err),
          willRetry: false,
        });
        throw err;
      }
    }

    const willRetry = attempt + 1 < maxAttempts;
    if (!willRetry) {
      // Emit a terminal attempt_failed so event consumers see one
      // failure entry per attempt, then `exhausted` as the summary.
      onEvent?.({
        kind: 'attempt_failed',
        attempt,
        reason: errorReason(lastError),
        willRetry: false,
      });
      onEvent?.({ kind: 'exhausted', attempt, reason: errorReason(lastError) });
      break;
    }

    const delayMs = computeBackoff({
      attempt,
      initialBackoffMs,
      maxBackoffMs,
      backoffFactor,
      jitter,
      randomFn,
      retryAfterMs: retryAfterMs(lastError),
    });

    onEvent?.({
      kind: 'attempt_failed',
      attempt,
      reason: errorReason(lastError),
      willRetry: true,
      nextDelayMs: delayMs,
    });

    if (signal?.aborted) {
      onEvent?.({ kind: 'aborted', attempt: attempt + 1 });
      throw signalAbortError(signal);
    }

    await waitWithAbort(delayMs, setTimerFn, clearTimerFn, signal, () => {
      onEvent?.({ kind: 'aborted', attempt: attempt + 1 });
    });
  }

  throw lastError;
}

/**
 * Pure backoff calculator — exposed for tests + ops logging. Mirrors
 * the formula `retryWithBackoff` uses.
 *
 *   delay_i = clamp(initial * factor^attempt, 0, max)
 *   jittered = delay * (1 + jitter * (2 * rand() - 1))
 *   retry_after: if the error carried a Retry-After hint ≥ 0, use it
 *                verbatim (no jitter).
 */
export function computeBackoff(input: {
  attempt: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  backoffFactor: number;
  jitter: number;
  randomFn: () => number;
  retryAfterMs?: number;
}): number {
  if (input.retryAfterMs !== undefined && input.retryAfterMs >= 0) {
    return Math.min(input.retryAfterMs, input.maxBackoffMs);
  }
  const base = Math.min(
    input.initialBackoffMs * Math.pow(input.backoffFactor, input.attempt),
    input.maxBackoffMs,
  );
  if (input.jitter <= 0) return base;
  const factor = 1 + input.jitter * (2 * input.randomFn() - 1);
  return Math.max(0, Math.round(base * factor));
}

// ---------------------------------------------------------------------------
// Defaults for `isRetryable`
// ---------------------------------------------------------------------------

/**
 * Default predicate. Retries:
 *   - Response-like objects with status in {408, 429, 500-599}.
 *   - Thrown Error objects with network-ish codes / messages.
 */
function defaultIsRetryable(x: unknown): boolean {
  if (x === null || x === undefined) return false;
  // Response-like (fetch Response / our HTTP adapter result).
  if (
    typeof x === 'object' &&
    'status' in (x as object) &&
    typeof (x as { status: unknown }).status === 'number'
  ) {
    const status = (x as { status: number }).status;
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
  }
  // Thrown error.
  if (x instanceof Error) {
    const msg = x.message;
    const code = (x as NodeJS.ErrnoException).code;
    return (
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNRESET' ||
      code === 'EAI_AGAIN' ||
      code === 'ENOTFOUND' ||
      /network|fetch failed|socket hang up/i.test(msg)
    );
  }
  return false;
}

function errorReason(x: unknown): string {
  if (x === null || x === undefined) return 'unknown';
  if (typeof x === 'object' && 'status' in (x as object)) {
    return `http_${(x as { status: number }).status}`;
  }
  if (x instanceof Error) {
    return (x as NodeJS.ErrnoException).code ?? x.message;
  }
  return String(x);
}

/**
 * Extract a Retry-After hint from a Response-like object's headers.
 * Supports both seconds (integer) and HTTP-date formats. Returns
 * undefined when no hint is present or parseable.
 */
function retryAfterMs(x: unknown): number | undefined {
  if (x === null || typeof x !== 'object') return undefined;
  const headers = (x as { headers?: unknown }).headers;
  if (headers === undefined || headers === null) return undefined;
  let raw: string | undefined;
  if (typeof (headers as { get?: (k: string) => string | null }).get === 'function') {
    raw = (headers as { get: (k: string) => string | null }).get('retry-after') ?? undefined;
  } else if (typeof headers === 'object') {
    const obj = headers as Record<string, unknown>;
    const v = obj['retry-after'] ?? obj['Retry-After'];
    if (typeof v === 'string') raw = v;
  }
  if (!raw) return undefined;
  // Integer seconds?
  if (/^\d+$/.test(raw.trim())) {
    return parseInt(raw, 10) * 1000;
  }
  // HTTP-date?
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) {
    return Math.max(0, t - Date.now());
  }
  return undefined;
}

function validateOptions(opts: {
  maxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  backoffFactor: number;
  jitter: number;
}): void {
  if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts <= 0) {
    throw new Error(`retryWithBackoff: maxAttempts must be a positive integer (got ${opts.maxAttempts})`);
  }
  if (!Number.isFinite(opts.initialBackoffMs) || opts.initialBackoffMs <= 0) {
    throw new Error(`retryWithBackoff: initialBackoffMs must be > 0 (got ${opts.initialBackoffMs})`);
  }
  if (!Number.isFinite(opts.maxBackoffMs) || opts.maxBackoffMs < opts.initialBackoffMs) {
    throw new Error(`retryWithBackoff: maxBackoffMs must be >= initialBackoffMs (got ${opts.maxBackoffMs})`);
  }
  if (!Number.isFinite(opts.backoffFactor) || opts.backoffFactor < 1) {
    throw new Error(`retryWithBackoff: backoffFactor must be >= 1 (got ${opts.backoffFactor})`);
  }
  if (!Number.isFinite(opts.jitter) || opts.jitter < 0 || opts.jitter > 1) {
    throw new Error(`retryWithBackoff: jitter must be in [0, 1] (got ${opts.jitter})`);
  }
}

function signalAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string') return new Error(reason);
  return new Error('aborted');
}

function waitWithAbort(
  ms: number,
  setTimerFn: (fn: () => void, ms: number) => unknown,
  clearTimerFn: (handle: unknown) => void,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimerFn(() => {
      if (signal) signal.removeEventListener('abort', abortHandler);
      resolve();
    }, ms);
    const abortHandler = (): void => {
      clearTimerFn(timer);
      onAbort();
      reject(signalAbortError(signal!));
    };
    if (signal) signal.addEventListener('abort', abortHandler, { once: true });
  });
}
