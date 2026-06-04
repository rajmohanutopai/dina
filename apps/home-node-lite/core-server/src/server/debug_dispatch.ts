/**
 * Debug control channel — TEST / DEV ONLY.
 *
 * Gated behind `DINA_DEBUG_MODE=1` (default OFF). Exposes a single route:
 *
 *   POST /v1/debug/dispatch  { method, path, query?, body? }
 *
 * which runs the given request through the Core router as the in-process
 * OWNER (`trustedInProcess: true` → the auth pipeline is skipped), then
 * returns `{ status, body }`. This lets an automated test harness drive a
 * real, fully-booted node — add a contact, store a memory, send a D2D
 * "Talk", read reminders — over loopback WITHOUT the Ed25519 signing
 * ceremony. It's the headless equivalent of the mobile app driving its
 * own in-process Core.
 *
 * SECURITY — this deliberately bypasses authentication, so it is fenced
 * three ways:
 *   1. Off by default. Only `DINA_DEBUG_MODE=1` registers it, and the
 *      release build-env sanity check (MT-45) should flag the flag being
 *      set in a store/prod build.
 *   2. Loopback only. Non-loopback peers get 403 — it never serves a
 *      remote client even if the port is exposed.
 *   3. The `trustedInProcess` marker is unforgeable over HTTP: the normal
 *      Fastify→Core adapter (`bind_core_router`) never sets it, so a
 *      regular signed/unsigned HTTP request can't reach owner dispatch.
 *      Only this route, running in-process, stamps it.
 */

import type { CoreRouter, CoreRequest } from '@dina/core';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Logger } from '../logger';

/**
 * Minimal structural type for the Fastify app — avoids the
 * `FastifyInstance` logger-generic mismatch with the server's custom
 * logger (same approach as `bind_core_router`).
 */
interface DebugApp {
  post(
    path: string,
    handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void> | void,
  ): unknown;
}

interface DebugDispatchBody {
  method?: unknown;
  path?: unknown;
  query?: unknown;
  body?: unknown;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Register the debug dispatch route. Call ONLY when DINA_DEBUG_MODE=1. */
export function registerDebugDispatch(app: DebugApp, coreRouter: CoreRouter, logger: Logger): void {
  logger.warn(
    'DINA_DEBUG_MODE=1 — registering UNAUTHENTICATED POST /v1/debug/dispatch (loopback only). Never enable in production.',
  );

  app.post('/v1/debug/dispatch', async (req, reply) => {
    if (!LOOPBACK.has(req.ip)) {
      void reply.code(403).send({ error: 'debug dispatch is loopback-only' });
      return;
    }
    const b = (req.body ?? {}) as DebugDispatchBody;
    const method = typeof b.method === 'string' ? b.method.toUpperCase() : '';
    const path = typeof b.path === 'string' ? b.path : '';
    if (method === '' || path === '') {
      void reply.code(400).send({ error: 'method and path are required' });
      return;
    }

    const query: Record<string, string> = {};
    if (b.query !== null && typeof b.query === 'object') {
      for (const [k, v] of Object.entries(b.query as Record<string, unknown>)) {
        query[k] = String(v);
      }
    }
    const rawBody =
      b.body !== undefined ? new TextEncoder().encode(JSON.stringify(b.body)) : new Uint8Array(0);

    const coreReq: CoreRequest = {
      method: method as CoreRequest['method'],
      path,
      query,
      headers: { 'content-type': 'application/json' },
      body: b.body,
      rawBody,
      params: {},
      trustedInProcess: true,
    };

    const res = await coreRouter.handle(coreReq);
    void reply.code(res.status).send(res.body === undefined ? {} : res.body);
  });
}
