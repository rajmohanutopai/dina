/**
 * Runner pairing before authority (PLUGIN_ARCHITECTURE §15.3) — the ONE place
 * both hosts issue a runner's pairing code, so the server route and the phone's
 * ceremony service cannot drift. The code is tied to a pending install: role
 * `plugin` and scope `runner` are fixed here, at initiate, and `completePairing`
 * binds whoever uses the code to exactly this install inside Core. Nothing
 * here names a device; the install row is the only place the bound device
 * lives, and the owner's surfaces only READ it (`runnerPairingState`).
 */

import { generatePairingCode, isCodeValid } from '../pairing/ceremony';

import { getPluginInstallRepository, type PluginInstall } from './registry';

export function issueRunnerPairingCode(install: PluginInstall): { code: string; expiresAt: number } {
  return generatePairingCode({
    deviceName: install.pluginId,
    role: 'plugin',
    scope: 'runner',
    pluginInstallId: install.installId,
  });
}

export type RunnerPairingState =
  /** The code is live and no runner has used it yet. */
  | { state: 'waiting' }
  /** The code expired or was burned before a runner used it — issue a new one. */
  | { state: 'expired' }
  /** Core bound the runner that used the code to this install. */
  | { state: 'bound'; deviceDid: string }
  /** The install can no longer take a runner (gone, expired, or not pending). */
  | { state: 'refused'; error: string };

/**
 * Where the ceremony stands for `installId`, given the code the owner is
 * showing. Read-only: the bind itself happened (or was refused) inside
 * `completePairing`. Pure over the registry and the pairing table, so a
 * screen may poll it.
 */
export function runnerPairingState(installId: string, code: string, nowSec: number): RunnerPairingState {
  const installs = getPluginInstallRepository();
  if (installs === null) return { state: 'refused', error: 'plugin registry not wired' };
  const install = installs.getById(installId);
  if (install === null) return { state: 'refused', error: 'the install request is gone' };
  if (install.status !== 'pending') {
    return { state: 'refused', error: `the install is ${install.status}, not pending` };
  }
  if (install.pendingExpiresAt !== undefined && install.pendingExpiresAt <= nowSec) {
    return { state: 'refused', error: 'the install request expired' };
  }
  if (install.deviceDid !== undefined && install.deviceDid !== '') {
    return { state: 'bound', deviceDid: install.deviceDid };
  }
  return isCodeValid(code) ? { state: 'waiting' } : { state: 'expired' };
}
