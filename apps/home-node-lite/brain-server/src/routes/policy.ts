/**
 * `/api/v1/policy/actions` routes — the SPA's action-risk policy layer.
 *
 * The browser's Settings → Policy screen reads + edits per-action risk
 * levels (e.g. `send_email` → MODERATE) through the brain-server, which
 * proxies to core-server via its `CoreClient`. core-server owns the policy
 * store; this is the thin shim the web `BrowserCoreProxyClient` calls.
 * Mobile drives the in-process policy service directly.
 *
 *   GET    /api/v1/policy/actions          → CoreClient.getActionPolicy
 *   PUT    /api/v1/policy/actions/:action  → CoreClient.setActionRisk  (body { risk })
 *   DELETE /api/v1/policy/actions/:action  → CoreClient.deleteActionOverride
 *
 * Gated behind the D4 web access gate (this whole surface is). Core
 * failure → 502.
 */

import type { CoreClient, RiskLevel } from '@dina/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterPolicyApiRoutesOptions {
  /** Brain→Core client (signed HTTP to core-server). */
  core: CoreClient;
  /** Route prefix override (defaults to `/api/v1`). */
  prefix?: string;
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerPolicyApiRoutes(
  app: FastifyInstance,
  opts: RegisterPolicyApiRoutesOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const { core } = opts;

  // GET /api/v1/policy/actions — the merged action-risk policy.
  app.get(`${prefix}/policy/actions`, async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const policy = await core.getActionPolicy();
      return reply.status(200).send(policy);
    } catch (err) {
      return reply.status(502).send({ error: asError(err) });
    }
  });

  // PUT /api/v1/policy/actions/:action — set one action's risk level.
  app.put(
    `${prefix}/policy/actions/:action`,
    async (
      // `risk` is untrusted wire input — validate it's a non-empty string,
      // then pass to Core (which is the authority on valid RiskLevel values).
      req: FastifyRequest<{ Params: { action: string }; Body: { risk?: unknown } }>,
      reply: FastifyReply,
    ) => {
      const action = req.params.action.trim();
      const risk = req.body?.risk;
      if (action === '') {
        return reply.status(400).send({ error: 'action path parameter is required' });
      }
      if (typeof risk !== 'string' || risk === '') {
        return reply.status(400).send({ error: 'risk is required in the body' });
      }
      try {
        const entry = await core.setActionRisk(action, risk as RiskLevel);
        return reply.status(200).send(entry);
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // DELETE /api/v1/policy/actions/:action — drop a per-action override.
  app.delete(
    `${prefix}/policy/actions/:action`,
    async (req: FastifyRequest<{ Params: { action: string } }>, reply: FastifyReply) => {
      const action = req.params.action.trim();
      if (action === '') {
        return reply.status(400).send({ error: 'action path parameter is required' });
      }
      try {
        await core.deleteActionOverride(action);
        return reply.status(200).send({ deleted: true });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );
}
