/**
 * Brain-side error types.
 *
 * Home for structured errors brain code throws that callers may want
 * to pattern-match on via `instanceof`. Kept transport-agnostic so
 * chat orchestrator catches + user-friendly translation logic doesn't
 * depend on a specific Core client implementation.
 */

/**
 * Thrown when a Core HTTP call returns a non-accepted status. Exposes
 * `status` + `detail` + `method` so callers can branch on the code
 * (e.g. surface "service unavailable" for 503, "approval not found"
 * for 404) without string-matching the message. The human-readable
 * `message` is still populated for logs.
 *
 * Previously lived in `core_client/http.ts` alongside the now-deleted
 * `BrainCoreClient`. The error type itself is transport-agnostic —
 * any Core client (legacy BrainCoreClient, the current HTTP transport,
 * a future alternative) can throw this when it sees a non-2xx the
 * caller should branch on.
 */
export class CoreHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: string,
    readonly method: string,
  ) {
    super(message);
    this.name = 'CoreHttpError';
  }
}
