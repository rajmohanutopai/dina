/**
 * The owner's plugin ceremonies (§5.C2), on every owner surface. The phone and
 * a browser connected as the owner drive the SAME Core routes
 * (`/v1/plugins/install/*`, `/v1/commerce/install/update/*`) through the owner
 * plugins client, so the §3.8 presence checks on consent, runner pairing and
 * updates hold everywhere (WEB_OWNER_SURFACE_PLAN §3.5). A presence refusal is
 * not swallowed here: it reaches the screen, whose sheet asks and retries.
 *
 * CONSENT IS A TAP, NOT A BOOT STEP. `beginPluginInstall` authenticates +
 * stages a PENDING install and returns the consent summary; nothing runs until
 * `confirmPluginInstall`.
 *
 * RUNNER PAIRING BEFORE AUTHORITY (PLUGIN_ARCHITECTURE §15.3). A runner plugin
 * is out-of-process code with ITS OWN Ed25519 key. The owner never mints that
 * key and never names the device: Core issues a setup code tied to the pending
 * install, the runner completes pairing with its own public key over the
 * relay, and Core binds that exact device to that exact install. The screen
 * only READS where the ceremony stands and confirms on the device the install
 * row holds.
 *
 * TEARDOWN REVOKES THE DEVICE. Decline and uninstall revoke any runner device
 * durably inside Core; a teardown that could not says so and keeps the row.
 *
 * NO VERIFIER, NO DOOR. A node without a repo-proof verifier cannot take a
 * third-party release; `loadPlugins` reports it, and a begin there is a
 * build-level absence, never a network problem the owner should retry.
 *
 * THE FIRST-PARTY DOOR (`beginCountryPackInstall`, RESEARCHER_KERNEL §5.D)
 * needs no verifier: the build vouches for its own compiled-in manifest. From
 * the pending row on, the ceremony is the same one.
 */

import {
  OwnerPluginsHttpError,
  type BeginInstallResult,
  type CountryPack,
  type OwnerPluginsClient,
  type RunnerPairingState,
} from '@dina/core';

import { getOwnerPluginsClient } from './owner_plugins_client';

export type { CountryPack, RunnerPairingState } from '@dina/core';

function plugins(): OwnerPluginsClient {
  const client = getOwnerPluginsClient();
  if (client === null) throw new Error('Dina is still starting up. Try again in a moment.');
  return client;
}

export interface PluginConsentSummary {
  installId: string;
  pluginId: string;
  displayName: string;
  version: string;
  executionMode: 'interpreted' | 'runner';
  /** Capability display names — what the consent card lists. */
  capabilities: string[];
}

export interface InstalledPlugin {
  installId: string;
  pluginId: string;
  status: string;
  executionMode: 'interpreted' | 'runner';
}

export interface PluginsView {
  installed: InstalledPlugin[];
  /** Can this node verify a third-party release at all? */
  thirdPartyAvailable: boolean;
}

/** Every install the node holds, and whether the third-party door is open. */
export async function loadPlugins(): Promise<PluginsView> {
  const view = await plugins().installs();
  return {
    installed: view.installs.map((row) => ({
      installId: row.install_id,
      pluginId: row.plugin_id,
      status: row.status,
      executionMode: row.execution_mode,
    })),
    thirdPartyAvailable: view.third_party_available,
  };
}

export type BeginPluginInstallOutcome =
  | { ok: true; consent: PluginConsentSummary }
  | {
      ok: false;
      error: string;
      /** A retry may succeed (publisher unreachable). */
      transient: boolean;
      /** This node cannot verify a third-party release at all — no retry helps. */
      unavailable: boolean;
    };

/** The consent card's rows, from what Core staged. */
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

/**
 * Fetch + authenticate a third-party release (repo-proof) and STAGE it.
 * Nothing runs until confirm.
 */
export async function beginPluginInstall(
  publisherDid: string,
  rkey: string,
  label?: string,
): Promise<BeginPluginInstallOutcome> {
  const result = await plugins().begin(publisherDid, rkey, label);
  if (result.ok) return { ok: true, consent: consentSummary(result) };
  if (result.code === 'verifier_unavailable') {
    return {
      ok: false,
      error: 'This node cannot verify third-party plugins yet.',
      transient: false,
      unavailable: true,
    };
  }
  return {
    ok: false,
    error: `${result.code}: ${result.message}`,
    transient: result.transient,
    unavailable: false,
  };
}

export type BeginCountryPackOutcome =
  | { state: 'staged'; consent: PluginConsentSummary }
  /** The owner already granted this pack — an answer, not an error. */
  | { state: 'already_active'; installId: string }
  | { state: 'refused'; error: string; transient: boolean };

