/**
 * The GENERAL (third-party marketplace) plugin install ceremony, on the phone
 * (§5.C2). The server drives the SAME machinery over its owner routes
 * (`/v1/plugins/install/*`); the phone drives it in-process. Unlike the
 * first-party commerce pack (`commerce_install.ts`, `local_publisher_key`
 * anchor), this is the REPO-PROOF path: a plugin named by `(publisher DID,
 * content-derived rkey)` is fetched and authenticated through the injected
 * repo-proof verifier (§5.C1) before anything is staged.
 *
 * CONSENT IS A TAP, NOT A BOOT STEP. `beginPluginInstall` authenticates + stages
 * a PENDING install and returns the locally-computed consent summary; nothing
 * runs until `confirmPluginInstall`.
 *
 * RUNNER PAIRING BEFORE AUTHORITY (PLUGIN_ARCHITECTURE §15.3). A runner plugin
 * is out-of-process code with ITS OWN Ed25519 key. The phone never mints that
 * key and never names the device: it issues a setup code tied to the pending
 * install (`issueRunnerSetupCode`), the runner completes pairing with its own
 * public key over the relay, and `completePairing` binds that exact device to
 * that exact install inside Core. The phone only READS where the ceremony
 * stands (`checkRunnerPairing`) and confirms on the device the install row
 * holds. The first-party buyer pack's throwaway key is a first-party quirk
 * ("the phone's buyer runner claims no work") that must not leak into the
 * marketplace path.
 *
 * TEARDOWN REVOKES THE DEVICE. Decline, uninstall, and the abandoned-install
 * sweep all pass the durable device revoker; the core teardown keeps the row
 * when it cannot durably revoke a bound device, so a call without a revoker
 * would leave runner installs undeletable.
 *
 * NO VERIFIER, NO DOOR. Boot wires the phone's repo-proof verifier
 * (`repo_proof_wiring.ts`, the shared chain over the audited AT-Protocol stack
 * statically bundled by Metro). `pluginInstallAvailable` reports whether one
 * is wired; a begin without one is a build-level absence, never a network
 * problem the owner should retry.
 *
 * THE FIRST-PARTY DOOR (`beginCountryPackInstall`, RESEARCHER_KERNEL §5.D)
 * needs no verifier: the build vouches for its own compiled-in manifest under
 * the `local_publisher_key` anchor, exactly as the commerce packs enter. From
 * the pending row on, the ceremony is the same one — setup code, the operator's
 * runner pairs with its own key, consent activates on the bound device. The
 * phone is the authority-granting surface (PLUGIN_ARCHITECTURE §15.1), so this
 * door lives here as well as on the server route.
 */

import {
  beginFirstPartyInstall,
  beginInstall,
  buildAgentSetupCode,
  confirmConsent,
  COUNTRY_PACK_IDS,
  declineConsent,
  getNodeDID,
  getPluginInstallRepository,
  getRepoProofVerifier,
  issueRunnerPairingCode,
  PluginCommerceObligationError,
  runnerPairingState,
  uninstall,
  type BeginInstallResult,
  type CountryPack,
  type PluginInstallStatus,
  type RunnerPairingState,
} from '@dina/core';
import { revokePluginDeviceForTeardown } from '@dina/core/devices';

import { resolveMsgBoxURL } from './msgbox_wiring';

export type { CountryPack, RunnerPairingState } from '@dina/core';

export interface PluginConsentSummary {
  installId: string;
  pluginId: string;
  displayName: string;
  version: string;
  executionMode: 'interpreted' | 'runner';
  /** Capability display names — what the consent card lists. */
  capabilities: string[];
}

export type BeginPluginInstallOutcome =
  | { ok: true; consent: PluginConsentSummary }
  | {
      ok: false;
      error: string;
      /** A retry may succeed (publisher unreachable). */
      transient: boolean;
      /** This build cannot verify a third-party release at all — no retry helps. */
      unavailable: boolean;
    };

