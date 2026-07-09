/**
 * `/api/v1/contacts` route — the SPA's contact-directory data layer.
 *
 * The contact directory lives in core-server's process. The web People/Talk
 * screen's `useContacts` reads it, but in the thin-client the in-process
 * directory is empty, so it must fetch from Core. Same proxy shape as the
 * reminders/workflow routes. Mobile bypasses this (Core in-process).
 *
 *   GET    /api/v1/contacts       → CoreClient.listContacts
 *   DELETE /api/v1/contacts/:did  → CoreClient.removeContact
 */

import type { CoreClient, Contact } from '@dina/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterContactApiRoutesOptions {
  core: CoreClient;
  prefix?: string;
}

export function registerContactApiRoutes(
  app: FastifyInstance,
  opts: RegisterContactApiRoutesOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const { core } = opts;

  app.get(`${prefix}/contacts`, async (_req, reply: FastifyReply) => {
    try {
      const contacts: Contact[] = await core.listContacts();
      return reply.status(200).send({ contacts });
    } catch (err) {
      return reply
        .status(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // DELETE /api/v1/contacts/:did — remove a contact from the AUTHORITATIVE Core
  // directory, so the web thin-client's People delete actually sticks (a local
  // delete on web is reverted by the next Core-backed refresh). Idempotent:
  // `deleted=false` when the DID wasn't a contact.
  app.delete(
    `${prefix}/contacts/:did`,
    async (req: FastifyRequest<{ Params: { did: string } }>, reply: FastifyReply) => {
      const did = typeof req.params.did === 'string' ? req.params.did.trim() : '';
      if (did === '') return reply.status(400).send({ error: 'did is required' });
      try {
        const deleted = await core.removeContact(did);
        return reply.status(200).send({ deleted });
      } catch (err) {
        return reply
          .status(502)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
