/**
 * Tasks 4.63 + 4.67 — Fastify routes for device pairing.
 *
 *   POST /v1/pair/initiate  — operator starts a pairing (returns code)
 *   POST /v1/pair/complete  — device exchanges code for CLIENT_TOKEN
 *   GET  /v1/pair/devices   — list paired devices
 *
 * **Wire parity with Go**:
 *   `initiate` → `{code: string, expires_in: 300}` (seconds).
 *   `complete` → `{device_id, client_token, node_did}`.
 *   `devices`  → `{devices: [{device_id, name, role, created_at,
 *                              last_seen, revoked}, ...]}`.
 *
 * **Flow wiring**: `initiate` asks the `PairingCodeRegistry` (task
 * 4.62) for a fresh code; `complete` redeems that code via the same
 * registry and issues a fresh token + record via the
 * `DeviceTokenRegistry` (task 4.64). The pairing secret from the
 * registry is intentionally NOT exposed over HTTP — the handler
 * exchanges it for a CLIENT_TOKEN server-side so the device only ever
 * sees the short-lived code + the long-lived token.
 *
 * **Why a plain Fastify plugin, not a CoreRouter binding**: pairing is
 * Home-Node-specific (every install needs it, no cross-node RPC).
 * CoreRouter exists for Core↔Brain RPC surface; pairing sits above
 * that. Registering direct Fastify routes keeps the plugin self-
 * contained and the test path trivially `app.inject()`.
 *
 * **Auth note**: `initiate` should be admin-only (CLIENT_TOKEN or
 * passphrase) so a random caller can't mint codes. This module does
 * NOT add that guard — it's applied at the Fastify composition root
 * by the admin-auth middleware (task 4.65+), which the plan sequences
 * separately. The route hooks here are auth-agnostic so the guard
 * wraps cleanly later.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4h tasks 4.63 + 4.67.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  PairingCodeError,
  type PairingCodeRegistry,
} from './pairing_codes';
import {
  DeviceTokenError,
  type DeviceTokenRegistry,
  type DeviceRole,
} from './device_tokens';

export interface PairRoutesOptions {
  /** Code registry — task 4.62. Usually shared via boot DI. */
  pairingCodes: PairingCodeRegistry;
  /** Device token registry — task 4.64. */
  deviceTokens: DeviceTokenRegistry;
  /** The Home Node's DID. Returned to the device so it can address
   *  its owner via D2D. */
  nodeDid: string;
}

/** Shape for POST /v1/pair/complete request body. */
interface CompleteBody {
  code?: unknown;
  device_name?: unknown;
  role?: unknown;
}

/**
 * Structural subset of FastifyInstance that this plugin actually uses.
 * Matches the pattern in `bind_core_router.ts`: avoids coupling to
 * the concrete Fastify generics (which get specialised by our pino
 * logger) so callers can pass any Fastify instance the project produces.
 */
type RouteHandler = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown> | unknown;

export interface FastifyAppShape {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
  delete(path: string, handler: RouteHandler): unknown;
}

