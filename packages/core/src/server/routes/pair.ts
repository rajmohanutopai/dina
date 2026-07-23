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

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { resolveAgentScope, type AgentScope } from '../../auth/agent_scope';
import { persistDeviceDurable, revokeDeviceDurable } from '../../devices/registry';
import {
  generatePairingCode,
  completePairing,
  getPairingIntent,
  restorePairingCode,
} from '../../pairing/ceremony';

import type { DeviceRole } from '../../devices/registry';
import type { CoreRouter } from '../router';

const VALID_ROLES = new Set<string>(['rich', 'thin', 'cli', 'agent', 'plugin']);

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
    // Item C — agent_scope is a privilege boundary the admin fixes HERE at
    // initiate (like role). A present-but-invalid value is rejected; an omitted
    // one leaves the device unscoped (the auth layer defaults an agent/plugin
    // caller to 'runner'). It is meaningful only for an agent/plugin device.
    let scope: AgentScope | undefined;
    if (body.scope !== undefined) {
      scope = resolveAgentScope(typeof body.scope === 'string' ? body.scope : null);
      if (scope === undefined) {
        return { status: 400, body: { error: "scope must be one of: coding, runner" } };
      }
    }

    try {
      const { code, expiresAt } = generatePairingCode({
        deviceName,
        role: role as DeviceRole,
        ...(scope !== undefined ? { scope } : {}),
      });
      return {
        status: 201,
        body: {
          code,
          expires_at: expiresAt,
          device_name: deviceName,
          role,
          ...(scope !== undefined ? { scope } : {}),
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
      const deviceName = overrideName !== '' ? overrideName : (intent?.deviceName ?? '');
      // SECURITY: the role is a privilege boundary the admin fixes at
      // /v1/pair/initiate (which ALWAYS captures a role, defaulting to 'rich').
      // The completing device must NOT pick its own role — otherwise a code
      // minted as 'rich'/'cli' could be completed as 'agent' (privilege
      // escalation). The initiate-time role is authoritative; any client-sent
      // `role` on /complete is ignored. The 'rich' fallback only covers a
      // null/expired intent, which completePairing rejects anyway. (device_name
      // is just a label, so an override there stays allowed above.)
      const roleRaw = normaliseRole(intent?.role ?? 'rich');
      // Like role, the agent_scope is authoritative from initiate — a completing
      // device can never pick its own scope (a `runner` code can't self-upgrade
      // to `coding`). Any client-sent scope on /complete is ignored.
      const scope = intent?.scope;

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

      let result: ReturnType<typeof completePairing>;
      try {
        result = completePairing(
          code,
          // `completePairing` validates the code first; if invalid,
          // this name value is never used. Pass a benign placeholder
          // so we don't fail an earlier layer's `name !== ''` guard
          // in the unknown-code path.
          deviceName !== '' ? deviceName : 'unknown',
          publicKeyMultibase,
          roleRaw as DeviceRole,
          scope,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // `isCodeValid` returns false for invalid / expired / burned
        // / used codes — the ceremony module has already recorded the
        // failed attempt before throwing. Surface as 400 so the agent
        // sees a clean client error rather than 500.
        return { status: 400, body: { error: msg } };
      }
      // P2.10: durable-first — `completePairing` registers the device in memory
      // and writes SQL fire-and-forget. Await an explicit durable write before
      // reporting success so a paired device survives a restart; a genuine
      // persistence failure returns 503 rather than a false 201.
      try {
        await persistDeviceDurable(result.deviceId);
      } catch (err) {
        // MT-2026-05-28-E-BUG2: do NOT leak the underlying error into the
        // response body — `${err.message}` can carry the ORM name
        // (op-sqlite), table + column names, and the SQL constraint
        // shape, all of which let an external probe fingerprint storage
        // internals. Mint an uncorrelated short diag id, log the raw
        // detail server-side only, return a generic 503 to the caller.
        const diagId = bytesToHex(randomBytes(4));
        const msg = err instanceof Error ? err.message : String(err);

        console.error(`[pair] device persistence failed (diag=${diagId}): ${msg}`);
        // Round-9 #10 + round-10 #20: roll back the in-memory + auth
        // registration that `completePairing` performed. Without this the caller
        // sees a 503 while the just-added device key can still AUTHENTICATE until
        // the next restart. Use the DURABLE revoke (awaited) — the legacy
        // `revokeDevice` fire-and-forgot its SQL revoke, so a partial persist
        // could leave an active row behind. `revokeDeviceDurable` cuts in-memory
        // + auth access synchronously first, then awaits the SQL revoke.
        // PLG-27 #2: only restore the single-use code once the rollback is
        // CONFIRMED DURABLE. `revokeDeviceDurable` fails closed to `durable:false`
        // on a SQL fault (it never throws for a persistence failure), and the
        // same fault that failed `persistDeviceDurable` above can leave the
        // device row written but un-revoked. Restoring the code unconditionally
        // then lets a SECOND device pair with it while the first stays active in
        // SQL (rehydrated as trusted on restart) — a double-grant. So: restore
        // the code only when the rollback durably landed; otherwise burn it and
        // the user restarts pairing (device access is cut in-memory either way).
        let rolledBackDurably = false;
        try {
          rolledBackDurably = (await revokeDeviceDurable(result.deviceId)).durable;
        } catch {
          rolledBackDurably = false; // best-effort — the 503 already reflects failure
        }
        // Round-16 #3: a durable-persistence failure is a retryable SERVER error,
        // not a code guess — restore the single-use code so the user can retry
        // the same code instead of restarting pairing (only when the device was
        // durably rolled back, so this can't resurrect authority — PLG-27 #2).
        if (rolledBackDurably) {
          restorePairingCode(code);
        }
        return {
          status: 503,
          body: { error: 'pairing: server error', diag_id: diagId },
        };
      }
      return {
        status: 201,
        body: {
          device_id: result.deviceId,
          node_did: result.nodeDID,
          device_name: deviceName,
          role: roleRaw,
        },
      };
    },
    { auth: 'public' },
  );
}
