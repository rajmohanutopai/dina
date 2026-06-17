/**
 * `/api/v1/service/config[s]` routes — the SPA's service-listing layer.
 *
 * The browser's listings/Services settings form reads + writes the node's
 * published service configs through the brain-server, which proxies to
 * core-server via its `CoreClient`. core-server owns the service-config
 * store + the AppView publish pipeline; this is the thin HTTP shim the
 * web `BrowserCoreProxyClient` calls. Mobile uses the in-process
 * service-config repo directly.
 *
 *   GET    /api/v1/service/configs        → CoreClient.listServiceConfigs
 *   GET    /api/v1/service/config         → CoreClient.serviceConfig()    (self; 404 → null)
 *   GET    /api/v1/service/config/:rkey   → CoreClient.serviceConfig(rkey)(404 → null)
 *   PUT    /api/v1/service/config         → CoreClient.putServiceConfig(body)        (self)
 *   PUT    /api/v1/service/config/:rkey   → CoreClient.putServiceConfig(body, rkey)
 *   DELETE /api/v1/service/config/:rkey   → CoreClient.deleteServiceConfig(rkey)
 *
 * Path shapes mirror the core routes exactly so the proxy is a pure pass
 * through; Core failure → 502.
 */

import type { CoreClient, ServiceConfig } from '@dina/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterServiceConfigApiRoutesOptions {
  /** Brain→Core client (signed HTTP to core-server). */
  core: CoreClient;
  /** Route prefix override (defaults to `/api/v1`). */
  prefix?: string;
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerServiceConfigApiRoutes(
  app: FastifyInstance,
  opts: RegisterServiceConfigApiRoutesOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const { core } = opts;

  // GET /api/v1/service/configs — all listings for this node.
  app.get(`${prefix}/service/configs`, async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const listings = await core.listServiceConfigs();
      return reply.status(200).send({ listings });
    } catch (err) {
      return reply.status(502).send({ error: asError(err) });
    }
  });

  // GET /api/v1/service/config — the `self` listing (404 → null).
  app.get(`${prefix}/service/config`, async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const config = await core.serviceConfig();
      if (config === null) return reply.status(404).send({ error: 'no service config' });
      return reply.status(200).send(config);
    } catch (err) {
      return reply.status(502).send({ error: asError(err) });
    }
  });

  // GET /api/v1/service/config/:rkey — a per-listing config (404 → null).
  app.get(
    `${prefix}/service/config/:rkey`,
    async (req: FastifyRequest<{ Params: { rkey: string } }>, reply: FastifyReply) => {
      try {
        const config = await core.serviceConfig(req.params.rkey);
        if (config === null) return reply.status(404).send({ error: 'no service config' });
        return reply.status(200).send(config);
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // PUT /api/v1/service/config — upsert the `self` listing.
  app.put(
    `${prefix}/service/config`,
    async (req: FastifyRequest<{ Body: ServiceConfig }>, reply: FastifyReply) => {
      try {
        await core.putServiceConfig((req.body ?? {}) as ServiceConfig);
        return reply.status(200).send({ ok: true });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // PUT /api/v1/service/config/:rkey — upsert a per-listing config.
  app.put(
    `${prefix}/service/config/:rkey`,
    async (
      req: FastifyRequest<{ Params: { rkey: string }; Body: ServiceConfig }>,
      reply: FastifyReply,
    ) => {
      try {
        await core.putServiceConfig((req.body ?? {}) as ServiceConfig, req.params.rkey);
        return reply.status(200).send({ ok: true });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // DELETE /api/v1/service/config/:rkey — remove a per-listing config.
  app.delete(
    `${prefix}/service/config/:rkey`,
    async (req: FastifyRequest<{ Params: { rkey: string } }>, reply: FastifyReply) => {
      try {
        await core.deleteServiceConfig(req.params.rkey);
        return reply.status(200).send({ deleted: true });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );
}