export function registerPairRoutes(app: FastifyAppShape, opts: PairRoutesOptions): void {
  const { pairingCodes, deviceTokens, nodeDid } = opts;
  if (!nodeDid) {
    throw new Error('registerPairRoutes: nodeDid is required');
  }

  // -------------------------------------------------------------------------
  // POST /v1/pair/initiate
  //
  // Request body: none (empty object ok).
  // Response 200: { code, expires_in }
  // Response 429: { error: "too many pending pairing codes" }
  // -------------------------------------------------------------------------

  app.post('/v1/pair/initiate', async (_req, reply) => {
    try {
      const { code, record } = pairingCodes.generate();
      const expiresInSec = Math.max(
        0,
        Math.round((record.expiresAtMs - record.createdAtMs) / 1000),
      );
      return { code, expires_in: expiresInSec };
    } catch (err) {
      if (err instanceof PairingCodeError) {
        if (err.reason === 'too_many_pending') {
          await reply.code(429).send({ error: 'too many pending pairing codes' });
          return;
        }
        if (err.reason === 'collision_retries_exhausted') {
          // Astronomically unlikely — 32^8 codes, 5 retries. Surface as
          // 503 so orchestrators can back off briefly.
          await reply.code(503).send({ error: 'could not generate pairing code' });
          return;
        }
      }
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/pair/complete
  //
  // Request body: { code: string, device_name: string, role?: "user" | "agent" }
  // Response 200: { device_id, client_token, node_did }
  // Response 400: invalid body
  // Response 401: invalid or expired code
  // Response 409: code already used
  // -------------------------------------------------------------------------

  app.post('/v1/pair/complete', async (req, reply) => {
    const body = (req.body ?? {}) as CompleteBody;

    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const deviceName =
      typeof body.device_name === 'string' ? body.device_name.trim() : '';
    const rawRole = typeof body.role === 'string' ? body.role.trim() : '';

    if (code.length === 0) {
      await reply.code(400).send({ error: 'code is required' });
      return;
    }
    if (deviceName.length === 0) {
      await reply.code(400).send({ error: 'device_name is required' });
      return;
    }

    let role: DeviceRole;
    if (rawRole === '' || rawRole === 'user') {
      role = 'user';
    } else if (rawRole === 'agent') {
      role = 'agent';
    } else {
      await reply.code(400).send({ error: 'role must be "user" or "agent"' });
      return;
    }

    // Consume the code first. If it fails, nothing has been mutated on
    // the device side.
    try {
      pairingCodes.complete(code);
    } catch (err) {
      if (err instanceof PairingCodeError) {
        if (err.reason === 'invalid_code' || err.reason === 'code_expired') {
          await reply.code(401).send({ error: 'invalid or expired pairing code' });
          return;
        }
        if (err.reason === 'code_used') {
          await reply.code(409).send({ error: 'pairing code already used' });
          return;
        }
      }
      throw err;
    }

    // Issue the token. Duplicate-id cannot occur here because we mint
    // the id internally; invalid randomness is a 500 scenario.
    let issued;
    try {
      issued = deviceTokens.issue({ deviceName, role });
    } catch (err) {
      if (err instanceof DeviceTokenError) {
        // We did not pass deviceId, so duplicate_device_id is unreachable
        // unless idFn collided — surface as 500 with a specific message
        // so ops can detect a misconfigured idFn.
        req.log.error({ reason: err.reason }, 'pair/complete: token issue failed');
      }
      throw err;
    }

    return {
      device_id: issued.deviceId,
      client_token: issued.rawToken,
      node_did: nodeDid,
    };
  });

  // -------------------------------------------------------------------------
  // GET /v1/pair/devices  (task 4.67)
  //
  // Lists EVERY paired device (revoked included) so the admin UI can
  // render a full history. The per-record `revoked: bool` flag lets
  // the UI strike revoked rows. Matches Go's `HandleListDevices` body.
  // -------------------------------------------------------------------------

  app.get('/v1/pair/devices', async () => {
    const devices = deviceTokens.listAll().map((d) => ({
      device_id: d.deviceId,
      name: d.deviceName,
      role: d.role,
      created_at: d.createdAt,
      last_seen: d.lastSeen,
      revoked: d.revoked,
    }));
    return { devices };
  });

  // -------------------------------------------------------------------------
  // DELETE /v1/pair/devices/:deviceId  (task 4.66)
  //
  // Revokes a paired device. Matches Go's `HandleRevokeDevice` wire
  // contract — DELETE with path param, 204 No Content on success.
  // Revocation flips `revoked: true` on the registry record (does NOT
  // delete the row) so `/v1/pair/devices` can still show the
  // historical entry struck-through. Any subsequent `verify(rawToken)`
  // against the revoked device returns undefined (live reload — 4.65).
  //
  // Response contract:
  //   204 No Content — device found + revoked (or was already revoked)
  //   404 Not Found  — unknown deviceId
  //
  // Idempotent revoke returns 204 — re-issuing the call must not fail
  // on a well-formed retry (matches Go).
  // -------------------------------------------------------------------------

  app.delete('/v1/pair/devices/:deviceId', async (req, reply) => {
    const params = req.params as { deviceId?: string };
    const deviceId = typeof params.deviceId === 'string' ? params.deviceId.trim() : '';
    if (deviceId.length === 0) {
      await reply.code(400).send({ error: 'device_id is required' });
      return;
    }
    try {
      deviceTokens.revoke(deviceId);
    } catch (err) {
      if (err instanceof DeviceTokenError && err.reason === 'unknown_device') {
        await reply.code(404).send({ error: 'device not found' });
        return;
      }
      throw err;
    }
    await reply.code(204).send();
  });
}
