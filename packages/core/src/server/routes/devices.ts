/**
 * Device routes:
 *   - POST /v1/devices       registers a paired device (rich/thin/cli/agent).
 *   - GET  /v1/devices/list  read-only list of paired devices. Backs the
 *                            web "Agents → CONNECTED (n)" view (mobile reads
 *                            the registry in-process). Read-only, so it's
 *                            allowlisted for `brain` (the more specific
 *                            prefix wins over the admin-only `/v1/devices`).
 */

import type { CoreResponse, CoreRouter } from '../router';
import { listDevices, registerDevice, type DeviceRole } from '../../devices/registry';
import { registerDevice as registerDeviceAuth } from '../../auth/caller_type';

const VALID_ROLES = new Set<string>(['rich', 'thin', 'cli', 'agent']);

export function registerDevicesRoutes(router: CoreRouter): void {
  // GET /v1/devices/list — read-only paired-device list. Registered before
  // the POST so the more-specific `/v1/devices/list` authz prefix resolves
  // first (brain-readable) ahead of the admin-only `/v1/devices`.
  router.get(
    '/v1/devices/list',
    async (): Promise<CoreResponse> => ({
      status: 200,
      body: { devices: listDevices() },
    }),
  );

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

    try {
      const device = registerDevice(name, publicKeyMultibase, role as DeviceRole);
      // Issue #19: also register the DID in the auth caller-type table so
      // subsequent signed calls (especially agent-pull /v1/workflow/tasks/*)
      // resolve to the correct caller type instead of 'unknown'.
      registerDeviceAuth(device.did, device.deviceName);
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
