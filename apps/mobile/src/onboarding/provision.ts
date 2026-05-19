/**
 * Onboarding provision — turns a (mnemonic + passphrase + owner-name)
 * tuple into a fully registered Dina identity.
 *
 * **Architecture: PDS-first (Go-core mirror).** The PDS mints the
 * did:plc; mobile does NOT publish to plc.directory directly. This
 * matches `core/internal/adapter/pds/plc_client.go:CreateAccountAndDID`
 * — the production main-Dina identity flow.
 *
 *   1. Derive 32-byte master seed from the BIP-39 mnemonic.
 *   2. Derive Ed25519 signing key   — `m/9999'/0'/0'`.
 *   3. Derive secp256k1 rotation key — `m/9999'/2'/0'`.
 *   4. Persist both seeds to the platform keychain (`identity_store`).
 *   5. Wrap the master seed with the passphrase (Argon2id + AES-256-GCM)
 *      and persist (`wrapped_seed_store`).
 *   6. **PDS createAccount** (`com.atproto.server.createAccount`) with
 *      `handle`, `password`, `email`, and `recoveryKey` = our K256
 *      rotation key in `did:key:zQ3sh…` form. PDS:
 *         - Mints a fresh did:plc whose genesis op lists OUR rotation
 *           key (so we retain authority to issue PLC updates).
 *         - Publishes the genesis op to plc.directory.
 *         - Returns `{ did, accessJwt, refreshJwt, handle }`.
 *      We persist `did`, `handle`, `password`, `email` so subsequent
 *      boots can `createSession` without re-onboarding.
 *   7. **PLC update** to add the two fields PDS doesn't know about:
 *         - `verificationMethods.dina_signing` → our Ed25519
 *           (D2D + request signing key).
 *         - `services."dina-messaging"` → `{type: DinaMsgBox, endpoint}`
 *           (so peers can resolve our MsgBox relay channel).
 *      The update preserves PDS's `atproto` VM + `atproto_pds` service
 *      + both rotation keys — we MERGE on top, never overwrite.
 *      Signed with our K256 (PDS published it in `rotationKeys`, so PLC
 *      accepts our signature).
 *   8. Persist the DID, seed default personas, unlock the vault.
 *
 * Failure in any step throws with a stage-tagged message so the UI
 * can surface which phase broke. On the happy path the returned
 * object is enough for the UnlockGate to swap in the tab tree.
 *
 * Why PDS-first matters:
 *   - AppView discovery requires PDS-published records. With PDS
 *     bound to our DID, the AppView's Jetstream firehose picks up
 *     `com.dina.service.profile` records we put there.
 *   - We retain sovereign key authority via the recovery K256 — we
 *     can rotate signing keys, change handle, add services without
 *     PDS cooperation.
 *   - One round-trip identity (PDS createAccount) instead of two
 *     (mobile-mint PLC + PDS bring-your-own DID, which the modern
 *     atproto PDS rejects without a separate proof-of-control).
 */

import {
  defaultFetch,
  deriveRootSigningKey,
  deriveRotationKey,
  getPublicKey,
  mnemonicToEntropy,
  publicKeyToMultibase,
  secp256k1ToDidKeyMultibase,
  wrapSeed,
} from '@dina/core';
import { applyDinaPlcUpdate } from '@dina/home-node';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { PDSAccountClient } from '@dina/brain';
import { seedDefaultPersonas } from './default_personas';
import { saveWrappedSeed } from '../services/wrapped_seed_store';
import { saveIdentitySeeds } from '../services/identity_store';
import { savePersistedDid, loadPersistedDid } from '../services/identity_record';
import {
  loadInfraPreferences,
  savePdsHandle,
  savePdsPassword,
  savePdsEmail,
  savePdsUrl,
  saveAppViewURL,
} from '../services/infra_preferences';
import { unlock } from '../hooks/useUnlock';
import { resolveMsgBoxURL } from '../services/msgbox_wiring';
import { persistStartupChoice } from '../services/startup_preferences';
import type { StartupMode } from './state';

