/**
 * `/api/v1/pair/initiate` + `/api/v1/devices` routes — the SPA's agent
 * pairing + connected-agents layer (web thin-client agent integration).
 *
 * The browser's "Settings → Agents" screen mints a pairing code and lists
 * connected agents through the brain-server, which proxies to core-server
 * via its `CoreClient`. core-server owns the pairing ceremony + device
 * registry; this is the thin shim the web `BrowserCoreProxyClient` calls.
 * Mobile mints/lists in-process. The agent itself completes pairing by
 * calling core's `/v1/pair/complete` over MsgBox directly (not through
 * this brain surface).
 *
 *   POST /api/v1/pair/initiate  { deviceName, role } → CoreClient.pairInitiate
 *   GET  /api/v1/devices                              → CoreClient.listPairedDevices
 *
 * SECURITY: minting a pairing code is an authority-bearing op (it can
 * onboard a new device). It is gated by the D4 web access gate (only the
 * served SPA carries the session cookie) and the brain allowlist now
 * covers `/v1/pair/initiate`. See `authz.ts` for the residual-risk note.
 * Core failure → 502.
 */

import type { CoreClient, DeviceRole } from '@dina/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterAgentApiRoutesOptions {
  /** Brain→Core client (signed HTTP to core-server). */
  core: CoreClient;
  /** Route prefix override (defaults to `/api/v1`). */
  prefix?: string;
}

const VALID_ROLES = new Set<DeviceRole>(['rich', 'thin', 'cli', 'agent']);

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerAgentApiRoutes(
  app: FastifyInstance,
  opts: RegisterAgentApiRoutesOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const { core } = opts;

  // POST /api/v1/pair/initiate — mint a pairing code for an upcoming agent.
  app.post(
    `${prefix}/pair/initiate`,
    async (
      req: FastifyRequest<{ Body: { deviceName?: unknown; role?: unknown } }>,
      reply: FastifyReply,
    ) => {
      const deviceName =
        typeof req.body?.deviceName === 'string' ? req.body.deviceName.trim() : '';
      const role = typeof req.body?.role === 'string' ? req.body.role : 'agent';
      if (deviceName === '') {
        return reply.status(400).send({ error: 'deviceName is required' });
      }
      if (!VALID_ROLES.has(role as DeviceRole)) {
        return reply
          .status(400)
          .send({ error: `role must be one of: ${[...VALID_ROLES].join(', ')}` });
      }
      try {
        const result = await core.pairInitiate(deviceName, role as DeviceRole);
        return reply.status(200).send(result);
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // GET /api/v1/devices — list connected agents/devices (read-only).
  app.get(`${prefix}/devices`, async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const devices = await core.listPairedDevices();
      return reply.status(200).send({ devices });
    } catch (err) {
      return reply.status(502).send({ error: asError(err) });
    }
  });
}
