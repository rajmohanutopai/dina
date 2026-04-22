/**
 * Task 5.12 — Startup retry: poll until a dependency is reachable.
 *
 * When Brain boots, Core may still be starting up (container
 * orchestration races). Brain's job is to wait — not crash — until
 * Core responds healthy on `/healthz` and `/v1/service/config`. This
 * primitive is the poll-with-backoff loop that drives that wait.
 *
 * **Why a primitive**: the same pattern recurs across bootstrap
 * surfaces — Brain ↔ Core, MsgBox ↔ Core, agent-daemon ↔ Core,
 * system tests' "wait-for-ready". Centralising the exponential-backoff
 * + budget + cancellation + event-stream logic keeps each call-site
 * down to a one-liner with a scripted `probeFn`.
 *
 * **Contract** (pinned by tests):
 *   - `probeFn()` returns `{ok: true}` → resolve.
 *   - `probeFn()` returns `{ok: false, reason}` OR throws → wait
 *     `nextDelay(attempt)` then retry.
 *   - `nextDelay` starts at `initialDelayMs` (default 500ms) +
 *     doubles up to `maxDelayMs` (default 10s). Jitter ±20% to
 *     avoid thundering-herd when many clients boot simultaneously.
 *   - After `maxDurationMs` (default 60s) cumulative elapsed time,
 *     give up + reject with `startup_timeout`.
 *   - `AbortSignal` honoured: abort during a probe or during a wait
 *     rejects immediately with `AbortError`.
 *
 * **Injectable timers + clock + random** so tests are deterministic:
 *   - `setTimerFn` / `clearTimerFn` — mock scheduler for fake backoff.
 *   - `nowMsFn` — mock clock for budget tracking.
 *   - `randomFn` — deterministic jitter (0..1 → no jitter when test
 *     passes `() => 0.5`).
 *
 * **Pure-ish**: the return value is a promise — every side effect
 * routes through the injected fns.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5b task 5.12.
 */

export type ProbeOutcome = { ok: true } | { ok: false; reason: string };

export type ProbeFn = (
  signal?: AbortSignal,
) => Promise<ProbeOutcome>;

export type SetTimerFn = (fn: () => void, ms: number) => unknown;
export type ClearTimerFn = (handle: unknown) => void;

export interface WaitUntilReachableOptions {
  /** Label for events + error messages, e.g. `"core"` or `"msgbox"`. */
  name: string;
  /** Probe function. Returns ok/fail outcome or throws on transport error. */
  probeFn: ProbeFn;
  /** Initial backoff. Default 500ms. */
  initialDelayMs?: number;
  /** Max backoff per attempt. Default 10s. */
  maxDelayMs?: number;
  /** Total budget before giving up. Default 60s. */
  maxDurationMs?: number;
  /** Jitter fraction applied to each delay. Default 0.2 (±20%). 0 = no jitter. */
  jitter?: number;
  /** Abort signal. Rejects with AbortError on trigger. */
  signal?: AbortSignal;
  /** Injectable scheduler. Defaults to native setTimeout/clearTimeout. */
  setTimerFn?: SetTimerFn;
  clearTimerFn?: ClearTimerFn;
  /** Injectable clock. Defaults to Date.now. */
  nowMsFn?: () => number;
  /** Injectable randomness for jitter. Defaults to Math.random. */
  randomFn?: () => number;
  /** Diagnostic hook. */
  onEvent?: (event: StartupRetryEvent) => void;
}

export type StartupRetryEvent =
  | { kind: 'probe_started'; name: string; attempt: number }
  | { kind: 'probe_ok'; name: string; attempt: number; durationMs: number }
  | {
      kind: 'probe_failed';
      name: string;
      attempt: number;
      reason: string;
      nextDelayMs: number;
    }
  | {
      kind: 'gave_up';
      name: string;
      attempts: number;
      elapsedMs: number;
      lastReason: string;
    }
  | { kind: 'aborted'; name: string; attempts: number };

export const DEFAULT_INITIAL_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 10_000;
export const DEFAULT_MAX_DURATION_MS = 60_000;
export const DEFAULT_JITTER = 0.2;

/**
 * Compute the delay for attempt N (0-based). Exponential ×2 up to
 * `max`. Jitter applied via `random * 2 - 1 → [-1, 1]`, scaled by
 * `jitter` fraction. Exposed for tests + ops tooling that wants to
 * print "next retry in ~Xs".
 */
