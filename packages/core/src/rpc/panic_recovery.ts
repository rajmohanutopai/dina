/**
 * Panic / uncaught-exception recovery for RPC worker tasks.
 *
 * A synchronous throw or a promise rejection inside a worker body must
 * NOT crash the worker pool. It must be caught, recorded, and converted
 * into an inner-response `500` so the caller receives a well-formed
 * reply instead of a hung connection.
 *
 * This helper wraps `work()` with the catch-convert behaviour. Callers
 * plug it into `RPCWorkerPool.submitDuplicate(key, () =>
 * withPanicRecovery(work, {onPanic: log}))` so every job in the pool
 * is automatically shielded.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md CORE-P0-007.
 */

import type { RPCInnerResponse } from './types';

export interface PanicRecoveryOptions {
  /** Called for every caught panic. Takes the error + panic reason. */
  onPanic?: (err: Error, reason: 'sync-throw' | 'async-rejection') => void;
}

/**
 * Run `work`. If it throws synchronously OR rejects asynchronously,
 * catch the error, invoke `onPanic` (best-effort — errors in it are
 * swallowed), and return a canonical `500` inner response. Never rejects.
 */
export async function withPanicRecovery(
  work: () => Promise<RPCInnerResponse> | RPCInnerResponse,
  options: PanicRecoveryOptions = {},
): Promise<RPCInnerResponse> {
  const onPanic =
    options.onPanic ??
    (() => {
      /* no-op */
    });
  // Synchronous throw: the call itself raises before returning a promise.
  let ret: Promise<RPCInnerResponse> | RPCInnerResponse;
  try {
    ret = work();
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    try {
      onPanic(err, 'sync-throw');
    } catch {
      /* swallow logger errors */
    }
    return panicResponse(err);
  }
  // Async rejection: awaited value may be a promise.
  try {
    return await ret;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    try {
      onPanic(err, 'async-rejection');
    } catch {
      /* swallow logger errors */
    }
    return panicResponse(err);
  }
}

function panicResponse(err: Error): RPCInnerResponse {
  const body = JSON.stringify({
    error: 'internal_error',
    detail: err.message.slice(0, 512), // truncate — don't leak full stacks to the wire
  });
  return {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
    body: new TextEncoder().encode(body),
  };
}
