/**
 * Request timeout — wrap async handlers with configurable timeout.
 *
 * Wraps any async function with a race against a timer.
 * On timeout: returns a structured timeout error (504 Gateway Timeout).
 * On completion: returns the handler's result and cancels the timer.
 *
 * Source: ARCHITECTURE.md Task 2.8
 */

import { REQUEST_TIMEOUT_MS } from '../constants';
const DEFAULT_TIMEOUT_MS = REQUEST_TIMEOUT_MS;

export interface TimeoutResult<T> {
  completed: boolean;
  result?: T;
  timedOut: boolean;
  elapsedMs: number;
}

/**
 * Run an async function with a timeout.
 *
 * If the function completes before the timeout, returns its result.
 * If the timeout fires first, returns { timedOut: true }.
 *
 * The underlying function continues running after timeout (we can't
 * cancel it), but the caller gets the timeout result immediately.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<TimeoutResult<T>> {
  const start = Date.now();

  return new Promise<TimeoutResult<T>>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({
          completed: false,
          timedOut: true,
          elapsedMs: Date.now() - start,
        });
      }
    }, timeoutMs);

    fn().then(
      (result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            completed: true,
            result,
            timedOut: false,
            elapsedMs: Date.now() - start,
          });
        }
      },
      (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          // Re-throw as a rejection so the caller can catch it
          resolve({
            completed: false,
            timedOut: false,
            elapsedMs: Date.now() - start,
          });
        }
      },
    );
  });
}

/**
 * Simpler timeout: throws on timeout instead of returning a result object.
 */
export async function withTimeoutThrow<T>(
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const result = await withTimeout(fn, timeoutMs);

  if (result.timedOut) {
    throw new TimeoutError(timeoutMs, result.elapsedMs);
  }

  if (!result.completed) {
    throw new Error('Handler failed');
  }

  return result.result!;
}

/** Typed timeout error. */
export class TimeoutError extends Error {
  public readonly timeoutMs: number;
  public readonly elapsedMs: number;

  constructor(timeoutMs: number, elapsedMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs;
  }
}
