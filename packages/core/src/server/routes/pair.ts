/**
 * Device-pairing routes — two-phase handshake.
 *
 *   POST /v1/pair/initiate   (admin) — generate a short-lived code for
 *                            an upcoming device. Body captures the
 *                            device name + intended role so the
 *                            completion step can honour them without
 *                            the agent having to re-send.
 *   POST /v1/pair/complete   (public) — unauthenticated-by-caller on
 *                            purpose: the requesting device doesn't
 *                            have a paired DID yet. The code itself
 *                            is the credential; the ceremony module
 *                            enforces single-use + brute-force
 *                            caps + TTL expiry. On success the device
 *                            is registered in both the device registry
 *                            AND the auth caller-type table so its
 *                            subsequent signed RPCs pass the admin /
 *                            agent / device authz gate.
 *
 * Port of main-dina's `dina-admin device pair` flow: admin creates
 * the code on the Home Node, agent side presents it via
 * `dina configure --pairing-code ...`.
 */

import type { CoreRouter } from '../router';
import { generatePairingCode, completePairing, getPairingIntent } from '../../pairing/ceremony';
import type { DeviceRole } from '../../devices/registry';

const VALID_ROLES = new Set<string>(['rich', 'thin', 'cli', 'agent']);

/**
 * Wire-aliases for `role` accepted from external callers that follow
 * the Go production CLI's `user|agent` taxonomy. Lite's internal
 * device registry uses the richer `rich|thin|cli|agent` set; `user`
 * (a personal command-line interface) maps to Lite's `cli`. Without
 * this, `dina configure --role user` against a Lite home node
 * 400s — the CLI is correct against Go's wire and Lite must accept
 * the same shape.
 */
const ROLE_ALIASES: Record<string, string> = {
  user: 'cli',
};

function normaliseRole(raw: string): string {
  return ROLE_ALIASES[raw] ?? raw;
}

export function registerPairRoutes(router: CoreRouter): void {
  router.post('/v1/pair/initiate', async (req) => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const deviceName = typeof body.device_name === 'string' ? body.device_name.trim() : '';
    const role = normaliseRole(typeof body.role === 'string' ? body.role : 'rich');

    if (deviceName === '') {
      return { status: 400, body: { error: 'device_name is required' } };
    }
    if (!VALID_ROLES.has(role)) {
      return {
        status: 400,
        body: { error: `role must be one of: ${[...VALID_ROLES].join(', ')}` },
      };
    }

    try {
      const { code, expiresAt } = generatePairingCode({
        deviceName,
        role: role as DeviceRole,
      });
      return {
        status: 201,
        body: {
          code,
          expires_at: expiresAt,
          device_name: deviceName,
          role,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only "max pending codes exceeded" / collision retry exhaustion
      // produce this path today. Both are operator-visible — bubble
      // the message so the admin UI can surface it.
      return { status: 503, body: { error: msg } };
    }
  });

  router.post(
    '/v1/pair/complete',
    async (req) => {
      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      // dina-cli sends `public_key_multibase` (matches main-dina's wire
      // contract); accept `public_key` as a short-alias for simple
      // callers / tests.
      const publicKeyMultibase =
        typeof body.public_key_multibase === 'string'
          ? body.public_key_multibase.trim()
          : typeof body.public_key === 'string'
            ? body.public_key.trim()
            : '';

      if (code === '') return { status: 400, body: { error: 'code is required' } };
      if (publicKeyMultibase === '') {
        return { status: 400, body: { error: 'public_key is required' } };
      }

      // Look up the pair intent first. A null intent means the code
      // isn't a known pending entry — invalid / expired / used. Let
      // `completePairing` produce the canonical error message for
      // that path (it also records the failed-attempt counter).
      const intent = getPairingIntent(code);
      const overrideName = typeof body.device_name === 'string' ? body.device_name.trim() : '';
      const overrideRole = typeof body.role === 'string' ? body.role : '';
      const deviceName = overrideName !== '' ? overrideName : (intent?.deviceName ?? '');
      const roleRaw = normaliseRole(
        overrideRole !== '' ? overrideRole : (intent?.role ?? 'rich'),
      );

      // If the intent exists but the admin didn't capture a device_name
      // AND the agent didn't supply one, reject BEFORE calling
      // completePairing — otherwise we'd waste a burn attempt on a
      // shape error.
      if (intent !== null && deviceName === '') {
        return {
          status: 400,
          body: { error: 'device_name was not captured at initiate and no override supplied' },
        };
      }
      if (!VALID_ROLES.has(roleRaw)) {
        return {
          status: 400,
          body: { error: `role must be one of: ${[...VALID_ROLES].join(', ')}` },
        };
      }

      try {
        const result = completePairing(
          code,
          // `completePairing` validates the code first; if invalid,
          // this name value is never used. Pass a benign placeholder
          // so we don't fail an earlier layer's `name !== ''` guard
          // in the unknown-code path.
          deviceName !== '' ? deviceName : 'unknown',
          publicKeyMultibase,
          roleRaw as DeviceRole,
        );
        return {
          status: 201,
          body: {
            device_id: result.deviceId,
            node_did: result.nodeDID,
            device_name: deviceName,
            role: roleRaw,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // `isCodeValid` returns false for invalid / expired / burned
        // / used codes — the ceremony module has already recorded the
        // failed attempt before throwing. Surface as 400 so the agent
        // sees a clean client error rather than 500.
        return { status: 400, body: { error: msg } };
      }
    },
    { auth: 'public' },
  );
}
