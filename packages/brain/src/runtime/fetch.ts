/**
 * Platform-safe `fetch` accessor.
 *
 * The browser's WebIDL `fetch` (per `WindowOrWorkerGlobalScope.fetch`)
 * requires `this` at invocation time to be the platform object — i.e.
 * `Window` in a page, `WorkerGlobalScope` in a worker. Storing the
 * method as an unbound reference (`const f = globalThis.fetch; f(...)`)
 * loses that binding and crashes with `TypeError: Failed to execute
 * 'fetch' on 'Window': Illegal invocation`.
 *
 * Node's undici-backed fetch is tolerant — `this` doesn't matter — so
 * the same code "works" on the server but breaks in browsers and in
 * strict WebView runtimes.
 *
 * Every site that captures the global as an injectable fallback should
 * use `defaultFetch()`. This is the only place the binding rationale
 * lives; importers get a named, greppable hook without 20+ copies of
 * the same comment scattered through the codebase.
 *
 * Mirrors `@dina/core`'s `defaultFetch()` — kept as a peer because
 * `@dina/brain` does not depend on `@dina/core`.
 */
export function defaultFetch(): typeof globalThis.fetch {
  return globalThis.fetch.bind(globalThis);
}
