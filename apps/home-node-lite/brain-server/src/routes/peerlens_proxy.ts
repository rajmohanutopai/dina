/**
 * PeerLens read-only proxy — the web thin-client's same-origin AppView lane.
 *
 * The browser is a THIN CLIENT: it must never call external infra (the AppView)
 * directly. Doing so breaks the sovereignty rule (all external I/O flows through
 * the Home Node) AND fails in the browser — the AppView exposes no
 * `Access-Control-Allow-Origin`, so a cross-origin read is CORS-blocked
 * ("Failed to fetch"). So the web build points its PeerLens reads at a
 * same-origin path (`/api/peerlens/xrpc/…`, resolved in
 * apps/mobile/src/peerlens/appview_runtime.ts), and this route forwards them to
 * the configured AppView server-side (server-to-server → no CORS). Native
 * (mobile) IS the full Home Node and keeps calling the AppView directly, so
 * this proxy is web-only.
 *
 * Scope: read-only `com.dinakernel.peerlens.*` xRPCs over GET. Anything else is
 * refused — a narrow forwarder for PUBLIC trust reads (no vault, no keys),
 * never an open proxy.
 */

import type { FastifyInstance } from 'fastify';

const ALLOWED_NSID_PREFIX = 'com.dinakernel.peerlens.';

export interface PeerlensProxyOptions {
  /** The real AppView base URL to forward to. */
  appViewURL: string;
  /** Structured log sink (metadata only — never response bodies). */
  logger?: {
    info: (obj: object, msg?: string) => void;
    warn: (obj: object, msg?: string) => void;
  };
  /** Injected fetch (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export function registerPeerlensProxyRoutes(
  app: FastifyInstance,
  opts: PeerlensProxyOptions,
): void {
  const base = opts.appViewURL.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;

  app.get<{ Params: { nsid: string } }>('/api/peerlens/xrpc/:nsid', async (req, reply) => {
    const { nsid } = req.params;
    // Narrow forwarder: only the public PeerLens read surface. A non-peerlens
    // NSID (e.g. the test-inject endpoints) is refused, never forwarded.
    if (!nsid.startsWith(ALLOWED_NSID_PREFIX)) {
      return reply.code(404).send({ error: 'not_found', reason: 'not a PeerLens read xRPC' });
    }
    const rawUrl = req.raw.url ?? '';
    const qIdx = rawUrl.indexOf('?');
    const qs = qIdx >= 0 ? rawUrl.slice(qIdx) : '';
    const target = `${base}/xrpc/${nsid}${qs}`;
    try {
      const res = await doFetch(target, { method: 'GET' });
      const body = await res.text();
      reply.code(res.status);
      reply.header('content-type', res.headers.get('content-type') ?? 'application/json');
      // Forward the raw text verbatim (already-serialized JSON); Fastify sends a
      // string as-is under the content-type set above.
      return reply.send(body);
    } catch (err) {
      opts.logger?.warn(
        { nsid, error: err instanceof Error ? err.message : String(err) },
        'peerlens proxy: AppView unreachable',
      );
      return reply.code(502).send({ error: 'appview_unreachable' });
    }
  });
}
