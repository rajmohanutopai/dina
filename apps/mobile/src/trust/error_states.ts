/**
 * Trust Network error-state copy + classifier (TN-MOB-030).
 *
 * Five failure modes any Trust Network screen can hit when calling
 * AppView's xRPC endpoints:
 *
 *   - `offline`        — device has no network connection (NetInfo
 *                        reports unreachable). The fetch hasn't even
 *                        started; we surface this distinctly because
 *                        the user's first thought should be "is my
 *                        wifi on?", not "is the server down?".
 *   - `network_error`  — fetch threw before producing a response
 *                        (DNS, connection refused, TLS, timeout).
 *                        Distinct from `offline` because the device
 *                        thinks it has connectivity, the route is
 *                        just broken.
 *   - `rate_limited`   — HTTP 429. Per plan §6 the read endpoints
 *                        rate-limit at 60–600 req/min depending on
 *                        endpoint; surfacing this distinctly tells
 *                        the user "wait" rather than "retry now".
 *   - `server_error`   — HTTP 5xx. AppView is reachable but unhealthy.
 *   - `not_found`      — HTTP 404. The subject / profile / DID being
 *                        queried doesn't exist in the index. Distinct
 *                        from "no results from a search" (that's an
 *                        empty state, not an error).
 *
 * Each state carries `{title, body, action}` where `action` is the
 * retry CTA label or `null` when retry isn't honest. `rate_limited`
 * has no action because hammering retry is exactly the wrong response
 * to a rate-limit. `not_found` has no action because the resource is
 * gone — the only "fix" is going somewhere else.
 *
 * The classifier `classifyTrustError(input)` takes a discriminated
 * input — a known offline state, a known network-error throw, or an
 * HTTP status code — and routes it. Returns `null` only for inputs
 * the classifier can't read (HTTP success codes, unknown shapes);
 * screens use `result === null` to mean "this isn't an error case".
 *
 * This module is React-free. Pure data + pure function — runs under
 * plain Jest. Screens wrap it with their own theme tokens / icons /
 * retry-button wiring.
 */

// ─── Public types ─────────────────────────────────────────────────────────

export type ErrorState =
  | 'offline'
  | 'network_error'
  | 'rate_limited'
  | 'server_error'
  | 'not_found';

export interface ErrorStateContent {
  readonly title: string;
  readonly body: string;
  /**
   * The retry-CTA label, or `null` when retrying is the wrong move
   * (rate limits, missing resources). Screens render the retry
   * button conditionally on `action !== null`.
   */
  readonly action: string | null;
}

// ─── Copy ─────────────────────────────────────────────────────────────────

/**
 * Frozen content map. Mutating any level of this corrupts every
 * render site that reads it; freezing forces accidental writes to
 * fail loudly under strict mode (or no-op under sloppy) instead of
 * silently editing the source of truth.
 */
export const ERROR_STATE_CONTENT: Readonly<Record<ErrorState, ErrorStateContent>> = Object.freeze({
  offline: Object.freeze({
    title: "You're offline",
    body: 'Connect to the internet to load Trust Network data.',
    action: 'Try again',
  }),
  network_error: Object.freeze({
    title: "Couldn't reach the server",
    body: "Your device seems online, but we couldn't reach Trust Network. Check again in a moment.",
    action: 'Try again',
  }),
  rate_limited: Object.freeze({
    title: 'Too many requests',
    body: "You've hit the request limit. Trust Network will be available again shortly.",
    // No retry CTA: hammering this exact button is exactly what the
    // rate limit exists to prevent. Caller may schedule a delayed
    // retry on its own; the user-facing surface stays "wait".
    action: null,
  }),
  server_error: Object.freeze({
    title: 'Trust Network is having trouble',
    body: 'The service is unavailable right now. Try again in a few minutes.',
    action: 'Try again',
  }),
  not_found: Object.freeze({
    title: 'Not found',
    body: "This doesn't exist on Trust Network — it may have been removed by its author.",
    // No retry CTA: 404 is terminal for this resource. The screen
    // typically offers "go back" as a navigation action; that's a
    // navigation concern, not an error-recovery one.
    action: null,
  }),
});

// ─── Classifier ───────────────────────────────────────────────────────────

/**
 * Discriminated input. Three shapes the call sites actually have:
 *
 *   - `{kind: 'offline'}` — NetInfo subscriber / device-state hook
 *     reports the device has no connectivity.
 *   - `{kind: 'network_error'}` — `fetch()` threw before producing a
 *     `Response` (DNS, refused, TLS, timeout).
 *   - `{kind: 'http_status', status: number}` — we got a `Response`
 *     and want to classify by status code.
 */
export type ErrorInput =
  | { readonly kind: 'offline' }
  | { readonly kind: 'network_error' }
  | { readonly kind: 'http_status'; readonly status: number };

/**
 * Map an error input to a state, or `null` when the input isn't an
 * error case this classifier should surface.
 *
 * Status mapping:
 *   404                           → 'not_found'
 *   429                           → 'rate_limited'
 *   500..599                      → 'server_error'
 *   2xx / 3xx                     → null (not an error)
 *   other 4xx (400 / 401 / 403 /
 *     405 / 409 / 410 / 422 / …)  → null  (deliberately unhandled —
 *                                    auth / validation errors need
 *                                    caller-specific recovery paths,
 *                                    NOT a generic "server is having
 *                                    trouble" card. Absorbing them
 *                                    here would silently hide bugs)
 *   non-finite / out-of-range     → null (caller bug; don't paper
 *                                    over with a misleading state)
 *
 * The `null` result on unhandled 4xx is the contract: the screen has
 * to handle 401/403/422 (re-auth, validation surface, etc.) before
 * falling back to this classifier. If the screen forgets, the
 * fallback is a blank slot rather than a misleading "server error" —
 * which is louder during development.
 */
export function classifyTrustError(input: ErrorInput): ErrorState | null {
  switch (input.kind) {
    case 'offline':
      return 'offline';

    case 'network_error':
      return 'network_error';

    case 'http_status': {
      const s = input.status;
      if (!Number.isFinite(s) || s < 100 || s > 599) return null;
      if (s >= 200 && s < 400) return null; // success / redirect
      if (s === 404) return 'not_found';
      if (s === 429) return 'rate_limited';
      if (s >= 500) return 'server_error';
      // Other 4xx — caller must handle. See docstring.
      return null;
    }
  }
}

/**
 * Convenience: classify, then look up the content. Returns `null`
 * when the input isn't an error so screens can render with a single
 * conditional gate.
 */
export function errorStateContentFor(input: ErrorInput): ErrorStateContent | null {
  const state = classifyTrustError(input);
  return state === null ? null : ERROR_STATE_CONTENT[state];
}
