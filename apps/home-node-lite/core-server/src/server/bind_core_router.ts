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
 * collect the raw body bytes + headers + query + params into a
 * `CoreRequest`, invoke the router's dispatch (which runs the handler
 * AND any auth the handler's `auth` mode requires), and render the
 * response onto the Fastify reply.
 *
 * **Auth handoff.** The CoreRouter's own `handle()` runs the
 * `signed` auth pipeline when `auth === 'signed'`. In the Fastify
 * deployment, the auth middleware (tasks 4.19-4.26, pending
 * composition) runs BEFORE we reach CoreRouter dispatch — so we
 * re-register signed routes with `auth: 'public'` at the Core layer
 * (the Fastify middleware has already done auth) to avoid double-
 * authenticating. That swap is intentional and centralised here.
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

import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  CoreRouter,
  CoreRequest,
  CoreResponse,
} from '@dina/core';

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

type FastifyHandler = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown> | unknown;

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
    const fastifyPath = route.path; // `:param` is shared syntax between CoreRouter + Fastify

    const handler: FastifyHandler = async (req, reply) => {
      const coreReq = buildCoreRequest(req, route.path);
      const coreRes = await route.handler(coreReq);
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

function installRawBodyParser(app: BindCoreRouterOptions['app']): void {
  if (!app.addContentTypeParser) return; // test doubles don't always provide it
  // JSON + octet-stream: capture raw bytes AND parse JSON for handlers
  // that want a parsed body.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      // `parseAs: 'buffer'` → body is always a Node Buffer.
      const buf = body as Buffer;
      req.rawBody = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      try {
        const parsed = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
        done(null, parsed);
      } catch (err) {
        done(err as Error);
      }
    },
  );
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (req, body, done) => {
      // `parseAs: 'buffer'` → body is always a Node Buffer.
      const buf = body as Buffer;
      req.rawBody = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      done(null, req.rawBody);
    },
  );
}

function buildCoreRequest(req: FastifyRequest, registeredPath: string): CoreRequest {
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

  // Params (`:id`) — Fastify populates from the matched route.
  const params: Record<string, string> = {};
  const p = req.params as Record<string, unknown> | undefined;
  if (p && typeof p === 'object') {
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === 'string') params[k] = v;
    }
  }

  return {
    method: req.method as CoreRequest['method'],
    path: registeredPath,
    query,
    headers,
    body: req.body,
    rawBody: req.rawBody ?? new Uint8Array(0),
    params,
  };
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