export type ProvisionStage =
  | 'deriving_seed'
  | 'deriving_keys'
  | 'persisting_keys'
  | 'wrapping_seed'
  | 'creating_pds_account'
  | 'publishing_plc_update'
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
   * dev autopilot path and recovery tests.
   */
  ownerName: string;
  /**
   * Pre-picked handle (full DNS form, e.g. `raju.test-pds.dinakernel.com`).
   * When set, used as-is. When omitted, falls back to `deriveHandle()`.
   */
  handle?: string;
  /**
   * Override the PDS URL. Defaults to the persisted infra preference
   * (set by the first-run setup gate) → `EXPO_PUBLIC_DINA_PDS_URL`
   * env var → `https://test-pds.dinakernel.com`.
   */
  pdsURL?: string;
  /** Override the PLC directory URL. Defaults to `https://plc.directory`. */
  plcURL?: string;
  /** Override the MsgBox endpoint. Defaults to the resolved test-mailbox URL. */
  msgboxEndpoint?: string;
  /** Optional email; auto-derived from handle when omitted. */
  email?: string;
  /**
   * `'auto'` caches the passphrase in keychain so the next launch can
   * unwrap the seed without prompting. `'manual'` forces a passphrase
   * prompt every cold start. Defaults to `'manual'` — opt in to the
   * convenience trade-off explicitly.
   */
  startupMode?: StartupMode;
  /** Progress callback. Fires before the named stage runs. */
  onProgress?: (p: ProvisionProgress) => void;
}

export interface ProvisionResult {
  did: string;
  didKey: string;
  handle: string;
}

export const PROVISION_LABELS: Record<ProvisionStage, string> = {
  deriving_seed: 'Deriving master seed',
  deriving_keys: 'Deriving signing keys',
  persisting_keys: 'Saving keys to the keychain',
  wrapping_seed: 'Wrapping seed with passphrase',
  creating_pds_account: 'Creating PDS account',
  publishing_plc_update: 'Publishing service endpoint to PLC',
  persisting_did: 'Saving identity',
  opening_vault: 'Opening vault',
  done: 'Ready',
};

function progress(cb: ProvisionOptions['onProgress'], stage: ProvisionStage): void {
  cb?.({ stage, label: PROVISION_LABELS[stage] });
}

/**
 * Default PDS host. Picked from infra prefs > env > built-in.
 * The first-run setup gate writes the persisted preference; dev
 * builds can override via `EXPO_PUBLIC_DINA_PDS_URL`.
 */
const DEFAULT_PDS_URL = 'https://test-pds.dinakernel.com';

/**
 * Deterministic PDS password from the master seed. Survives a
 * "wipe app + restore mnemonic" recovery: re-deriving the same
 * seed yields the same password, so `createSession` works on the
 * new device even if the keychain is empty. HMAC tag is versioned
 * so we can rotate the derivation later without breaking older
 * accounts (bump v1 → v2, but keep both readers).
 */
function derivePdsPassword(masterSeed: Uint8Array): string {
  const tag = new TextEncoder().encode('dina:pds_password:v1');
  const mac = hmac(sha256, masterSeed, tag);
  return bytesToHex(mac);
}