/** Can this phone verify a third-party release? True once boot wired the verifier. */
export function pluginInstallAvailable(): boolean {
  return getRepoProofVerifier() !== null;
}

/**
 * Fetch + authenticate a third-party release (repo-proof) and STAGE it. Returns
 * the consent summary the screen renders; nothing runs until confirm.
 */
export async function beginPluginInstall(
  publisherDid: string,
  rkey: string,
  label?: string,
): Promise<BeginPluginInstallOutcome> {
  if (!pluginInstallAvailable()) {
    return {
      ok: false,
      error: 'This phone cannot verify third-party plugins yet.',
      transient: false,
      unavailable: true,
    };
  }
  const result = await beginInstall({
    publisherDid,
    rkey,
    trustAnchor: { kind: 'repo_proof' },
    ...(label !== undefined && label !== '' ? { label } : {}),
    nowMs: Date.now(),
  });
  if (!result.ok) {
    return {
      ok: false,
      error: `${result.code}: ${result.message}`,
      transient: result.transient,
      unavailable: false,
    };
  }
  return { ok: true, consent: consentSummary(result) };
}

/** The consent card's rows, computed locally from what Core staged. */
function consentSummary(result: Extract<BeginInstallResult, { ok: true }>): PluginConsentSummary {
  return {
    installId: result.installId,
    pluginId: result.consent.pluginId,
    displayName: result.consent.displayName,
    version: result.consent.version,
    executionMode: result.consent.executionMode,
    capabilities: result.consent.capabilities.map((capability) => capability.display_name),
  };
}

export type BeginCountryPackOutcome =
  | { state: 'staged'; consent: PluginConsentSummary }
  /** The owner already granted this pack — an answer, not an error. */
  | { state: 'already_active'; installId: string }
  | { state: 'refused'; error: string; transient: boolean };

/**
 * Stage a country pack (§5.D) through the first-party door. No fetch and no
 * verifier: the manifest is compiled in and the build vouches for it. An
 * `active` install answers idempotently so re-tapping never stacks a second
 * consent for authority already granted; a pending one is left to its card
 * (or the sweeper) and a fresh pending is staged, as every begin does.
 */
export function beginCountryPackInstall(pack: CountryPack): BeginCountryPackOutcome {
  const owner = getNodeDID();
  if (owner === null || owner === '') {
    return { state: 'refused', error: 'Node identity not ready yet — wait for boot to finish and retry.', transient: true };
  }
  const installs = getPluginInstallRepository();
  if (installs === null) return { state: 'refused', error: 'plugin registry not wired', transient: false };
  const pluginId = COUNTRY_PACK_IDS[pack];
  const active = installs.list().find((install) => install.pluginId === pluginId && install.status === 'active');
  if (active !== undefined) return { state: 'already_active', installId: active.installId };
  const result = beginFirstPartyInstall({ pluginId, publisherDid: owner, nowMs: Date.now() });
  if (!result.ok) {
    return { state: 'refused', error: `${result.code}: ${result.message}`, transient: result.transient };
  }
  return { state: 'staged', consent: consentSummary(result) };
}

export interface RunnerSetupCode {
  /** The 8-character pairing code (the only secret; never log it). */
  code: string;
  /** Unix seconds. */
  expiresAt: number;
  /** The one-paste `dina1:…` string for `dina-plugin serve --setup-code`. */
  setupCode: string;
}

/**
 * Issue the setup code a runner pairs with, tied to this pending install. Role
 * `plugin` + scope `runner` are fixed at initiate — the completing side cannot
 * pick its own role — and Core binds the device that uses it to this install.
 * Throws when the node identity is not ready (nothing to pair against) or the
 * install is no longer a pending runner install.
 */
