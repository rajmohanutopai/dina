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

import type { CoreClient, Contact, UpdateContactParams } from '@dina/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterContactApiRoutesOptions {
  core: CoreClient;
  prefix?: string;
}

/** The snake_case wire → the `CoreClient` parameters, tri-state preserved. */
function wireToUpdateParams(body: Record<string, unknown>): UpdateContactParams {
  const params: UpdateContactParams = {};
  if (Array.isArray(body.preferred_for)) params.preferredFor = body.preferred_for as string[];
  if (typeof body.legal_name === 'string') params.legalName = body.legal_name;
  if (Array.isArray(body.registrations)) {
    params.registrations = (body.registrations as { scheme?: unknown; value?: unknown }[]).map((row) => ({
      scheme: String(row.scheme ?? ''),
      value: String(row.value ?? ''),
    }));
  }
  if (body.billing_address !== undefined) {
    const wire = body.billing_address as Record<string, unknown> | null;
    params.billingAddress =
      wire === null
        ? null
        : {
            line1: String(wire.line1 ?? ''),
            ...(typeof wire.line2 === 'string' && wire.line2 !== '' ? { line2: wire.line2 } : {}),
            city: String(wire.city ?? ''),
            ...(typeof wire.region === 'string' && wire.region !== '' ? { region: wire.region } : {}),
            ...(typeof wire.postal_code === 'string' && wire.postal_code !== ''
              ? { postalCode: wire.postal_code }
              : {}),
            country: String(wire.country ?? ''),
          };
  }
  if (body.phone !== undefined) params.phone = body.phone === null ? null : String(body.phone);
  if (body.email !== undefined) params.email = body.email === null ? null : String(body.email);
  return params;
}

/** Core's refusal (400 with findings, 404), when the thrown error carries one. */
function readCoreRefusal(err: unknown): { status: number; body: unknown } | null {
  const carrier = err as { status?: unknown; body?: unknown } | null;
  const status = typeof carrier?.status === 'number' ? carrier.status : null;
  if (status === null || status < 400 || status >= 500) return null;
  return { status, body: carrier?.body ?? { error: 'refused' } };
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
  // GET /api/v1/contacts/lookup?q=… — resolve ONE contact from the
  // authoritative Core directory, so a web surface that edits a contact reads
  // what Core holds rather than the thin client's empty in-process copy.
  app.get(
    `${prefix}/contacts/lookup`,
    async (req: FastifyRequest<{ Querystring: { q?: string } }>, reply: FastifyReply) => {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (q === '') return reply.status(400).send({ error: 'q is required' });
      try {
        const contact = await core.contactLookup(q);
        return reply.status(200).send({ contact });
      } catch (err) {
        return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // PUT /api/v1/contacts/:did — the web half of the trade-details capture path
  // (§5.D). Core validates; a refusal comes back with its findings, which the
  // screen renders beside the fields, exactly as on the phone.
  app.put(
    `${prefix}/contacts/:did`,
    async (
      req: FastifyRequest<{ Params: { did: string }; Body: Record<string, unknown> }>,
      reply: FastifyReply,
    ) => {
      const did = typeof req.params.did === 'string' ? req.params.did.trim() : '';
      if (did === '') return reply.status(400).send({ error: 'did is required' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        await core.updateContact(did, wireToUpdateParams(body));
        return reply.status(200).send({ status: 'updated' });
      } catch (err) {
        // Core answers a refusal as an error carrying the status + body; the
        // web surface needs the FINDINGS, not a 502, or the owner sees a blank
        // failure where a field-level correction belongs.
        const refusal = readCoreRefusal(err);
        if (refusal !== null) return reply.status(refusal.status).send(refusal.body);
        return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

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