export async function provisionIdentity(opts: ProvisionOptions): Promise<ProvisionResult> {
  const mnemonicStr = opts.mnemonic.map((w) => w.trim().toLowerCase()).join(' ');
  const msgboxEndpoint = opts.msgboxEndpoint ?? resolveMsgBoxURL();

  // Resolve PDS URL from explicit option > persisted prefs > env > default.
  const infra = await loadInfraPreferences();
  const pdsURL =
    opts.pdsURL ??
    infra.pdsUrl ??
    process.env.EXPO_PUBLIC_DINA_PDS_URL ??
    DEFAULT_PDS_URL;

  // 1. Entropy from mnemonic — 32-byte master seed.
  progress(opts.onProgress, 'deriving_seed');
  const masterSeed = mnemonicToEntropy(mnemonicStr);

  // 2. Derive Ed25519 signing + secp256k1 rotation keys. Same mnemonic
  //    on a new device lands the same keys → recovery flow can rebind
  //    to the same did:plc via PDS createSession (password is also
  //    seed-derived).
  progress(opts.onProgress, 'deriving_keys');
  const signing = deriveRootSigningKey(masterSeed, 0);
  const rotation = deriveRotationKey(masterSeed, 0);

  // 3. Keychain write so subsequent boots have keys without the master
  //    seed in memory.
  progress(opts.onProgress, 'persisting_keys');
  await saveIdentitySeeds({
    signingSeed: signing.privateKey,
    rotationSeed: rotation.privateKey,
  });

  // 4. Wrap + persist the master seed so unlock() can recover it.
  progress(opts.onProgress, 'wrapping_seed');
  const wrapped = await wrapSeed(opts.passphrase, masterSeed);
  await saveWrappedSeed(wrapped);

  // 5. PDS createAccount. PDS mints the did:plc, publishes the genesis
  //    op to plc.directory with our K256 in rotationKeys, and returns
  //    the DID + session JWTs.
  progress(opts.onProgress, 'creating_pds_account');
  const handle = opts.handle ?? deriveHandle(opts.ownerName, pdsURL);
  const password = derivePdsPassword(masterSeed);
  const email = opts.email ?? defaultEmailForHandle(handle);
  const recoveryKey = `did:key:${secp256k1ToDidKeyMultibase(rotation.publicKey)}`;

  const account = new PDSAccountClient({ pdsUrl: pdsURL });
  let pdsDid: string;
  try {
    const session = await account.createAccount({
      handle,
      password,
      email,
      recoveryKey,
    });
    pdsDid = session.did;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`PDS account creation failed: ${msg}`);
  }

  // 6. Persist PDS credentials so boot's tryBuildPdsPublisher can
  //    re-authenticate without re-running provision. Also pin the
  //    PDS URL in case the user overrode the default.
  await Promise.all([
    savePdsUrl(pdsURL),
    savePdsHandle(handle),
    savePdsPassword(password),
    savePdsEmail(email),
    // Stamp the AppView pref too — first-run gate may have set it
    // already, but be idempotent against partial state.
    infra.appViewURL === null
      ? Promise.resolve()
      : saveAppViewURL(infra.appViewURL),
  ]);

  // 7. PLC update — add `dina_signing` VM + `dina-messaging` service.
  //    The PDS-published genesis op only carries `atproto` VM and
  //    `atproto_pds` service; we need both Dina-specific fields for
  //    D2D to work. Sign with our K256 rotation key (PDS already
  //    published it in `rotationKeys` via the `recoveryKey` field).
  //
  //    `updateDIDPLC` derives the signer privkey via
  //    `deriveRotationKey(signerRotationSeed, signerRotationGeneration)`,
  //    so we MUST pass the same masterSeed + generation we used to
  //    derive the K256 we sent as `recoveryKey` (gen 0). Anything else
  //    yields a key not in the doc's `rotationKeys` and PLC rejects.
  progress(opts.onProgress, 'publishing_plc_update');
  try {
    await applyDinaPlcUpdate({
      did: pdsDid,
      ...(opts.plcURL !== undefined ? { plcURL: opts.plcURL } : {}),
      handle,
      msgboxEndpoint,
      signingPubKey: signing.publicKey,
      masterSeed,
      fetch: defaultFetch(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`PLC update (dina services + signing key) failed: ${msg}`);
  }

  // 8. Remember the DID for next boot.
  progress(opts.onProgress, 'persisting_did');
  await savePersistedDid(pdsDid);

  // Seed the default 4-persona set (general + work + health + finance) —
  // matches main Dina's bootstrap.
  seedDefaultPersonas();

  // 9. Unlock — uses the wrapped seed we just persisted. If this flips
  //    isUnlocked() → true the UnlockGate swaps to children on its
  //    next render without the user ever seeing the passphrase form.
  progress(opts.onProgress, 'opening_vault');
  const unlockResult = await unlock(opts.passphrase, wrapped);
  if (unlockResult.step === 'failed') {
    throw new Error(`Unlock failed after provisioning: ${unlockResult.error ?? 'unknown'}`);
  }

  // Persist the startup-mode choice + (when 'auto') the passphrase so
  // the next launch's UnlockGate can skip the passphrase prompt. We do
  // this AFTER unlock() succeeds so a wrong passphrase can't be cached
  // through a failed provisioning attempt.
  await persistStartupChoice(opts.startupMode ?? 'manual', opts.passphrase);

  progress(opts.onProgress, 'done');

  const didKey = `did:key:${publicKeyToMultibase(signing.publicKey)}`;

  return {
    did: pdsDid,
    didKey,
    handle,
  };
}


function defaultEmailForHandle(handle: string): string {
  // PDS createAccount accepts any RFC-5322-shaped value; we don't use
  // the inbox, so a derived synthetic suffices. The handle already
  // includes the PDS host, so `${handle}` would mint mail like
  // `raj.test-pds.dinakernel.com@…` — split out the local part.
  const at = handle.indexOf('.');
  const local = at > 0 ? handle.slice(0, at) : handle;
  return `${local}@dina.invalid`;
}

/**
 * Recovery flow: user has the mnemonic, wants this device to come up
 * under the SAME did:plc they previously registered. We re-derive
 * the keys from the mnemonic, persist them, and call PDS createSession
 * (the password is mnemonic-derived too, so it just works). The PLC
 * doc is unchanged — recovery only restores local key+identity state.
 */
export async function recoverIdentity(opts: {
  mnemonic: string[];
  passphrase: string;
  /**
   * The `did:plc:…` resolved + verified by `resolveAndVerifyDidPlc`
   * during the `recover_handle` step. Required — recovery without a
   * verified PLC doc would silently degrade the user to a `did:key`
   * identity (orphaning their published handle and MsgBox endpoint),
   * which is the bug MT-04-I4 was filed against.
   */
  expectedDid: string;
  /**
   * The user's published Dina handle (e.g. `alonso77.test-pds.dinakernel.com`).
   * Persisted so subsequent boots' `tryBuildPdsPublisher` can call
   * `createSession(handle, password)` instead of falling through to
   * the create flow.
   */
  handle: string;
  /**
   * `'auto'` caches the passphrase in keychain so the next launch can
   * unwrap the seed without prompting. Defaults to `'manual'`.
   */
  startupMode?: StartupMode;
  onProgress?: (p: ProvisionProgress) => void;
}): Promise<ProvisionResult> {
  if (!opts.expectedDid.startsWith('did:plc:')) {
    throw new Error(
      'recoverIdentity: expectedDid must be a did:plc — recovery requires a verified PLC binding',
    );
  }
  if (opts.handle.trim().length === 0) {
    throw new Error('recoverIdentity: handle is required');
  }
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

  // Re-derive PDS password from the seed (deterministic — same on
  // every device that restores from the same mnemonic) and persist
  // alongside the handle so boot's `tryBuildPdsPublisher` can call
  // `createSession(handle, password)` without re-running provision.
  const password = derivePdsPassword(masterSeed);
  const handle = opts.handle.trim().toLowerCase();
  const email = defaultEmailForHandle(handle);
  await Promise.all([
    savePdsHandle(handle),
    savePdsPassword(password),
    savePdsEmail(email),
  ]);

  progress(opts.onProgress, 'persisting_did');
  await savePersistedDid(opts.expectedDid);

  seedDefaultPersonas();

  progress(opts.onProgress, 'opening_vault');
  const unlockResult = await unlock(opts.passphrase, wrapped);
  if (unlockResult.step === 'failed') {
    throw new Error(`Unlock failed after recovery: ${unlockResult.error ?? 'unknown'}`);
  }

  await persistStartupChoice(opts.startupMode ?? 'manual', opts.passphrase);

  progress(opts.onProgress, 'done');

  const didKey = `did:key:${publicKeyToMultibase(signing.publicKey)}`;
  return { did: opts.expectedDid, didKey, handle };
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
 * step 8b: lowercase, strip non-alphanumerics, clamp to 12 chars,
 * fallback to "dina", append a 4-char hex suffix for uniqueness, and
 * the selected PDS host.
 *
 * The second arg may be a full PDS URL (`https://test-pds.dinakernel.com`)
 * or a bare host (`test-pds.dinakernel.com`); both forms yield the same
 * handle suffix. We extract the host so callers don't have to.
 */
export function deriveHandle(ownerName: string, pdsURLOrHost: string): string {
  const sanitized = ownerName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12);
  const base = sanitized.length >= 3 ? sanitized : 'dina';
  const suffix = bytesToHex(randomBytes(2));
  const pdsHost = extractPdsHost(pdsURLOrHost);
  return `${base}${suffix}.${pdsHost}`;
}

function extractPdsHost(pdsURLOrHost: string): string {
  const trimmed = pdsURLOrHost.trim();
  if (trimmed.length === 0) return 'pds.dinakernel.com';
  try {
    const url = new URL(
      trimmed.includes('://') ? trimmed : `https://${trimmed}`,
    );
    return url.host;
  } catch {
    return trimmed.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}
