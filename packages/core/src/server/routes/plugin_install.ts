/**
 * The owner's GENERAL plugin install / consent / uninstall surface (§5.C2 —
 * the marketplace path). Until now the only install ceremony was the commerce-
 * specific reference install (`/v1/commerce/install/*`), which uses a
 * `local_publisher_key` anchor and bypasses repo-proof. These routes are the
 * THIRD-PARTY path: a plugin named by `(publisher DID, content-derived rkey)` is
 * fetched and authenticated through the wired repo-proof verifier (§5.C1),
 * gated, and staged as a `pending` install; NOTHING runs until the owner sees
 * the locally-computed consent summary and confirms it.
 *
 *   POST /v1/plugins/install/begin        → verify + stage a pending install (third-party, repo proof)
 *   POST /v1/plugins/install/country_pack → stage a first-party country pack (§5.D, local publisher key)
 *   POST /v1/plugins/install/setup_code   → issue the runner's pairing code for a pending install
 *   POST /v1/plugins/install/confirm      → consent → activate (on the device Core bound)
 *   POST /v1/plugins/install/decline      → decline a pending install (teardown)
 *   POST /v1/plugins/install/uninstall    → tear down an install (§16.4)
 *
 * OWNER-ONLY: each of these grants, changes, or revokes the authority code runs
 * under. The trust anchor is NEVER taken from the request — P0 supports exactly
 * one authenticity path (repo-proof), and letting a caller name the anchor would
 * let them mislabel a repo-proof result as some other authority.
 *
 * RUNNER PAIRING BEFORE AUTHORITY (PLUGIN_ARCHITECTURE §15.3): the owner never
 * names the runner device. `setup_code` issues a pairing code tied to ONE
 * pending install (role `plugin`, scope `runner`, fixed at initiate); the runner
 * pairs with its own key on `/v1/pair/complete`, and `completePairing` binds
 * that exact device to that exact install inside Core. `confirm` then activates
 * on the device the install row holds — a `device_did` in its body is refused.
 */

import { COUNTRY_PACK_IDS, isCountryPack } from '../../commerce/country_packs';
import { beginFirstPartyInstall } from '../../commerce/reference_install';
import { revokePluginDeviceForTeardown } from '../../devices/registry';
import { getNodeDID } from '../../pairing/ceremony';
import {
  beginInstall,
  confirmConsent,
  declineConsent,
  PluginCommerceObligationError,
  uninstall,
  type BeginInstallResult,
  type PluginTeardownResult,
  type RevokeDeviceByDid,
} from '../../plugins/install_service';
import { getPluginInstallRepository } from '../../plugins/registry';
import { issueRunnerPairingCode } from '../../plugins/runner_pairing';

import { makeOwnerGuard } from './owner_guard';

import type { CoreResponse, CoreRouter } from '../router';

/**
 * @param revokeDevice durable device-revoke used when tearing down a runner
 *   install. Defaults to the registry's teardown revoker; tests inject a fake.
 *   The core teardown REFUSES to drop a row whose device it could not durably
 *   revoke (the row is the retry anchor), so a route without a revoker would
 *   leave every runner install undeletable.
 */
