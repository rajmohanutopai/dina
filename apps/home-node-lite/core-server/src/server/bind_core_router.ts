/**
 * Task 4.13 — walk a `CoreRouter` and register each route onto Fastify.
 *
 * The Go Core's handlers are all registered on a `CoreRouter`, and the
 * TypeScript `@dina/core` mirrors that layout: routes are declared with
 * `.get/.post/.put/.delete(path, handler, {auth})` on a single
 * `CoreRouter` instance. This module bridges that declarative list to
 * Fastify by walking `router.list()` and registering an equivalent
 * Fastify route for each entry.
 *
 * **Path mapping.** CoreRouter paths use `:param` placeholders
 * (Express / Fastify convention) — they translate to Fastify without
 * change. Wildcards aren't used today.
 *
 * **Handler adapter.** Fastify's `(req, reply)` shape differs from
 * CoreRouter's `(coreReq) → coreRes`. We adapt at the boundary:
 * collect the raw body bytes + headers + query into a `CoreRequest`,
 * dispatch through `CoreRouter.handle()` (which runs auth, path
 * matching, param extraction, and handler error normalisation), and
 * render the response onto the Fastify reply.
 *
 * **Auth handoff.** The CoreRouter's own `handle()` runs the `signed`
 * auth pipeline when `auth === 'signed'`. This adapter never calls raw
 * route handlers directly and never accepts the in-process trust marker
 * from HTTP input. HTTP auth remains fail-closed at the Core boundary.
 *
 * **Raw body handoff.** Auth verification needs the raw request
 * bytes (SHA-256 input for the canonical signing payload). Fastify's
 * default JSON parser drops the raw form; we install a minimal
 * content-type parser (`application/json` + `application/octet-stream`
 * + `text/*`) that captures the raw bytes into `req.rawBody` before
 * JSON-parsing. Routes that don't need the raw body ignore it.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4b task 4.13.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import type { CoreRouter, CoreRequest, CoreResponse } from '@dina/core';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Augment Fastify's request type surface with our raw-body field. */
declare module 'fastify' {
  interface FastifyRequest {
    /** Bytes as they came off the socket. Populated by our JSON parser. */
    rawBody?: Uint8Array;
  }
}

export interface BindCoreRouterOptions {
  /** The assembled `CoreRouter` with all handlers registered. */
  coreRouter: CoreRouter;
  /**
   * Round-A A-07 — the owner capability for the §12.5 owner-only run/watch
   * control plane. When set, a request whose `x-dina-owner-capability` header
   * MATCHES it (timing-safe) AND whose path is on the owner surface
   * (`/v1/run*` / `/v1/watch*`) is stamped `callerType:'owner'` +
   * `ownerCapability` + the in-process trust marker, so the router dispatches
   * it to the in-handler owner guard (which re-validates the capability). The
   * stamp is SCOPED: a matching header on any other path grants nothing, so
   * the capability never becomes a whole-Core credential. Absent/mismatched
   * headers leave the request unstamped — the guard 403s (fail-closed), and
   * external callers still can't forge the trust marker (it is never read
   * from HTTP input).
   */
  ownerCapability?: string;
  /**
   * Routes already owned by the Fastify shell. Boot uses this to keep
   * `/healthz` as the process liveness route while binding the rest of
   * CoreRouter's API surface.
   */
  skipRoutes?: readonly { method: CoreRequest['method']; path: string }[];
  /** The Fastify instance to bind onto. Any instance returned by `createServer()`. */
  app: {
    get(path: string, handler: FastifyHandler): unknown;
    post(path: string, handler: FastifyHandler): unknown;
    put(path: string, handler: FastifyHandler): unknown;
    delete(path: string, handler: FastifyHandler): unknown;
    patch(path: string, handler: FastifyHandler): unknown;
    addContentTypeParser?: (
      type: string | string[],
      opts: { parseAs: 'buffer' | 'string' },
      fn: (
        req: FastifyRequest,
        body: Buffer | string,
        done: (err: Error | null, parsed?: unknown) => void,
      ) => void,
    ) => unknown;
  };
}

type FastifyHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;

/**
 * Walk the router's registered routes and bind each onto Fastify.
 *
 * Returns the number of routes bound so callers can assert the
 * walk completed (`routesBound === router.size()`).
 */
