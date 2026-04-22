/**
 * Device pairing route — POST /v1/devices registers a paired device
 * (role in rich/thin/cli/agent). The list/get/delete helpers were
 * speculative ports; paired devices are managed via the registry
 * module directly.
 */

import type { CoreRouter } from '../router';
import { registerDevice, type DeviceRole } from '../../devices/registry';
import { registerDevice as registerDeviceAuth } from '../../auth/caller_type';

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
