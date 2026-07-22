/**
 * `/api/v1/service/config` routes — the SPA's My-Services (service publish)
 * data layer.
 *
 * The service config (a provider's published listing) lives in core-server's
 * process. The web My-Services screen's `useServiceConfigForm` reads/writes it
 * via a `ServiceConfigCoreClient`, but in the thin-client the in-process Core
 * store is empty, so it must go through Core. `/v1/service/*` is a `brain`-
 * allowed route, so — unlike the owner-only `/v1/watch/*` and `/v1/run/*`
 * surfaces — the Brain may forward these on the SPA's behalf (signed as brain).
 * Mobile bypasses this (Core in-process). Same proxy shape as `contacts.ts`.
 *
 *   GET    /api/v1/service/configs        → CoreClient.listServiceConfigs
 *   GET    /api/v1/service/config         → CoreClient.serviceConfig('self')
 *   GET    /api/v1/service/config/:rkey   → CoreClient.serviceConfig(rkey)
 *   PUT    /api/v1/service/config         → CoreClient.putServiceConfig(body)
 *   PUT    /api/v1/service/config/:rkey   → CoreClient.putServiceConfig(body, rkey)
 *   DELETE /api/v1/service/config/:rkey   → CoreClient.deleteServiceConfig(rkey)
 */

import type { CoreClient, ServiceConfig } from '@dina/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterServiceConfigProxyOptions {
  core: CoreClient;
  prefix?: string;
}

export function registerServiceConfigProxyRoutes(
  app: FastifyInstance,
  opts: RegisterServiceConfigProxyOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const { core } = opts;
  const fail = (reply: FastifyReply, err: unknown): FastifyReply =>
    reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });

  app.get(`${prefix}/service/configs`, async (_req, reply: FastifyReply) => {
    try {
      return reply.status(200).send({ listings: await core.listServiceConfigs() });
    } catch (err) {
      return fail(reply, err);
    }
  });

  const getOne = async (rkey: string | undefined, reply: FastifyReply): Promise<FastifyReply> => {
    try {
      const cfg = await core.serviceConfig(rkey);
      // `null` = no listing at this rkey; surface 404 so the web client returns
      // null (its "not published yet" state) rather than treating it as an error.
      if (cfg === null) return reply.status(404).send({ error: 'service_config: not set' });
      return reply.status(200).send(cfg);
    } catch (err) {
      return fail(reply, err);
    }
  };
  app.get(`${prefix}/service/config`, async (_req, reply) => getOne(undefined, reply));
  app.get(
    `${prefix}/service/config/:rkey`,
    async (req: FastifyRequest<{ Params: { rkey: string } }>, reply) =>
      getOne(req.params.rkey, reply),
  );

  const put = async (
    rkey: string | undefined,
    body: unknown,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    if (body === null || typeof body !== 'object') {
      return reply.status(400).send({ error: 'service config body is required' });
    }
    try {
      await core.putServiceConfig(body as ServiceConfig, rkey);
      return reply.status(200).send({ ok: true });
    } catch (err) {
      // A validation rejection from Core is the caller's fault (400), not a
      // gateway failure — surface its message so the form can show it.
      const msg = err instanceof Error ? err.message : String(err);
      const status = /invalid|validation|catalog|capabilit|schema|rkey/i.test(msg) ? 400 : 502;
      return reply.status(status).send({ error: msg });
    }
  };
  app.put(`${prefix}/service/config`, async (req, reply) => put(undefined, req.body, reply));
  app.put(
    `${prefix}/service/config/:rkey`,
    async (req: FastifyRequest<{ Params: { rkey: string } }>, reply) =>
      put(req.params.rkey, req.body, reply),
  );

  app.delete(
    `${prefix}/service/config/:rkey`,
    async (req: FastifyRequest<{ Params: { rkey: string } }>, reply) => {
      const rkey = typeof req.params.rkey === 'string' ? req.params.rkey.trim() : '';
      if (rkey === '') return reply.status(400).send({ error: 'rkey is required' });
      try {
        await core.deleteServiceConfig(rkey);
        return reply.status(200).send({ ok: true });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
}
