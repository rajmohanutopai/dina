/**
 * Device pairing route — POST /v1/devices registers a paired device
 * (role in rich/thin/cli/agent). The list/get/delete helpers were
 * speculative ports; paired devices are managed via the registry
 * module directly.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { registerDevice as registerDeviceAuth } from '../../auth/caller_type';
import {
  registerDevice,
  persistDeviceDurable,
  revokeDeviceDurable,
  type DeviceRole,
} from '../../devices/registry';
import { multibaseToPublicKey } from '../../identity/did';

import type { CoreRouter } from '../router';

const VALID_ROLES = new Set<string>(['rich', 'thin', 'cli', 'agent']);

export function registerDevicesRoutes(router: CoreRouter): void {
  router.post('/v1/devices', async (req) => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const name = typeof body.name === 'string' ? body.name : '';
    const publicKeyMultibase =
      typeof body.publicKeyMultibase === 'string' ? body.publicKeyMultibase : '';
    const role = typeof body.role === 'string' ? body.role : 'rich';

    if (name === '') return { status: 400, body: { error: 'name is required' } };
    if (publicKeyMultibase === '')
      return { status: 400, body: { error: 'publicKeyMultibase is required' } };
    if (!VALID_ROLES.has(role)) {
      return {
        status: 400,
        body: { error: `role must be one of: ${[...VALID_ROLES].join(', ')}` },
      };
    }
    // Round-13 #18: reject an UNDECODABLE key at the production boundary.
    // `registerDevice` has a `did:key:${raw}` fallback for TEST FIXTURES (mock
    // multibase strings); without this guard the production route would persist
    // that unusable fake DID. A real device must present a decodable Ed25519
    // multibase key.
    try {
      multibaseToPublicKey(publicKeyMultibase);
    } catch {
      return { status: 400, body: { error: 'publicKeyMultibase is not a valid multibase key' } };
    }

    try {
      const device = registerDevice(name, publicKeyMultibase, role as DeviceRole);
      // Issue #19: also register the DID in the auth caller-type table so
      // subsequent signed calls (especially agent-pull /v1/workflow/tasks/*)
      // resolve to the correct caller type instead of 'unknown'.
      registerDeviceAuth(device.did, device.deviceName);
      // Round-13 #17: await DURABLE persistence before 201, mirroring the pairing
      // route's P2.10 seam — `registerDevice` fire-and-forgets the SQL write, so a
      // persistence failure would otherwise leave a device usable until restart
      // then silently removed. On failure, roll back the in-memory + auth
      // registration (durable revoke) and return a generic 503 (no storage
      // internals leaked; raw detail logged server-side under a diag id).
      try {
        await persistDeviceDurable(device.deviceId);
      } catch (persistErr) {
        const diagId = bytesToHex(randomBytes(4));
        const detail = persistErr instanceof Error ? persistErr.message : String(persistErr);
        console.error(`[devices] device persistence failed (diag=${diagId}): ${detail}`);
        try {
          await revokeDeviceDurable(device.deviceId);
        } catch {
          /* best-effort rollback — the 503 already reflects failure */
        }
        return { status: 503, body: { error: 'device: server error', diag_id: diagId } };
      }
      return {
        status: 201,
        body: {
          deviceId: device.deviceId,
          did: device.did,
          deviceName: device.deviceName,
          role: device.role,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes('already registered') ? 409 : 400;
      return { status, body: { error: msg } };
    }
  });
}