export function issueRunnerSetupCode(consent: PluginConsentSummary): RunnerSetupCode {
  const nodeDid = getNodeDID();
  if (nodeDid === null) {
    throw new Error('Node identity not ready yet — wait for boot to finish and retry.');
  }
  const install = getPluginInstallRepository()?.getById(consent.installId) ?? null;
  if (install === null || install.status !== 'pending' || install.executionMode !== 'runner') {
    throw new Error('This install can no longer take a runner — start again.');
  }
  const { code, expiresAt } = issueRunnerPairingCode(install);
  const setupCode = buildAgentSetupCode({
    msgboxUrl: resolveMsgBoxURL(),
    homenodeDid: nodeDid,
    deviceName: consent.pluginId,
    code,
  });
  return { code, expiresAt, setupCode };
}

/**
 * Where the ceremony stands. READ-ONLY: Core bound the runner (or refused it)
 * when the code was used; the phone only reports the install row. `expired`
 * means nobody will ever pair with this code — issue a new one. `refused`
 * means the install itself can no longer take a runner.
 */
export function checkRunnerPairing(installId: string, code: string): RunnerPairingState {
  return runnerPairingState(installId, code, Math.floor(Date.now() / 1000));
}

export type ConfirmPluginInstallOutcome = { ok: true } | { ok: false; error: string };

/**
 * The owner confirmed the consent card. A runner plugin activates on the device
 * Core bound to the install (§15.4: the client never names a device); an
 * interpreted plugin activates with no device. Core re-checks that the bound
 * device is a real, unrevoked `plugin` device.
 */
export async function confirmPluginInstall(
  installId: string,
  executionMode: 'interpreted' | 'runner',
): Promise<ConfirmPluginInstallOutcome> {
  const installs = getPluginInstallRepository();
  if (installs === null) return { ok: false, error: 'plugin registry not wired' };
  let deviceDid: string | undefined;
  if (executionMode === 'runner') {
    const bound = installs.getById(installId)?.deviceDid;
    if (bound === undefined || bound === '') return { ok: false, error: 'the runner has not paired yet' };
    deviceDid = bound;
  }
  return confirmConsent(installId, deviceDid, Date.now())
    ? { ok: true }
    : { ok: false, error: 'consent refused' };
}

/**
 * The owner declined (or cancelled, or left) a pending install — tear it down
 * and revoke any runner device paired during the ceremony. `removed: false`
 * means the row was unknown, already active, or kept as a retry anchor for the
 * sweeper. A runner that pairs after this is refused by Core (its install is
 * gone), so no device outlives the decline.
 */
export async function declinePluginInstall(installId: string): Promise<{ removed: boolean }> {
  const result = await declineConsent(installId, Date.now(), revokePluginDeviceForTeardown);
  return { removed: result?.removed === true };
}

export type UninstallPluginOutcome =
  | { ok: true }
  | { ok: false; error: 'unknown_install' | 'obligations_open' | 'teardown_incomplete'; detail?: string };

/** Tear down an install (§16.4), revoking its runner device. */
export async function uninstallPlugin(installId: string): Promise<UninstallPluginOutcome> {
  let result;
  try {
    result = await uninstall(installId, Date.now(), revokePluginDeviceForTeardown);
  } catch (err) {
    if (err instanceof PluginCommerceObligationError) {
      return { ok: false, error: 'obligations_open', detail: err.message };
    }
    throw err;
  }
  if (result === null) return { ok: false, error: 'unknown_install' };
  return result.removed
    ? { ok: true }
    : { ok: false, error: 'teardown_incomplete', detail: 'device revoke not durable; kept for the sweeper' };
}

export interface InstalledPlugin {
  installId: string;
  pluginId: string;
  status: PluginInstallStatus;
  executionMode: 'interpreted' | 'runner';
}

/** Every install the registry holds, in creation order — the manage list. */
export function listInstalledPlugins(): InstalledPlugin[] {
  const installs = getPluginInstallRepository();
  if (installs === null) return [];
  return installs.list().map((install) => ({
    installId: install.installId,
    pluginId: install.pluginId,
    status: install.status,
    executionMode: install.executionMode,
  }));
}