export function computeBackoffMs(
  attempt: number,
  opts: { initialDelayMs: number; maxDelayMs: number; jitter: number; randomFn: () => number },
): number {
  const base = Math.min(
    opts.initialDelayMs * Math.pow(2, Math.max(0, attempt)),
    opts.maxDelayMs,
  );
  if (opts.jitter <= 0) return base;
  const jitterRange = opts.jitter;
  const factor = 1 + (opts.randomFn() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(base * factor));
}

/**
 * Error thrown when the startup budget is exhausted without a
 * successful probe. `name` identifies which dependency gave up so
 * the caller can surface a precise boot error.
 */
export class StartupTimeoutError extends Error {
  constructor(
    public readonly name: string,
    public readonly attempts: number,
    public readonly elapsedMs: number,
    public readonly lastReason: string,
  ) {
    super(
      `startup timeout: dependency "${name}" not reachable after ${attempts} attempts / ${elapsedMs}ms (last: ${lastReason})`,
    );
    this.name = 'StartupTimeoutError';
  }
}

/** Rejection when `AbortSignal` fires mid-wait. */
export class StartupAbortError extends Error {
  constructor(public readonly name: string, public readonly attempts: number) {
    super(`startup aborted for "${name}" after ${attempts} attempts`);
    this.name = 'StartupAbortError';
  }
}

/**
 * Poll `probeFn` until it returns `{ok: true}` or the budget runs
 * out. Returns the attempt count on success; throws
 * `StartupTimeoutError` or `StartupAbortError` on failure.
 */
export async function waitUntilReachable(
  opts: WaitUntilReachableOptions,
): Promise<{ attempts: number; elapsedMs: number }> {
  if (typeof opts.name !== 'string' || opts.name.trim() === '') {
    throw new TypeError('waitUntilReachable: name is required');
  }
  if (typeof opts.probeFn !== 'function') {
    throw new TypeError('waitUntilReachable: probeFn is required');
  }
  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxDurationMs = opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const jitter = opts.jitter ?? DEFAULT_JITTER;
  const setTimerFn =
    opts.setTimerFn ??
    ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimerFn =
    opts.clearTimerFn ??
    ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>));
  const nowMsFn = opts.nowMsFn ?? (() => Date.now());
  const randomFn = opts.randomFn ?? (() => Math.random());
  const onEvent = opts.onEvent;

  const start = nowMsFn();
  let attempt = 0;
  let lastReason = '';

  while (true) {
    if (opts.signal?.aborted) {
      onEvent?.({ kind: 'aborted', name: opts.name, attempts: attempt });
      throw new StartupAbortError(opts.name, attempt);
    }

    attempt++;
    onEvent?.({ kind: 'probe_started', name: opts.name, attempt });
    const probeStart = nowMsFn();
    let outcome: ProbeOutcome;
    try {
      outcome = await opts.probeFn(opts.signal);
    } catch (err) {
      outcome = {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    if (outcome.ok) {
      onEvent?.({
        kind: 'probe_ok',
        name: opts.name,
        attempt,
        durationMs: nowMsFn() - probeStart,
      });
      return { attempts: attempt, elapsedMs: nowMsFn() - start };
    }
    lastReason = outcome.reason;

    const elapsed = nowMsFn() - start;
    if (elapsed >= maxDurationMs) {
      onEvent?.({
        kind: 'gave_up',
        name: opts.name,
        attempts: attempt,
        elapsedMs: elapsed,
        lastReason,
      });
      throw new StartupTimeoutError(
        opts.name,
        attempt,
        elapsed,
        lastReason,
      );
    }

    // Compute next delay + clamp so we never wait past the budget.
    const backoff = computeBackoffMs(attempt - 1, {
      initialDelayMs,
      maxDelayMs,
      jitter,
      randomFn,
    });
    const delay = Math.min(backoff, Math.max(0, maxDurationMs - elapsed));
    onEvent?.({
      kind: 'probe_failed',
      name: opts.name,
      attempt,
      reason: lastReason,
      nextDelayMs: delay,
    });

    if (delay === 0) continue; // no budget left → loop around (next iter hits gave_up)

    await sleep(delay, opts.signal, setTimerFn, clearTimerFn);
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function sleep(
  ms: number,
  signal: AbortSignal | undefined,
  setTimerFn: SetTimerFn,
  clearTimerFn: ClearTimerFn,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let handle: unknown = null;
    const onAbort = (): void => {
      if (handle !== null) clearTimerFn(handle);
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    handle = setTimerFn(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
  });
}
