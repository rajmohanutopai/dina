/**
 * `/api/v1/d2d/quarantine` routes — the SPA's quarantine-review data layer.
 *
 * Unknown-sender D2D messages are held in core-server's quarantine store. The
 * web InlineQuarantineCard can't read that in-process store, so it talks to the
 * brain-server, which proxies to Core via its CoreClient. accept/block are
 * COMPOUND on Core (un-quarantine/drop + set contact trust), so each is a
 * single call. Mobile bypasses this (Core in-process). F4 / MRS-05.
 *
 *   GET  /api/v1/d2d/quarantine            → CoreClient.listQuarantined
 *   POST /api/v1/d2d/quarantine/accept {…} → CoreClient.acceptQuarantinedSender
 *   POST /api/v1/d2d/quarantine/block  {…} → CoreClient.blockQuarantinedSender
 */

import type { CoreClient, QuarantinedMessage } from '@dina/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterQuarantineApiRoutesOptions {
  core: CoreClient;
  prefix?: string;
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface SenderBody { sender_did?: unknown; sender_label?: unknown }

function readSender(body: SenderBody | undefined): { did: string; label: string } {
  const b = body ?? {};
  return {
    did: typeof b.sender_did === 'string' ? b.sender_did.trim() : '',
    label: typeof b.sender_label === 'string' ? b.sender_label : '',
  };
}

export function registerQuarantineApiRoutes(
  app: FastifyInstance,
  opts: RegisterQuarantineApiRoutesOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const { core } = opts;

  app.get(`${prefix}/d2d/quarantine`, async (_req, reply: FastifyReply) => {
    try {
      const messages: QuarantinedMessage[] = await core.listQuarantined();
      return reply.status(200).send({ messages });
    } catch (err) {
      return reply.status(502).send({ error: asError(err) });
    }
  });

  app.post(
    `${prefix}/d2d/quarantine/accept`,
    async (req: FastifyRequest<{ Body: SenderBody }>, reply: FastifyReply) => {
      const { did, label } = readSender(req.body);
      if (did === '') return reply.status(400).send({ error: 'sender_did is required' });
      try {
        const { released, requarantined } = await core.acceptQuarantinedSender(did, label);
        // Forward `requarantined` (partial-accept count) so the web card can
        // stay unresolved / offer retry instead of falsely claiming success.
        return reply.status(200).send({ released, count: released.length, requarantined });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  app.post(
    `${prefix}/d2d/quarantine/block`,
    async (req: FastifyRequest<{ Body: SenderBody }>, reply: FastifyReply) => {
      const { did, label } = readSender(req.body);
      if (did === '') return reply.status(400).send({ error: 'sender_did is required' });
      try {
        const blockedCount = await core.blockQuarantinedSender(did, label);
        return reply.status(200).send({ blocked_count: blockedCount });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );
}
