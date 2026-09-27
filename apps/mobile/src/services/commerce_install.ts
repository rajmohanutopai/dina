/**
 * The BUYER pack's install ceremony (§18.1 / PC-9a), on every owner surface.
 *
 * The phone and a browser connected as the owner drive the same Core routes
 * the server console does: begin → bind the first-party runner → confirm
 * (WEB_OWNER_SURFACE_PLAN §3.5). The runner-mode buyer pack demands a bound
 * plugin device even though this journey never dispatches buyer-side runner
 * work — the install row is the AUTHORITY the approve/submit path acts under —
 * so Core mints the runner's key, binds it to the pending install and keeps
 * only its DID. Binding and consent need a person present (§3.8); a presence
 * refusal is raised for the screen's sheet.
 *
 * CONSENT IS A TAP, NOT A BOOT STEP. Nothing here runs automatically: the
 * orders screen shows what the install grants and calls
 * `activateBuyerInstall` only when the owner chooses it. `buyerInstallStatus`
 * is the read side the screen gates on.
 */

import { BUYER_REFERENCE_MANIFEST, OwnerPluginsHttpError } from '@dina/core';

import { getOwnerPluginsClient } from './owner_plugins_client';

export type BuyerInstallStatus =
  | { state: 'active'; installId: string }
  | { state: 'absent' }
  | { state: 'unavailable'; reason: string };

export async function buyerInstallStatus(): Promise<BuyerInstallStatus> {
  const client = getOwnerPluginsClient();
  if (client === null) return { state: 'unavailable', reason: 'Dina is still starting up.' };
  let view;
  try {
    view = await client.installs();
  } catch (err) {
    return { state: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
  }
  if (!view.registry_available) return { state: 'unavailable', reason: 'plugin registry not wired' };
  const active = view.installs.find(
    (install) => install.plugin_id === BUYER_REFERENCE_MANIFEST.plugin_id && install.status === 'active',
  );
  return active === undefined ? { state: 'absent' } : { state: 'active', installId: active.install_id };
}

/** What the consent card renders before the owner decides. */
export function buyerInstallConsentSummary(): { name: string; capabilities: string[] } {
  return {
    name: BUYER_REFERENCE_MANIFEST.display_name,
    capabilities: BUYER_REFERENCE_MANIFEST.capabilities.map((capability) => capability.display_name),
  };
}

export type ActivateOutcome = { ok: true; installId: string } | { ok: false; error: string };

/**
 * Run the whole ceremony. Idempotent: an ACTIVE install answers without a
 * second consent. A step that fails after `begin` tears the pending install
 * down (revoking a runner already bound), so a refused or abandoned attempt
 * leaves nothing staged. A presence refusal is raised, not returned, so the
 * screen can ask and run it again from the start.
 */
export async function activateBuyerInstall(): Promise<ActivateOutcome> {
  const client = getOwnerPluginsClient();
  if (client === null) return { ok: false, error: 'Dina is still starting up.' };
  let installId: string;
  try {
    const begun = await client.beginCommercePack('buyer');
    if (begun.status === 'active') return { ok: true, installId: begun.install_id };
    installId = begun.install_id;
  } catch (err) {
    return refusalOrRaise(err);
  }
  try {
    const { device_did: deviceDid } = await client.bindReferenceRunner(installId);
    await client.confirmCommercePack(installId, deviceDid);
    return { ok: true, installId };
  } catch (err) {
    await client.decline(installId).catch(() => undefined);
    return refusalOrRaise(err);
  }
}

function refusalOrRaise(err: unknown): ActivateOutcome {
  if (err instanceof OwnerPluginsHttpError && err.errorKey !== 'no_user_presence') {
    return { ok: false, error: err.errorKey };
  }
  throw err;
}
