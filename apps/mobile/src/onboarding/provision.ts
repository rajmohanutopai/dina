/**
 * Onboarding provision — the one function that turns a (mnemonic +
 * passphrase + owner-name) tuple into a fully registered Dina identity.
 *
 * Mirrors main-dina's install.sh step sequence on mobile:
 *
 *   1. Derive the 32-byte master seed from the mnemonic (BIP-39 entropy).
 *   2. Derive the Ed25519 signing keypair    — `m/9999'/0'/0'` (SLIP-0010).
 *   3. Derive the secp256k1 rotation keypair — `m/9999'/2'/0'` (via
 *      `createDIDPLC` internally).
 *   4. Persist both to the platform keychain (`identity_store`).
 *   5. Wrap the master seed with the passphrase (Argon2id + AES-256-GCM)
 *      and persist (`wrapped_seed_store`).
 *   6. Build + sign + POST the PLC genesis operation to plc.directory.
 *      Includes our `dina_signing` Ed25519 VM and the `dina-messaging`
 *      DinaMsgBox service — the two PLC doc fields the relay's
 *      `/forward` endpoint + remote peer resolvers look up.
 *   7. Persist the resulting did:plc (`identity_record`) so every
 *      subsequent boot runs under the registered identity instead of a
 *      local did:key.
 *   8. Invoke `unlock()` with the passphrase so the node boot that
 *      follows flips straight to "ready" without a separate passphrase
 *      prompt.
 *
 * Failure in any step throws with a stage-tagged message so the UI can
 * surface which phase broke ("PLC rejected signature", "Keychain write
 * failed", …). On the happy path the returned object is enough for the
 * UnlockGate to swap in the tab tree.
 */

import { mnemonicToEntropy } from '@dina/core/src/crypto/bip39';
import { deriveRootSigningKey, deriveRotationKey } from '@dina/core/src/crypto/slip0010';
import { getPublicKey } from '@dina/core/src/crypto/ed25519';
import { wrapSeed } from '@dina/core/src/crypto/aesgcm';
import { createDIDPLC, type PLCCreateResult } from '@dina/core/src/identity/directory';
import { seedDefaultPersonas } from './default_personas';
import { saveWrappedSeed } from '../services/wrapped_seed_store';
import { saveIdentitySeeds } from '../services/identity_store';
import { savePersistedDid, loadPersistedDid } from '../services/identity_record';
import { unlock } from '../hooks/useUnlock';
import { resolveMsgBoxURL } from '../services/msgbox_wiring';

export type ProvisionStage =
  | 'deriving_seed'
  | 'deriving_keys'
  | 'persisting_keys'
  | 'wrapping_seed'
  | 'publishing_plc'
  | 'persisting_did'
  | 'opening_vault'
  | 'done';

export interface ProvisionProgress {
  stage: ProvisionStage;
  label: string;
}

export interface ProvisionOptions {
  mnemonic: string[];
  passphrase: string;
  /**
   * Display name. When `handle` is omitted, this seeds the always-suffix
   * fallback derivation (`{sanitized}{randhex}.{pds_host}`) — used by the
   * dev autopilot path and recovery tests. The interactive flow picks a
   * handle through the wizard and passes it via `handle` directly, so
   * the fallback only fires for non-UI callers.
   */
  ownerName: string;
  /**
   * Pre-picked handle (full DNS form, e.g. `raju.pds.dinakernel.com`).
   * When set, used as-is. When omitted, falls back to `deriveHandle()`
   * for backwards compatibility with the dev autopilot + recovery paths.
   */
  handle?: string;
  /** Override the PLC directory URL. Defaults to `https://plc.directory`. */
  plcURL?: string;
  /** Override the MsgBox endpoint baked into the genesis op. Defaults to
   *  the shared test-mailbox.dinakernel.com. */
  msgboxEndpoint?: string;
  /** Progress callback. Fires before the named stage runs. */
  onProgress?: (p: ProvisionProgress) => void;
}

export interface ProvisionResult {
  did: string;
  didKey: string;
  handle: string;
}

/**
 * Labels kept in one place so the progress screen and provision() agree.
 */
