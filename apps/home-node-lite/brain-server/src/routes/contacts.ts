/**
 * `/api/v1/contacts[...]` routes — the SPA's contacts layer.
 *
 * The browser's People tab + add-contact flow read/write the node's contact
 * directory through the brain-server, which proxies to core-server via its
 * `CoreClient`. core-server owns the directory (people-graph + policy + D2D
 * projections); this is the thin HTTP shim the web `BrowserCoreProxyClient`
 * calls. Mobile uses the in-process directory module-globals directly.
 *
 *   GET    /api/v1/contacts                  → CoreClient.contactList         → { contacts }
 *   POST   /api/v1/contacts                  → CoreClient.contactAdd          → { contact, created }
 *   DELETE /api/v1/contacts/:did             → CoreClient.contactDelete       → { deleted }
 *   PUT    /api/v1/contacts/:did             → CoreClient.updateContact       → { ok: true }
 *   GET    /api/v1/contacts/lookup?q=…       → CoreClient.contactLookup       → { contact|null }
 *   GET    /api/v1/contacts/by-preference?category=… → findContactsByPreference → { contacts }
 *
 * Path shapes mirror the core routes; Core failure → 502. core-server stays the
 * directory authority — the proxy does NO contact logic of its own.
 */

import type { CoreClient, TrustLevel } from '@dina/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterContactsApiRoutesOptions {
  /** Brain→Core client (signed HTTP to core-server). */
  core: CoreClient;
  /** Route prefix override (defaults to `/api/v1`). */
  prefix?: string;
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface AddContactBody {
  did?: unknown;
  display_name?: unknown;
  trust_level?: unknown;
}

interface UpdateContactBody {
  preferred_for?: unknown;
}

export function registerContactsApiRoutes(
  app: FastifyInstance,
  opts: RegisterContactsApiRoutesOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const { core } = opts;

  // GET /api/v1/contacts — every contact in the directory.
  app.get(`${prefix}/contacts`, async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const contacts = await core.contactList();
      return reply.status(200).send({ contacts });
    } catch (err) {
      return reply.status(502).send({ error: asError(err) });
    }
  });

  // GET /api/v1/contacts/lookup?q=… — resolve one contact (DID / name / alias).
  // Declared before the `:did` routes so the static path always wins.
  app.get(
    `${prefix}/contacts/lookup`,
    async (req: FastifyRequest<{ Querystring: { q?: string } }>, reply: FastifyReply) => {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      try {
        const contact = await core.contactLookup(q);
        return reply.status(200).send({ contact });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // GET /api/v1/contacts/by-preference?category=… — contacts preferred for a role.
  app.get(
    `${prefix}/contacts/by-preference`,
    async (req: FastifyRequest<{ Querystring: { category?: string } }>, reply: FastifyReply) => {
      const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
      if (category === '') {
        return reply.status(400).send({ error: 'category query parameter is required' });
      }
      try {
        const contacts = await core.findContactsByPreference(category);
        return reply.status(200).send({ contacts });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // POST /api/v1/contacts — add (idempotent) a contact by DID.
  app.post(
    `${prefix}/contacts`,
    async (req: FastifyRequest<{ Body: AddContactBody }>, reply: FastifyReply) => {
      const body = (req.body ?? {}) as AddContactBody;
      const did = typeof body.did === 'string' ? body.did.trim() : '';
      if (did === '') {
        return reply.status(400).send({ error: 'did is required' });
      }
      if (body.trust_level !== undefined && typeof body.trust_level !== 'string') {
        return reply.status(400).send({ error: 'trust_level must be a string when present' });
      }
      const displayName = typeof body.display_name === 'string' ? body.display_name : '';
      // A non-empty *string* trust_level is validated against the real enum by
      // core-server (`isTrustLevel`); a bogus value surfaces as the core 400
      // (wrapped 502 here). The proxy stays the directory's non-authority.
      const trustLevel =
        typeof body.trust_level === 'string' ? (body.trust_level as TrustLevel) : undefined;
      try {
        // core-server validates trust_level against the real enum (400) and owns
        // the directory write; the proxy forwards verbatim.
        const result = await core.contactAdd(did, displayName, trustLevel);
        return reply.status(200).send(result);
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // PUT /api/v1/contacts/:did — update mutable contact fields (preferred_for).
  app.put(
    `${prefix}/contacts/:did`,
    async (
      req: FastifyRequest<{ Params: { did: string }; Body: UpdateContactBody }>,
      reply: FastifyReply,
    ) => {
      const body = (req.body ?? {}) as UpdateContactBody;
      const updates: { preferredFor?: string[] } = {};
      if (body.preferred_for !== undefined) {
        if (
          !Array.isArray(body.preferred_for) ||
          body.preferred_for.some((c) => typeof c !== 'string')
        ) {
          return reply.status(400).send({ error: 'preferred_for must be an array of strings' });
        }
        updates.preferredFor = body.preferred_for as string[];
      }
      try {
        await core.updateContact(req.params.did, updates);
        return reply.status(200).send({ ok: true });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // DELETE /api/v1/contacts/:did — remove a contact (idempotent).
  app.delete(
    `${prefix}/contacts/:did`,
    async (req: FastifyRequest<{ Params: { did: string } }>, reply: FastifyReply) => {
      try {
        const deleted = await core.contactDelete(req.params.did);
        return reply.status(200).send({ deleted });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );
}
