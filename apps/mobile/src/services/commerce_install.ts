/**
 * The BUYER pack's install ceremony, on the phone (§18.1 / PC-9a).
 *
 * The server drives begin → bind_device → confirm over its owner routes;
 * the phone drives the SAME machinery in-process. The runner-mode buyer
 * pack demands a bound plugin device even though this journey never
 * dispatches buyer-side runner work — the install row is the AUTHORITY
 * the approve/submit path acts under — so the ceremony mints a device
 * key, pairs it through the real pairing ceremony (role `plugin`), binds
 * it to the pending install, and confirms.
 *
 * CONSENT IS A TAP, NOT A BOOT STEP. Nothing here runs automatically:
 * the orders screen shows what the install grants and calls
 * `activateBuyerInstall` only when the owner chooses it. `buyerInstallStatus`
 * is the read side the screen gates on.
 */

import { ed25519 } from '@noble/curves/ed25519.js';

import {
  BUYER_REFERENCE_MANIFEST,
  beginReferenceInstall,
  completePairing,
  confirmConsent,
  deriveDIDKey,
  generatePairingCode,
  getNodeDID,
  getPluginInstallRepository,
  publicKeyToMultibase,
} from '@dina/core';

export type BuyerInstallStatus =
  | { state: 'active'; installId: string }
  | { state: 'absent' }
  | { state: 'unavailable'; reason: string };

export function buyerInstallStatus(): BuyerInstallStatus {
  const installs = getPluginInstallRepository();
  if (installs === null) return { state: 'unavailable', reason: 'plugin registry not wired' };
  const active = installs
    .list()
    .find(
      (install) =>
        install.pluginId === BUYER_REFERENCE_MANIFEST.plugin_id && install.status === 'active',
    );
  return active === undefined ? { state: 'absent' } : { state: 'active', installId: active.installId };
}

/** What the consent card renders before the owner decides. */
export function buyerInstallConsentSummary(): { name: string; capabilities: string[] } {
  return {
    name: BUYER_REFERENCE_MANIFEST.display_name,
    capabilities: BUYER_REFERENCE_MANIFEST.capabilities.map(
      (capability) => capability.display_name,
    ),
  };
}

export type ActivateOutcome =
  | { ok: true; installId: string }
  | { ok: false; error: string };

/**
 * Run the whole ceremony. Idempotent: an ACTIVE install answers without a
 * second consent. The device key is ceremony-scoped — a fresh one per run,
 * never persisted beyond the registry, because nothing ever signs with it
 * again (the phone's buyer runner claims no work).
 */
export async function activateBuyerInstall(): Promise<ActivateOutcome> {
  const existing = buyerInstallStatus();
  if (existing.state === 'active') return { ok: true, installId: existing.installId };
  if (existing.state === 'unavailable') return { ok: false, error: existing.reason };

  const owner = getNodeDID();
  if (owner === null) return { ok: false, error: 'owner identity not established yet' };

  const begun = beginReferenceInstall({ role: 'buyer', publisherDid: owner, nowMs: Date.now() });
  if (!begun.ok) return { ok: false, error: `${begun.code}: ${begun.message}` };

  const installs = getPluginInstallRepository();
  if (installs === null) return { ok: false, error: 'plugin registry not wired' };

  try {
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);
    const publicKey = ed25519.getPublicKey(seed);
    const { code } = generatePairingCode({ deviceName: 'buyer-runner', role: 'plugin', scope: 'runner' });
    completePairing(code, 'buyer-runner', publicKeyToMultibase(publicKey), 'plugin', 'runner');
    const deviceDid = deriveDIDKey(publicKey);
    if (!installs.bindPendingDevice(begun.installId, deviceDid, Date.now())) {
      return { ok: false, error: 'device bind refused' };
    }
    if (!confirmConsent(begun.installId, deviceDid, Date.now())) {
      return { ok: false, error: 'consent refused' };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, installId: begun.installId };
}