export function registerPluginInstallRoutes(
  router: CoreRouter,
  ownerCapability?: string,
  revokeDevice: RevokeDeviceByDid = revokePluginDeviceForTeardown,
): void {
  const ownerOnlyGuard = makeOwnerGuard(
    ownerCapability,
    'only the owner may install or remove a plugin',
  );

  router.post('/v1/plugins/install/begin', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const body = (req.body ?? {}) as { publisher_did?: unknown; rkey?: unknown; label?: unknown };
    const publisherDid = typeof body.publisher_did === 'string' ? body.publisher_did : '';
    const rkey = typeof body.rkey === 'string' ? body.rkey : '';
    if (publisherDid === '' || rkey === '') {
      return { status: 400, body: { error: 'publisher_did and rkey are required' } };
    }
    const label = typeof body.label === 'string' && body.label !== '' ? body.label : undefined;

    const result = await beginInstall({
      publisherDid,
      rkey,
      // NOT taken from the request — repo-proof is the only P0 anchor.
      trustAnchor: { kind: 'repo_proof' },
      ...(label === undefined ? {} : { label }),
      nowMs: Date.now(),
    });
    return { status: statusForBegin(result), body: result };
  });

  /**
   * §5.D — a country pack (`in` | `us`) enters through the owner's FIRST-PARTY
   * door: the build vouches for the compiled-in manifest, then the same pending
   * → pair → consent ceremony as any runner plugin (setup_code / confirm below).
   * The body names a pack; no caller-supplied manifest can reach the install
   * machinery here. An `active` install of that pack answers idempotently.
   */
  router.post('/v1/plugins/install/country_pack', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const pack = (req.body as { pack?: unknown } | null)?.pack;
    if (!isCountryPack(pack)) {
      return { status: 400, body: { error: "pack must be 'in' | 'us'" } };
    }
    const owner = getNodeDID();
    if (owner === null || owner === '') return { status: 503, body: { error: 'owner_identity_unavailable' } };
    const pluginId = COUNTRY_PACK_IDS[pack];
    const installs = getPluginInstallRepository();
    if (installs === null) return { status: 503, body: { error: 'plugin_registry_unavailable' } };
    const existing = installs
      .list()
      .find((install) => install.pluginId === pluginId && install.status === 'active');
    if (existing !== undefined) {
      return { status: 200, body: { ok: true, installId: existing.installId, status: 'active' } };
    }
    const result = beginFirstPartyInstall({ pluginId, publisherDid: owner, nowMs: Date.now() });
    return { status: statusForBegin(result), body: result };
  });

  router.post('/v1/plugins/install/setup_code', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const body = (req.body ?? {}) as { install_id?: unknown };
    if (typeof body.install_id !== 'string' || body.install_id === '') {
      return { status: 400, body: { error: 'install_id_required' } };
    }
    const installs = getPluginInstallRepository();
    if (installs === null) return { status: 503, body: { error: 'plugin_registry_unavailable' } };
    const install = installs.getById(body.install_id);
    if (install === null) return { status: 404, body: { error: 'install_unknown' } };
    if (install.status !== 'pending') return { status: 409, body: { error: 'install_not_pending' } };
    if (install.executionMode !== 'runner') {
      return { status: 409, body: { error: 'not_a_runner_install' } };
    }
    // The same window every other step of the ceremony refuses: a code for an
    // expired pending (still present between sweeper ticks) would be dead on
    // arrival — `completePairing` refuses it and spends it.
    if (install.pendingExpiresAt !== undefined && install.pendingExpiresAt <= Math.floor(Date.now() / 1000)) {
      return { status: 409, body: { error: 'install_expired' } };
    }
    try {
      const issued = issueRunnerPairingCode(install);
      return { status: 201, body: { ok: true, code: issued.code, expires_at: issued.expiresAt } };
    } catch (err) {
      return { status: 503, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  });

  router.post('/v1/plugins/install/confirm', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const body = (req.body ?? {}) as { install_id?: unknown; device_did?: unknown };
    if (typeof body.install_id !== 'string' || body.install_id === '') {
      return { status: 400, body: { error: 'install_id_required' } };
    }
    // §15.4 — the client cannot send a replacement device DID. Refusing the
    // field (not ignoring it) keeps the contract loud.
    if (body.device_did !== undefined) {
      return { status: 400, body: { error: 'device_did_not_accepted' } };
    }
    const installs = getPluginInstallRepository();
    if (installs === null) return { status: 503, body: { error: 'plugin_registry_unavailable' } };
    const install = installs.getById(body.install_id);
    if (install === null) return { status: 404, body: { error: 'install_unknown' } };
    if (install.executionMode === 'runner' && (install.deviceDid === undefined || install.deviceDid === '')) {
      return { status: 409, body: { error: 'runner_not_paired' } };
    }
    const activated = confirmConsent(
      body.install_id,
      install.executionMode === 'runner' ? install.deviceDid : undefined,
      Date.now(),
    );
    return activated
      ? { status: 200, body: { ok: true, status: 'active' } }
      : { status: 409, body: { error: 'consent_refused' } };
  });

  router.post('/v1/plugins/install/decline', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const body = (req.body ?? {}) as { install_id?: unknown };
    if (typeof body.install_id !== 'string' || body.install_id === '') {
      return { status: 400, body: { error: 'install_id_required' } };
    }
    const result = await declineConsent(body.install_id, Date.now(), revokeDevice);
    if (result === null) {
      // `declineConsent` answers null both for a missing row and for one that is
      // no longer pending. A live install is not "unknown": say it is live, so
      // the caller reaches for uninstall instead of believing it is gone.
      const status = getPluginInstallRepository()?.rawStatus(body.install_id) ?? null;
      if (status !== null && status !== 'pending') {
        return { status: 409, body: { error: 'install_not_pending', status } };
      }
    }
    return teardownResponse(result);
  });

  router.post('/v1/plugins/install/uninstall', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const body = (req.body ?? {}) as { install_id?: unknown };
    if (typeof body.install_id !== 'string' || body.install_id === '') {
      return { status: 400, body: { error: 'install_id_required' } };
    }
    let result: PluginTeardownResult | null;
    try {
      result = await uninstall(body.install_id, Date.now(), revokeDevice);
    } catch (err) {
      // §16.4 — open obligations refuse the teardown; the operator resolves
      // them first. A refusal, not a crash.
      if (err instanceof PluginCommerceObligationError) {
        return { status: 409, body: { error: 'obligations_open', detail: err.message } };
      }
      throw err;
    }
    return teardownResponse(result);
  });
}

/**
 * A teardown that could not drop the row is NOT success: the device revoke was
 * not durable, so the row stays as the retry anchor (the sweeper retries). Say
 * so with a 409 instead of a 200 that the caller would read as "gone". Shared
 * with the commerce retire route so both teardown surfaces answer alike.
 */
export function teardownResponse(result: PluginTeardownResult | null): CoreResponse {
  if (result === null) return { status: 404, body: { error: 'install_unknown' } };
  return result.removed
    ? { status: 200, body: { ok: true, ...result } }
    : {
        status: 409,
        body: {
          error: 'teardown_incomplete',
          detail: 'device revoke not durable; row retained for the sweeper',
          ...result,
        },
      };
}

/**
 * A TRANSIENT failure is 503 (try again — verifier/registry not ready, network
 * blip); a permanent authenticity/gate failure is 409 (do something else). An
 * `ok` result is the pending install + its consent summary.
 */
function statusForBegin(result: BeginInstallResult): number {
  if (result.ok) return 200;
  return result.transient ? 503 : 409;
}