export const PROVISION_LABELS: Record<ProvisionStage, string> = {
  deriving_seed: 'Deriving master seed',
  deriving_keys: 'Deriving signing keys',
  persisting_keys: 'Saving keys to the keychain',
  wrapping_seed: 'Wrapping seed with passphrase',
  publishing_plc: 'Registering with PLC directory',
  persisting_did: 'Saving identity',
  opening_vault: 'Opening vault',
  done: 'Ready',
};

function progress(cb: ProvisionOptions['onProgress'], stage: ProvisionStage): void {
  cb?.({ stage, label: PROVISION_LABELS[stage] });
}

export async function provisionIdentity(opts: ProvisionOptions): Promise<ProvisionResult> {
  const mnemonicStr = opts.mnemonic.map((w) => w.trim().toLowerCase()).join(' ');
  const msgboxEndpoint = opts.msgboxEndpoint ?? resolveMsgBoxURL();

  // 1. Entropy from mnemonic — 32-byte master seed.
  progress(opts.onProgress, 'deriving_seed');
  const masterSeed = mnemonicToEntropy(mnemonicStr);

  // 2. Signing + rotation keys, both off the master. This is the key
  //    continuity property: the same mnemonic on a new device lands
  //    the same did:plc because both keys derive deterministically.
  progress(opts.onProgress, 'deriving_keys');
  const signing = deriveRootSigningKey(masterSeed, 0);
  const rotation = deriveRotationKey(masterSeed, 0);

  // 3. Keychain write so subsequent boots read these without the
  //    master seed being around (the master only exists transiently,
  //    post-unwrap, during an active session).
  progress(opts.onProgress, 'persisting_keys');
  await saveIdentitySeeds({
    signingSeed: signing.privateKey,
    rotationSeed: rotation.privateKey,
  });

  // 4. Wrap + persist the master seed so unlock() can recover it.
  progress(opts.onProgress, 'wrapping_seed');
  const wrapped = await wrapSeed(opts.passphrase, masterSeed);
  await saveWrappedSeed(wrapped);

  // 5. PLC genesis + publish.
  progress(opts.onProgress, 'publishing_plc');
  // Prefer the explicit handle from the picker wizard. Fall back to the
  // silent always-suffix derivation only when no handle was passed —
  // dev autopilot, recovery tests, and any non-interactive caller.
  const handle = opts.handle ?? deriveHandle(opts.ownerName, msgboxEndpoint);
  let plcResult: PLCCreateResult;
  try {
    plcResult = await createDIDPLC(
      {
        signingKey: signing.privateKey,
        // createDIDPLC re-derives the rotation key from the seed
        // internally (needs the scalar + path to sign the op with the
        // right private key). Passing master keeps that derivation
        // identical to what main-dina does.
        rotationSeed: masterSeed,
        msgboxEndpoint,
        handle,
      },
      {
        plcURL: opts.plcURL,
        fetch: globalThis.fetch,
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`PLC registration failed: ${msg}`);
  }

  // 6. Remember the DID — boot_capabilities reads this to bypass
  //    did:key fallback on subsequent launches.
  progress(opts.onProgress, 'persisting_did');
  await savePersistedDid(plcResult.did);

  // Ensure the default persona exists — matches Step 7 of
  // useOnboarding.completeCreateIdentity so later persona-aware code
  // doesn't hit a missing-row path.
  // Seed the default 4-persona set (general + work + health + finance) —
  // matches main Dina's bootstrap.
  seedDefaultPersonas();

  // 7. Unlock — uses the wrapped seed we just persisted. If this flips
  //    isUnlocked() → true the UnlockGate swaps to `children` on its
  //    next render without the user ever seeing the passphrase form.
  progress(opts.onProgress, 'opening_vault');
  const unlockResult = await unlock(opts.passphrase, wrapped);
  if (unlockResult.step === 'failed') {
    throw new Error(`Unlock failed after provisioning: ${unlockResult.error ?? 'unknown'}`);
  }

  progress(opts.onProgress, 'done');

  const pubKey = getPublicKey(signing.privateKey); // referenced so build doesn't tree-shake
  void pubKey;

  return {
    did: plcResult.did,
    didKey: plcResult.didKey,
    handle,
  };
}

/**
 * Recovery flow: user has the mnemonic, wants this device to come up
 * under the SAME did:plc they previously registered. We don't re-publish
 * the genesis (PLC rejects duplicate creates); we just re-derive keys +
 * re-wrap the master seed + trust that the existing plc.directory
 * record already names our derived pubkeys. The caller MUST have
 * verified `previewRecoveryDID` matches before calling this.
 */
export async function recoverIdentity(opts: {
  mnemonic: string[];
  passphrase: string;
  expectedDid: string;
  onProgress?: (p: ProvisionProgress) => void;
}): Promise<ProvisionResult> {
  const mnemonicStr = opts.mnemonic.map((w) => w.trim().toLowerCase()).join(' ');

  progress(opts.onProgress, 'deriving_seed');
  const masterSeed = mnemonicToEntropy(mnemonicStr);

  progress(opts.onProgress, 'deriving_keys');
  const signing = deriveRootSigningKey(masterSeed, 0);
  const rotation = deriveRotationKey(masterSeed, 0);

  progress(opts.onProgress, 'persisting_keys');
  await saveIdentitySeeds({
    signingSeed: signing.privateKey,
    rotationSeed: rotation.privateKey,
  });

  progress(opts.onProgress, 'wrapping_seed');
  const wrapped = await wrapSeed(opts.passphrase, masterSeed);
  await saveWrappedSeed(wrapped);

  progress(opts.onProgress, 'persisting_did');
  await savePersistedDid(opts.expectedDid);

  // Seed the default 4-persona set (general + work + health + finance) —
  // matches main Dina's bootstrap.
  seedDefaultPersonas();

  progress(opts.onProgress, 'opening_vault');
  const unlockResult = await unlock(opts.passphrase, wrapped);
  if (unlockResult.step === 'failed') {
    throw new Error(`Unlock failed after recovery: ${unlockResult.error ?? 'unknown'}`);
  }

  progress(opts.onProgress, 'done');

  // handle is unknown on recovery without resolving the PLC doc;
  // callers that care can resolve it and update via Settings. Return
  // an empty string so the progress screen doesn't crash.
  return { did: opts.expectedDid, didKey: '', handle: '' };
}

/**
 * Returns the persisted did:plc if the user has previously completed
 * onboarding on this device. Used by the gate to decide whether to
 * present onboarding or unlock.
 */
export async function hasCompletedOnboarding(): Promise<boolean> {
  const did = await loadPersistedDid();
  return did !== null && did.startsWith('did:plc:');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a PDS handle from the owner's display name. Matches install.sh
 * step 8b: lowercase, strip non-alphanumerics, clamp to 12 chars, fallback
 * to "dina", then append a 4-char hex suffix for uniqueness and the PDS
 * host. `openssl rand -hex 2` in bash — `randomBytes(2)` here.
 *
 * `msgboxEndpoint` is used only to derive the PDS host by string match
 * (test-mailbox → test-pds; mailbox → pds). Callers can override handle
 * directly if the convention shifts.
 */
export function deriveHandle(ownerName: string, msgboxEndpoint: string): string {
  const sanitized = ownerName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12);
  const base = sanitized.length >= 3 ? sanitized : 'dina';
  const suffix = shortHex(2);
  const pdsHost = msgboxEndpoint.includes('test-mailbox')
    ? 'test-pds.dinakernel.com'
    : 'pds.dinakernel.com';
  return `${base}${suffix}.${pdsHost}`;
}

function shortHex(nBytes: number): string {
  // Inline noble's randomBytes so we don't import crypto/utils just here.
  // 2 bytes = 4 hex chars — matches `openssl rand -hex 2`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } =
    require('@noble/ciphers/utils.js') as typeof import('@noble/ciphers/utils.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { bytesToHex } =
    require('@noble/hashes/utils.js') as typeof import('@noble/hashes/utils.js');
  return bytesToHex(randomBytes(nBytes));
}