/** Stage a country pack (§5.D) through the first-party door. */
export async function beginCountryPackInstall(pack: CountryPack): Promise<BeginCountryPackOutcome> {
  let result;
  try {
    result = await plugins().beginCountryPack(pack);
  } catch (err) {
    if (err instanceof OwnerPluginsHttpError && err.errorKey === 'owner_identity_unavailable') {
      return { state: 'refused', error: 'Node identity not ready yet — wait for boot to finish and retry.', transient: true };
    }
    throw err;
  }
  if (result.ok && 'status' in result && result.status === 'active') {
    return { state: 'already_active', installId: result.installId };
  }
  if (result.ok && 'consent' in result) return { state: 'staged', consent: consentSummary(result) };
  if (!result.ok) {
    return { state: 'refused', error: `${result.code}: ${result.message}`, transient: result.transient };
  }
  return { state: 'refused', error: 'unexpected answer from the node', transient: false };
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
 * The setup code a runner pairs with, tied to this pending install; role
 * `plugin` + scope `runner` are fixed by Core. Needs a person present (§3.8):
 * a presence refusal is raised for the screen's sheet. Other refusals raise
 * an error naming what to do.
 */
export async function issueRunnerSetupCode(consent: PluginConsentSummary): Promise<RunnerSetupCode> {
  let issued;
  try {
    issued = await plugins().runnerCode(consent.installId);
  } catch (err) {
    if (
      err instanceof OwnerPluginsHttpError &&
      ['install_unknown', 'install_not_pending', 'not_a_runner_install', 'install_expired'].includes(err.errorKey)
    ) {
      throw new Error('This install can no longer take a runner — start again.');
    }
    throw err;
  }
  if (issued.setup_code === undefined) {
    throw new Error('This node does not name its relay, so it cannot hand a runner a setup code.');
  }
  return { code: issued.code, expiresAt: issued.expires_at, setupCode: issued.setup_code };
}

/**
 * Where the ceremony stands. READ-ONLY: Core bound the runner (or refused it)
 * when the code was used. `expired`: issue a new code. `refused`: the install
 * itself can no longer take a runner.
 */
export async function checkRunnerPairing(installId: string, code: string): Promise<RunnerPairingState> {
  return plugins().pairingState(installId, code);
}

export type ConfirmPluginInstallOutcome = { ok: true } | { ok: false; error: string };

/**
 * The owner confirmed the consent card. Core activates a runner plugin on the
 * device it bound (§15.4: the client never names one) and an interpreted one
 * with none. Needs a person present: a presence refusal is raised.
 */
export async function confirmPluginInstall(installId: string): Promise<ConfirmPluginInstallOutcome> {
  try {
    await plugins().confirm(installId);
    return { ok: true };
  } catch (err) {
    if (!(err instanceof OwnerPluginsHttpError) || err.errorKey === 'no_user_presence') throw err;
    if (err.errorKey === 'runner_not_paired') return { ok: false, error: 'the runner has not paired yet' };
    if (err.errorKey === 'consent_refused') return { ok: false, error: 'consent refused' };
    return { ok: false, error: err.errorKey };
  }
}

/**
 * The owner declined (or cancelled, or left) a pending install — Core tears it
 * down and revokes any runner device paired during the ceremony. `removed:
 * false` means the row was unknown, already active, or kept for the sweeper.
 */
export async function declinePluginInstall(installId: string): Promise<{ removed: boolean }> {
  const answer = await plugins().decline(installId);
  return { removed: answer.ok };
}

export type UninstallPluginOutcome =
  | { ok: true }
  | { ok: false; error: 'unknown_install' | 'obligations_open' | 'teardown_incomplete'; detail?: string };

/** Tear down an install (§16.4), revoking its runner device. */
export async function uninstallPlugin(installId: string): Promise<UninstallPluginOutcome> {
  const answer = await plugins().uninstall(installId);
  if (answer.ok) return { ok: true };
  if (answer.error === 'obligations_open') {
    return { ok: false, error: 'obligations_open', ...(answer.detail !== undefined ? { detail: answer.detail } : {}) };
  }
  if (answer.error === 'teardown_incomplete') {
    return { ok: false, error: 'teardown_incomplete', detail: 'device revoke not durable; kept for the sweeper' };
  }
  return { ok: false, error: 'unknown_install' };
}

/**
 * Item 1 — Dina's own packs update in place with the app build: the install
 * keeps its id, so open orders stay with it. The owner reviews what changes
 * and confirms; nothing is applied by looking.
 */
export interface PackUpdate {
  installId: string;
  pluginId: string;
  displayName: string;
  fromVersion: string;
  toVersion: string;
}

export async function listPackUpdates(): Promise<PackUpdate[]> {
  return (await plugins().packUpdates()).map((row) => ({
    installId: row.install_id,
    pluginId: row.plugin_id,
    displayName: row.display_name,
    fromVersion: row.from_version,
    toVersion: row.to_version,
  }));
}

export interface PackUpdateReview {
  installId: string;
  toCid: string;
  fromVersion: string;
  toVersion: string;
  /** The capabilities the new version adds or widens, in its own words. */
  changes: string[];
  behaviorChanged: boolean;
  widening: Parameters<OwnerPluginsClient['confirmPackUpdate']>[0]['acceptedWidening'];
  toBehaviorHash: string;
}

export async function reviewPackUpdate(
  installId: string,
): Promise<{ ok: true; review: PackUpdateReview } | { ok: false; error: string }> {
  const prepared = await plugins().preparePackUpdate(installId);
  if (!prepared.ok) return { ok: false, error: prepared.message };
  const r = prepared.review;
  return {
    ok: true,
    review: {
      installId,
      toCid: r.toCid,
      fromVersion: r.fromVersion,
      toVersion: r.toVersion,
      changes: r.widening.map((w) => `${w.kind.replace(/_/g, ' ')}: ${w.capabilityId}`),
      behaviorChanged: r.behaviorChanged,
      widening: r.widening,
      toBehaviorHash: r.toBehaviorHash,
    },
  };
}

/** Apply the reviewed update. Needs a person present: a presence refusal is raised. */
export async function applyPackUpdate(
  review: PackUpdateReview,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await plugins().confirmPackUpdate({
    installId: review.installId,
    toCid: review.toCid,
    acceptedWidening: review.widening,
    acceptedBehaviorHash: review.toBehaviorHash,
  });
  if (!result.ok) return { ok: false, error: result.message };
  if (!result.outcome.ok) return { ok: false, error: `update refused (${result.outcome.refusal})` };
  return { ok: true };
}
