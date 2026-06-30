/**
 * `/api/v1/people[...]` routes — the SPA's people-graph (Relations) layer.
 *
 * The browser's People → Relations tab reads the node's people graph through
 * the brain-server, which proxies to core-server via its `CoreClient`.
 * core-server owns the graph (identities, relationships, merges); this is the
 * thin HTTP shim the web `BrowserCoreProxyClient` calls. Mobile reads the
 * in-process `PeopleRepository` directly.
 *
 *   GET /api/v1/people                 → CoreClient.peopleList         → { people }
 *   GET /api/v1/people/find?surface=…  → CoreClient.peopleFindByName   → { people }
 *   GET /api/v1/people/by-did?did=…    → CoreClient.peopleResolveByDid → { person|null }
 *
 * Read-only. The WRITE path (`peopleApplyExtraction`) is a Brain-internal
 * post-publish extractor, never a web concern, so it is intentionally absent.
 * Core failure → 502.
 */

import type { CoreClient } from '@dina/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterPeopleApiRoutesOptions {
  /** Brain→Core client (signed HTTP to core-server). */
  core: CoreClient;
  /** Route prefix override (defaults to `/api/v1`). */
  prefix?: string;
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerPeopleApiRoutes(
  app: FastifyInstance,
  opts: RegisterPeopleApiRoutesOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const { core } = opts;

  // GET /api/v1/people — every person in the graph.
  app.get(`${prefix}/people`, async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const people = await core.peopleList();
      return reply.status(200).send({ people });
    } catch (err) {
      return reply.status(502).send({ error: asError(err) });
    }
  });

  // GET /api/v1/people/find?surface=… — resolve people by a surface form / name.
  // Declared before any future `:id` route so the static path always wins.
  app.get(
    `${prefix}/people/find`,
    async (req: FastifyRequest<{ Querystring: { surface?: string } }>, reply: FastifyReply) => {
      const surface = typeof req.query.surface === 'string' ? req.query.surface.trim() : '';
      if (surface === '') {
        return reply.status(400).send({ error: 'surface query parameter is required' });
      }
      try {
        const people = await core.peopleFindByName(surface);
        return reply.status(200).send({ people });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // GET /api/v1/people/by-did?did=… — resolve a single person by DID.
  app.get(
    `${prefix}/people/by-did`,
    async (req: FastifyRequest<{ Querystring: { did?: string } }>, reply: FastifyReply) => {
      const did = typeof req.query.did === 'string' ? req.query.did.trim() : '';
      if (did === '') {
        return reply.status(400).send({ error: 'did query parameter is required' });
      }
      try {
        const person = await core.peopleResolveByDid(did);
        return reply.status(200).send({ person });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );
}
