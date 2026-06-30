/**
 * `/api/v1/devices` + `/api/v1/pair` routes — the SPA's paired-devices layer.
 *
 * The browser's Paired Devices screen lists the node's paired devices and can
 * mint a pairing code, proxied to core-server via the brain's `CoreClient`.
 * core-server owns the device registry + pairing ceremony; this is the thin
 * HTTP shim the web `BrowserCoreProxyClient` calls. Mobile reads the device
 * registry in-process.
 *
 *   GET  /api/v1/devices/list   → CoreClient.listPairedDevices → { devices }
 *   POST /api/v1/pair/initiate  → CoreClient.pairInitiate(name, role) → PairInitiateResult
 *
 * Both core routes admit the `brain` caller (authz.ts `/v1/devices/list` +
 * `/v1/pair/initiate`), so this signed proxy hop is authorized. Core failure →
 * 502. Device REVOKE + register stay admin-only on core and are not proxied
 * here (the browser session is not an admin credential — see web/SECURITY.md).
 */

import type { CoreClient, DeviceRole } from '@dina/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterDeviceApiRoutesOptions {
  /** Brain→Core client (signed HTTP to core-server). */
  core: CoreClient;
  /** Route prefix override (defaults to `/api/v1`). */
  prefix?: string;
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface PairInitiateBody {
  device_name?: unknown;
  role?: unknown;
}

// Mirrors the `DeviceRole` union in core (`devices/registry`). Validated here so
// a bogus role 400s at the proxy instead of surfacing as a wrapped core error.
const VALID_ROLES: ReadonlySet<string> = new Set(['rich', 'thin', 'cli', 'agent']);

export function registerDeviceApiRoutes(
  app: FastifyInstance,
  opts: RegisterDeviceApiRoutesOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const { core } = opts;

  // GET /api/v1/devices/list — paired devices for this node.
  app.get(`${prefix}/devices/list`, async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const devices = await core.listPairedDevices();
      return reply.status(200).send({ devices });
    } catch (err) {
      return reply.status(502).send({ error: asError(err) });
    }
  });

  // POST /api/v1/pair/initiate — mint a one-time pairing code for a new device.
  app.post(
    `${prefix}/pair/initiate`,
    async (req: FastifyRequest<{ Body: PairInitiateBody }>, reply: FastifyReply) => {
      const body = (req.body ?? {}) as PairInitiateBody;
      const deviceName = typeof body.device_name === 'string' ? body.device_name.trim() : '';
      if (deviceName === '') {
        return reply.status(400).send({ error: 'device_name is required' });
      }
      if (typeof body.role !== 'string' || !VALID_ROLES.has(body.role)) {
        return reply.status(400).send({ error: 'role must be one of: rich, thin, cli, agent' });
      }
      try {
        const result = await core.pairInitiate(deviceName, body.role as DeviceRole);
        return reply.status(200).send(result);
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );
}
