/**
 * /metrics bearer-token gate (P3.13).
 *
 * `/metrics` exposes internal operational data (counts, error rates, subject
 * volumes) on a PUBLIC service, so it must not be world-readable. It is
 * DISABLED by default: only when `DINA_METRICS_TOKEN` is set AND the request
 * presents it as `Authorization: Bearer <token>` does scraping succeed. A
 * missing/mismatched token yields a 404 at the call site (not 401) so the
 * surface can't be enumerated — matching the test-inject gate.
 *
 * Kept in its own module (not `server.ts`, which self-starts an HTTP server on
 * import) so it is unit-testable in isolation.
 */
export function checkMetricsAuth(authHeader: string | undefined): boolean {
  const token = process.env.DINA_METRICS_TOKEN
  if (typeof token !== 'string' || token.length === 0) return false
  const provided = (authHeader ?? '').replace(/^Bearer\s+/, '')
  return provided === token
}
