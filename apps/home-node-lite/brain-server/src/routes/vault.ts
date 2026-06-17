/**
 * `/api/v1/vault/*` routes — the SPA's vault data layer.
 *
 * In lite the vault lives in core-server's process (the SQLCipher
 * repositories). The browser SPA can't open SQLite, so it talks to the
 * brain-server (same origin as the served bundle), which proxies each
 * call to core-server through its `CoreClient` (`HttpCoreTransport`).
 * Exactly the shape of the reminder/identity routes — a thin HTTP shim
 * over a layer Core already owns; core-server runs the real persona
 * gatekeeper + crypto. Mobile bypasses all of this (Core in-process; it
 * calls the vault repositories directly via the native transport seam).
 *
 *   POST   /api/v1/vault/query?persona=…    → CoreClient.vaultQuery
 *   GET    /api/v1/vault/item/:id?persona=… → CoreClient.vaultGet (404 → null)
 *   POST   /api/v1/vault/store?persona=…    → CoreClient.vaultStore
 *   GET    /api/v1/vault/list?persona=…     → CoreClient.vaultList
 *   GET    /api/v1/vault/subjects?persona=… → CoreClient.vaultItemsForPerson
 *   DELETE /api/v1/vault/item/:id?persona=… → CoreClient.vaultDelete
 *
 * Persona is always a required query param (matches the core routes);
 * the brain proxy 400s when it's missing and 502s when Core is
 * unreachable. It does NOT re-implement authorization — core-server is
 * the authority on persona tiers + session grants.
 */

import type {
  CoreClient,
  VaultItemInput,
  VaultListOptions,
  VaultQuery,
} from '@dina/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterVaultApiRoutesOptions {
  /** Brain→Core client (signed HTTP to core-server). */
  core: CoreClient;
  /** Route prefix override (defaults to `/api/v1`). */
  prefix?: string;
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read + trim a required `persona` query param, or null when absent. */
function requirePersona(req: FastifyRequest<{ Querystring: { persona?: string } }>): string | null {
  const persona = typeof req.query.persona === 'string' ? req.query.persona.trim() : '';
  return persona === '' ? null : persona;
}

/**
 * Parse a non-negative integer query param. Returns null for absent,
 * empty, non-numeric, or negative input so a bogus `?limit=abc` is
 * dropped (lets Core apply its own default) rather than forwarded as NaN.
 */
function parsePositiveInt(raw: string | undefined): number | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

interface VaultQueryBody {
  text?: unknown;
  mode?: unknown;
  limit?: unknown;
  embedding?: unknown;
  type?: unknown;
}

export function registerVaultApiRoutes(
  app: FastifyInstance,
  opts: RegisterVaultApiRoutesOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const { core } = opts;

  // POST /api/v1/vault/query?persona=… — hybrid (FTS5 + semantic) search.
  app.post(
    `${prefix}/vault/query`,
    async (
      req: FastifyRequest<{ Querystring: { persona?: string }; Body: VaultQueryBody }>,
      reply: FastifyReply,
    ) => {
      const persona = requirePersona(req);
      if (persona === null) {
        return reply.status(400).send({ error: 'persona query parameter is required' });
      }
      const body = (req.body ?? {}) as VaultQueryBody;
      const query: VaultQuery = {};
      if (typeof body.text === 'string') query.text = body.text;
      if (typeof body.mode === 'string') query.mode = body.mode as VaultQuery['mode'];
      if (typeof body.limit === 'number') query.limit = body.limit;
      if (Array.isArray(body.embedding)) query.embedding = body.embedding as number[];
      if (typeof body.type === 'string') query.type = body.type;
      try {
        const result = await core.vaultQuery(persona, query);
        return reply.status(200).send(result);
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // GET /api/v1/vault/item/:id?persona=… — single item (404 → not found).
  app.get(
    `${prefix}/vault/item/:id`,
    async (
      req: FastifyRequest<{ Params: { id: string }; Querystring: { persona?: string } }>,
      reply: FastifyReply,
    ) => {
      const persona = requirePersona(req);
      if (persona === null) {
        return reply.status(400).send({ error: 'persona query parameter is required' });
      }
      try {
        const item = await core.vaultGet(persona, req.params.id);
        if (item === null) {
          return reply.status(404).send({ error: 'item not found' });
        }
        return reply.status(200).send(item);
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // POST /api/v1/vault/store?persona=… — insert/upsert. Body is the item.
  app.post(
    `${prefix}/vault/store`,
    async (
      req: FastifyRequest<{ Querystring: { persona?: string }; Body: VaultItemInput }>,
      reply: FastifyReply,
    ) => {
      const persona = requirePersona(req);
      if (persona === null) {
        return reply.status(400).send({ error: 'persona query parameter is required' });
      }
      try {
        const result = await core.vaultStore(persona, (req.body ?? {}) as VaultItemInput);
        return reply.status(200).send(result);
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // GET /api/v1/vault/list?persona=…&limit=&offset=&type= — paginate.
  app.get(
    `${prefix}/vault/list`,
    async (
      req: FastifyRequest<{
        Querystring: { persona?: string; limit?: string; offset?: string; type?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const persona = requirePersona(req);
      if (persona === null) {
        return reply.status(400).send({ error: 'persona query parameter is required' });
      }
      const opts: VaultListOptions = {};
      const limit = parsePositiveInt(req.query.limit);
      if (limit !== null) opts.limit = limit;
      const offset = parsePositiveInt(req.query.offset);
      if (offset !== null) opts.offset = offset;
      if (typeof req.query.type === 'string' && req.query.type !== '') {
        opts.type = req.query.type;
      }
      try {
        const result = await core.vaultList(persona, opts);
        return reply.status(200).send(result);
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // GET /api/v1/vault/subjects?persona=…&person_id=…&limit=… — items a
  // person is a subject of (the structured did→person→subjects edge).
  app.get(
    `${prefix}/vault/subjects`,
    async (
      req: FastifyRequest<{
        Querystring: { persona?: string; person_id?: string; limit?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const persona = requirePersona(req);
      if (persona === null) {
        return reply.status(400).send({ error: 'persona query parameter is required' });
      }
      const personId = typeof req.query.person_id === 'string' ? req.query.person_id.trim() : '';
      if (personId === '') {
        return reply.status(400).send({ error: 'person_id query parameter is required' });
      }
      const limit = parsePositiveInt(req.query.limit) ?? 20;
      try {
        const items = await core.vaultItemsForPerson(persona, personId, limit);
        return reply.status(200).send({ items });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // DELETE /api/v1/vault/item/:id?persona=… — remove (no-op if absent).
  app.delete(
    `${prefix}/vault/item/:id`,
    async (
      req: FastifyRequest<{ Params: { id: string }; Querystring: { persona?: string } }>,
      reply: FastifyReply,
    ) => {
      const persona = requirePersona(req);
      if (persona === null) {
        return reply.status(400).send({ error: 'persona query parameter is required' });
      }
      try {
        const result = await core.vaultDelete(persona, req.params.id);
        return reply.status(200).send(result);
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );
}