export function bindCoreRouter(opts: BindCoreRouterOptions): number {
  installRawBodyParser(opts.app);

  let count = 0;
  for (const route of opts.coreRouter.list()) {
    if (shouldSkipRoute(route, opts.skipRoutes)) {
      continue;
    }
    const fastifyPath = route.path; // `:param` is shared syntax between CoreRouter + Fastify

    const handler: FastifyHandler = async (req, reply) => {
      let coreReq = buildCoreRequest(req);
      // A-07 — stamp the OWNER identity only on a timing-safe capability match
      // scoped to the run/watch owner surface (see BindCoreRouterOptions).
      if (
        opts.ownerCapability !== undefined &&
        opts.ownerCapability !== '' &&
        isOwnerSurfacePath(coreReq.path) &&
        ownerHeaderMatches(coreReq.headers['x-dina-owner-capability'], opts.ownerCapability)
      ) {
        coreReq = {
          ...coreReq,
          trustedInProcess: true,
          callerType: 'owner',
          ownerCapability: opts.ownerCapability,
        };
      }
      const coreRes = await opts.coreRouter.handle(coreReq);
      renderCoreResponse(coreRes, reply);
    };

    switch (route.method) {
      case 'GET':
        opts.app.get(fastifyPath, handler);
        break;
      case 'POST':
        opts.app.post(fastifyPath, handler);
        break;
      case 'PUT':
        opts.app.put(fastifyPath, handler);
        break;
      case 'DELETE':
        opts.app.delete(fastifyPath, handler);
        break;
      case 'PATCH':
        opts.app.patch(fastifyPath, handler);
        break;
    }
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function shouldSkipRoute(
  route: { method: CoreRequest['method']; path: string },
  skipRoutes: BindCoreRouterOptions['skipRoutes'],
): boolean {
  if (skipRoutes === undefined || skipRoutes.length === 0) return false;
  return skipRoutes.some((skip) => skip.method === route.method && skip.path === route.path);
}

function installRawBodyParser(app: BindCoreRouterOptions['app']): void {
  if (!app.addContentTypeParser) return; // test doubles don't always provide it
  // JSON + octet-stream: capture raw bytes AND parse JSON for handlers
  // that want a parsed body.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    // `parseAs: 'buffer'` → body is always a Node Buffer.
    const buf = body as Buffer;
    req.rawBody = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    try {
      const parsed = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
      done(null, parsed);
    } catch (err) {
      done(err as Error);
    }
  });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (req, body, done) => {
    // `parseAs: 'buffer'` → body is always a Node Buffer.
    const buf = body as Buffer;
    req.rawBody = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    done(null, req.rawBody);
  });
}

/** Owner-only control surfaces that may consume the browser-held capability.
 *
 * Mixed reasoning worker routes remain excluded. Only backend configuration
 * is owner-controlled here; claim/complete/fail still require a signed backend
 * DID and can never be reached with the owner capability.
 */
function isOwnerSurfacePath(p: string): boolean {
  return (
    p === '/v1/run' ||
    p.startsWith('/v1/run/') ||
    p === '/v1/watch' ||
    p.startsWith('/v1/watch/') ||
    p === '/v1/owner' ||
    p.startsWith('/v1/owner/') ||
    p === '/v1/reasoning/backends' ||
    p === '/v1/reasoning/backends/register' ||
    (p.startsWith('/v1/reasoning/backends/') && p.endsWith('/revoke'))
  );
}

/** Timing-safe capability comparison (hash both sides to fixed length first). */
export function ownerHeaderMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || header === '') return false;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function buildCoreRequest(req: FastifyRequest): CoreRequest {
  // Fastify lowercases header names already.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers[k] = Array.isArray(v) ? v.join(',') : String(v);
  }

  // Query: Fastify has already parsed it into `req.query`.
  const query: Record<string, string> = {};
  const q = req.query as Record<string, unknown> | undefined;
  if (q && typeof q === 'object') {
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined) continue;
      query[k] = Array.isArray(v) ? String(v[0] ?? '') : String(v);
    }
  }

  const path = splitPathFromURL(req.url);

  return {
    method: req.method === 'HEAD' ? 'GET' : (req.method as CoreRequest['method']),
    path,
    query,
    headers,
    body: req.body,
    rawBody: req.rawBody ?? new Uint8Array(0),
    params: {},
  };
}

function splitPathFromURL(url: string): string {
  const path = url.split('?')[0];
  return path.length > 0 ? path : '/';
}

function renderCoreResponse(res: CoreResponse, reply: FastifyReply): void {
  reply.code(res.status);
  if (res.headers) {
    for (const [k, v] of Object.entries(res.headers)) {
      reply.header(k, v);
    }
  }
  if (res.body === undefined) {
    reply.send();
  } else {
    reply.send(res.body);
  }
}
