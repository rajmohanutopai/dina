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
 * several ways:
 *   1. Off by default. Only `DINA_DEBUG_MODE=1` registers it, and the
 *      release build-env sanity check (MT-45) should flag the flag being
 *      set in a store/prod build.
 *   2. Release fail-closed. `boot.ts` REFUSES TO BOOT if the flag is set
 *      with release endpoints, so the route can never exist on a production
 *      node even if the flag leaks in.
 *   3. Loopback only. Non-loopback peers get 403 — it never serves a
 *      remote client even if the port is exposed.
 *   4. Optional `x-debug-token` shared secret. When `DINA_DEBUG_TOKEN` is
 *      set, requests must carry a matching token (constant-time compared).
 *      This defends the reverse-proxy case where a remote caller's `req.ip`
 *      can appear loopback — the loopback check alone wouldn't stop them.
 *   5. The `trustedInProcess` marker is unforgeable over HTTP: the normal
 *      Fastify→Core adapter (`bind_core_router`) never sets it, so a
 *      regular signed/unsigned HTTP request can't reach owner dispatch.
 *      Only this route, running in-process, stamps it.
 */

import { timingSafeEqual } from 'node:crypto';

import { quarantineMessage, type CoreRouter, type CoreRequest } from '@dina/core';
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

/** Constant-time string compare (length-safe — unequal lengths short-circuit). */
function tokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Register the debug dispatch route. Call ONLY when DINA_DEBUG_MODE=1. */
export function registerDebugDispatch(app: DebugApp, coreRouter: CoreRouter, logger: Logger): void {
  // Optional shared-secret gate: when DINA_DEBUG_TOKEN is set, every request
  // must carry a matching `x-debug-token` header. This closes the gap where a
  // local reverse proxy makes a remote caller's `req.ip` look loopback — the
  // loopback check alone wouldn't stop them, but they can't forge the token.
  const expectedToken = process.env.DINA_DEBUG_TOKEN ?? '';
  logger.warn(
    expectedToken !== ''
      ? 'DINA_DEBUG_MODE=1 — registering UNAUTHENTICATED POST /v1/debug/dispatch (loopback + x-debug-token). Never enable in production.'
      : 'DINA_DEBUG_MODE=1 — registering UNAUTHENTICATED POST /v1/debug/dispatch (loopback only; set DINA_DEBUG_TOKEN to require a token). Never enable in production.',
  );

  app.post('/v1/debug/dispatch', async (req, reply) => {
    if (!LOOPBACK.has(req.ip)) {
      void reply.code(403).send({ error: 'debug dispatch is loopback-only' });
      return;
    }
    if (expectedToken !== '' && !tokenMatches(req.headers['x-debug-token'], expectedToken)) {
      void reply.code(403).send({ error: 'debug dispatch token required or invalid' });
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

  // Stage "an unknown sender messaged you" WITHOUT a stranger node or the full
  // crypto ceremony — the §8 precondition for MRS-05. Drops a message straight
  // into Core's quarantine store (exactly what the receive pipeline does after
  // deciding `action==='quarantined'` for an unknown-trust sender), so the web
  // InlineQuarantineCard surfaces it and accept/block operate on it for real.
  // Same loopback + token fence as dispatch; debug-mode-only registration.
  app.post('/v1/debug/quarantine-seed', async (req, reply) => {
    if (!LOOPBACK.has(req.ip)) {
      void reply.code(403).send({ error: 'debug quarantine-seed is loopback-only' });
      return;
    }
    if (expectedToken !== '' && !tokenMatches(req.headers['x-debug-token'], expectedToken)) {
      void reply.code(403).send({ error: 'debug token required or invalid' });
      return;
    }
    const b = (req.body ?? {}) as { sender_did?: unknown; message_type?: unknown; body?: unknown };
    const senderDid = typeof b.sender_did === 'string' ? b.sender_did.trim() : '';
    if (senderDid === '') {
      void reply.code(400).send({ error: 'sender_did is required' });
      return;
    }
    const messageType =
      typeof b.message_type === 'string' && b.message_type !== ''
        ? b.message_type
        : 'coordination.request';
    const body = typeof b.body === 'string' ? b.body : JSON.stringify(b.body ?? {});
    const msg = quarantineMessage(senderDid, messageType, body);
    void reply.code(200).send({ quarantined: msg });
  });
}
