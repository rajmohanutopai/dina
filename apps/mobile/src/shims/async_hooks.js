/**
 * Metro shim for `node:async_hooks` (React Native has no async_hooks).
 *
 * Used by `@dina/brain/src/diagnostics/trace_correlation.ts` to thread
 * a request_id across the async fan-out of an /ask call. On the
 * server (Fastify Brain) this is real Node AsyncLocalStorage. On
 * mobile, mobile only ever has one logical user-facing request in
 * flight at a time, so a single-cell stack is functionally
 * equivalent for trace correlation. The cell is restored after
 * `run()` resolves so nested withTrace() calls compose correctly.
 *
 * Limitation: across a microtask boundary that lands *after* run()
 * has already restored the cell, getStore() returns the prior
 * value. That's a degraded-observability outcome, not a correctness
 * one — the trace just truncates at the await. Acceptable for
 * mobile; the Brain server still gets full propagation.
 */

class AsyncLocalStorage {
  constructor() {
    this._store = undefined;
  }

  run(store, fn) {
    const prev = this._store;
    this._store = store;
    let result;
    try {
      result = fn();
    } catch (err) {
      this._store = prev;
      throw err;
    }
    if (result && typeof result.then === 'function') {
      return result.finally(() => {
        this._store = prev;
      });
    }
    this._store = prev;
    return result;
  }

  getStore() {
    return this._store;
  }

  exit(fn) {
    const prev = this._store;
    this._store = undefined;
    try {
      return fn();
    } finally {
      this._store = prev;
    }
  }

  disable() {
    this._store = undefined;
  }
}

module.exports = { AsyncLocalStorage };
module.exports.default = module.exports;
