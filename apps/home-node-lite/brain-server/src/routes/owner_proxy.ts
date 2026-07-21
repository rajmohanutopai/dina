/**
 * Round-A A-07 — the OWNER run/watch byte-pipe (§12.5).
 *
 * The lite web SPA is served from brain-server (same-origin `/api`), but the
 * owner-only run/watch control plane lives on CORE and must never be exercised
 * with authority Brain holds. This proxy therefore forwards
 * `/api/v1/run*` and `/api/v1/watch*` to Core VERBATIM — method, path, body,
 * and the `x-dina-owner-capability` header the OWNER'S BROWSER supplied — and
 * relays Core's response bytes back. Brain never stores, mints, or validates
 * the capability: without the browser-presented header Core answers 403, so a
 * compromised Brain can forward, delay, or drop owner requests but can never
 * ORIGINATE one. (The header transits this process, as the web-session token
 * already does — the loopback-only bind is that surface's outer gate.)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterOwnerProxyRoutesOptions {
  /** Core's HTTP base URL (e.g. http://127.0.0.1:8100). */
  coreBaseUrl: string;
  /** Route prefix override (defaults to `/api/v1`). */
  prefix?: string;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
}

export function registerOwnerProxyRoutes(
  app: FastifyInstance,
  opts: RegisterOwnerProxyRoutesOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const doFetch = opts.fetchFn ?? fetch;
  const base = opts.coreBaseUrl.replace(/\/$/, '');

  const forward = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // `/api/v1/run/...` → `/v1/run/...` (same for watch). The wildcard params
    // preserve the full suffix; the query string rides along verbatim.
    const suffix = req.url.replace(/^\/api/, '');
    const capability = req.headers['x-dina-owner-capability'];
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (typeof capability === 'string' && capability !== '') {
      headers['x-dina-owner-capability'] = capability;
    }
    try {
      const res = await doFetch(`${base}${suffix}`, {
        method: req.method,
        headers,
        ...(req.method === 'GET' || req.method === 'HEAD'
          ? {}
          : { body: JSON.stringify(req.body ?? {}) }),
      });
      const text = await res.text();
      void reply
        .status(res.status)
        .header('content-type', res.headers.get('content-type') ?? 'application/json')
        .send(text === '' ? undefined : text);
    } catch (err) {
      void reply.status(502).send({
        error: 'core_unreachable',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  for (const root of ['run', 'watch']) {
    app.all(`${prefix}/${root}`, forward);
    app.all(`${prefix}/${root}/*`, forward);
  }
}
