/**
 * `/api/v1/identity` route — the SPA's node-identity data layer.
 *
 * The browser SPA is a thin client of this brain-server (same origin as
 * the served bundle). It cannot reach core-server directly, so it asks
 * the brain-server "who is this node?" and the brain-server proxies the
 * call to core-server through its `CoreClient` (`HttpCoreTransport`).
 * core-server is the single source of truth for identity (it holds the
 * seed + PDS credentials); this is a thin read-only shim, exactly the
 * shape of the reminder/chat proxy routes. Mobile bypasses all of this —
 * it runs Core in-process and reads `getNodeIdentity()` directly.
 *
 *   GET /api/v1/identity → CoreClient.identity() → `{ did, handle }`
 *
 * Only the public DID + handle cross the wire; the PDS password / email /
 * seed never leave core-server. (Web thin-client design §4.2.)
 */

import type { CoreClient } from '@dina/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterIdentityApiRoutesOptions {
  /** Brain→Core client (signed HTTP to core-server). */
  core: CoreClient;
  /** Route prefix override (defaults to `/api/v1`). */
  prefix?: string;
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerIdentityApiRoutes(
  app: FastifyInstance,
  opts: RegisterIdentityApiRoutesOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const { core } = opts;

  // GET /api/v1/identity → this node's public DID + handle.
  app.get(`${prefix}/identity`, async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await core.identity();
      return reply.status(200).send(identity);
    } catch (err) {
      return reply.status(502).send({ error: asError(err) });
    }
  });
}
