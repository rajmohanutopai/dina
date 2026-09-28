/**
 * PeerLens read proxy — the web thin-client's same-origin AppView lane.
 *
 * Forwards only read-only GET xRPCs — `com.dinakernel.peerlens.*` and the
 * supplier finder's three discovery reads, by exact name — to the configured
 * AppView server-side (so the browser never calls external infra
 * directly → no CORS); refuses anything else and never masks the upstream
 * status.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { registerPeerlensProxyRoutes } from '../src/routes/peerlens_proxy';

interface Captured {
  url: string;
  method: string;
}

function makeApp(
  captured: Captured[],
  opts: { status?: number; body?: string; contentType?: string; throwErr?: boolean } = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  const fetchImpl = (async (input: string | URL, init?: { method?: string }) => {
    captured.push({ url: String(input), method: init?.method ?? 'GET' });
    if (opts.throwErr) throw new Error('network down');
    return new Response(opts.body ?? '{"results":[]}', {
      status: opts.status ?? 200,
      headers: { 'content-type': opts.contentType ?? 'application/json' },
    });
  }) as unknown as typeof fetch;
  registerPeerlensProxyRoutes(app, { appViewURL: 'https://appview.example/', fetchImpl });
  return app;
}

describe('Brain — PeerLens read proxy (web thin-client)', () => {
  it('forwards an allowed peerlens read xRPC to the AppView with its query, server-side', async () => {
    const captured: Captured[] = [];
    const app = makeApp(captured, { body: '{"results":[{"uri":"x"}]}' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/peerlens/xrpc/com.dinakernel.peerlens.search?q=coffee&limit=50',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [{ uri: 'x' }] });
    // Forwarded to the AppView (trailing slash normalized) carrying the query.
    expect(captured.map((c) => c.url)).toEqual([
      'https://appview.example/xrpc/com.dinakernel.peerlens.search?q=coffee&limit=50',
    ]);
    await app.close();
  });

  it('refuses a NON-peerlens nsid and never forwards it (not an open proxy)', async () => {
    const captured: Captured[] = [];
    const app = makeApp(captured);
    const res = await app.inject({
      method: 'GET',
      url: '/api/peerlens/xrpc/com.dinakernel.test.injectAttestation?token=x',
    });
    expect(res.statusCode).toBe(404);
    expect(captured).toHaveLength(0);
    await app.close();
  });

  it.each([
    'com.dinakernel.commerce.searchCatalog?q=cake&region=postal_area%3A560001',
    'com.dinakernel.service.search?capability=com.dinakernel.commerce.request_quote&q=cake',
    'com.dinakernel.service.getByUri?uri=at%3A%2F%2Fdid%3Aplc%3Ax%2Fcom.dinakernel.service.profile%2Fshop',
  ])('forwards the supplier finder’s public read %s', async (path) => {
    const captured: Captured[] = [];
    const app = makeApp(captured);
    const res = await app.inject({ method: 'GET', url: `/api/peerlens/xrpc/${path}` });
    expect(res.statusCode).toBe(200);
    expect(captured.map((c) => [c.url, c.method])).toEqual([
      [`https://appview.example/xrpc/${path}`, 'GET'],
    ]);
    await app.close();
  });

  it.each([
    'com.dinakernel.commerce.publishCatalog',
    'com.dinakernel.service.searchX',
    'com.dinakernel.commerce.searchCatalogs',
  ])('refuses a name that only resembles a discovery read (%s)', async (nsid) => {
    const captured: Captured[] = [];
    const app = makeApp(captured);
    const res = await app.inject({ method: 'GET', url: `/api/peerlens/xrpc/${nsid}` });
    expect(res.statusCode).toBe(404);
    expect(captured).toHaveLength(0);
    await app.close();
  });

  it('only GET: a POST to an allowed name reaches no route', async () => {
    const captured: Captured[] = [];
    const app = makeApp(captured);
    const res = await app.inject({
      method: 'POST',
      url: '/api/peerlens/xrpc/com.dinakernel.service.search',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(captured).toHaveLength(0);
    await app.close();
  });

  it('propagates the upstream AppView status (e.g. 503) instead of masking it', async () => {
    const captured: Captured[] = [];
    const app = makeApp(captured, { status: 503, body: 'unavailable', contentType: 'text/plain' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/peerlens/xrpc/com.dinakernel.peerlens.getProfile?did=did:plc:x',
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('returns 502 when the AppView is unreachable', async () => {
    const captured: Captured[] = [];
    const app = makeApp(captured, { throwErr: true });
    const res = await app.inject({
      method: 'GET',
      url: '/api/peerlens/xrpc/com.dinakernel.peerlens.search?q=x',
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});
