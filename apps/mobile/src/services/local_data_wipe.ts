/**
 * Local data-wipe operations — two tiers, one per Danger-Zone action.
 *
 *   - `signOutLocal()` removes this device's keys + identity record.
 *     Encrypted SQLCipher vault files stay on disk but are unreadable
 *     without the master seed. Re-onboarding with the recovery phrase
 *     re-derives the same DEKs and the data comes back.
 *
 *   - `eraseEverythingLocal()` does signOutLocal(), then closes every
 *     open database and deletes the `.sqlite` files from the
 *     application's document directory. Re-onboarding with the
 *     recovery phrase brings back identity, but this device starts
 *     empty — chat, reminders, contacts, vault items, all gone. Data
 *     stored on other paired devices or on the Dina network is
 *     unaffected.
 *
 * Neither operation contacts the PDS or PLC directory — the user's
 * sovereign identity on the Dina network stays intact. Account
 * deletion is a separate, network-side action.
 */

import { Paths, type Directory, type File } from 'expo-file-system';
import * as Notifications from 'expo-notifications';

import { setUcpSigningGeneration } from '@dina/core';

import { clearCreditsState } from '../ai/credits';
import { closeVault, resetUnlockState } from '../hooks/useUnlock';

import { clearDisplayNameOverride } from './display_name_override';
import { clearPersistedDid, loadPersistedDid } from './identity_record';
import { rememberSignedOutIdentity, resetIdentityScopedState } from './identity_scope';
import { clearIdentitySeeds } from './identity_store';
import { clearPdsCredentials } from './infra_preferences';
import { clearOrphanKeychainState, writeInstallMarker } from './install_marker';
import { clearAutoPassphrase } from './startup_preferences';
import { clearWrappedSeed } from './wrapped_seed_store';

/**
 * Tier 1 — "Sign out from this device".
 *
 * Closes every open database, then removes the wrapped master seed, the raw
 * identity keys in the OS keychain, the persisted DID record and the PDS
 * credentials, and cancels every scheduled banner. After this returns, the
 * next app launch shows the onboarding screen.
 *
 * Encrypted vault files stay on disk. Re-onboarding with the recovery phrase
 * re-derives the same DEKs, so the data is recoverable on this same device.
 * Owner rows with no secret in them (preferences, role, linked account) stay
 * until a different identity onboards (identity_scope). AI provider keys and
 * credits belong to the phone, and stay until "Erase everything".
 */
export async function signOutLocal(): Promise<void> {
  // UCP stops first: no upload, search or guard claim under an identity being removed.
  // Every handle and DEK closes before the keys go: the next identity must
  // never run on this one's open databases. A failed close still ends with the
  // keys gone and the module state reset (shutdownAllPersistence's finally).
  try {
    await closeVault();
  } catch {
    // Intentional: best-effort close.
  }
  // A wiped node forgets its key ring with its record; a restore adopts the host's.
  setUcpSigningGeneration(null);
  resetIdentityScopedState();
  // Cancel every scheduled banner (reminders, briefings): the old owner's text
  // must not keep reaching the lock screen. The kv_store mirror reissues them
  // when this identity comes back. Push registration is left alone: stale
  // device tokens drop off the server's send queue on their own.
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {
    // Best-effort: a misconfigured Notifications module must not block the wipe.
  }
  const did = await loadPersistedDid();
  if (did !== null) await rememberSignedOutIdentity(did);
  await clearWrappedSeed();
  await clearIdentitySeeds();
  await clearPersistedDid();
  await clearDisplayNameOverride();
  // The password comes from the master seed, and recovery derives it again.
  await clearPdsCredentials();
  // Clear the cached auto-unlock passphrase too — without this, a
  // post-sign-out boot would still find the cached passphrase but no
  // wrapped seed, log a confusing "no wrapped seed" diagnostic, and
  // leave a phantom row in the keychain. The startup mode preference
  // (`dina.startup.mode` — auto vs manual) is left intact so a
  // re-onboard with the same recovery phrase resumes the user's
  // chosen behaviour.
  await clearAutoPassphrase();
  resetUnlockState();
}

/**
 * Tier 2 — "Erase everything on this device".
 *
 * Closes every open database, deletes the `.sqlite` and `.sqlite-*`
 * files from the document directory, then performs `signOutLocal()`.
 *
 * Order matters: SQLite handles must be closed BEFORE deleting the
 * files (op-sqlite locks the files while open) and identity keys are
 * cleared LAST so the wipe survives a crash mid-operation — a
 * partially-erased device with no keys still onboards cleanly,
 * whereas a partially-erased device that still has keys would boot
 * into a half-empty UI.
 */
export async function eraseEverythingLocal(): Promise<void> {
  // Close every open SQLite handle. Tolerate failures here — even if
  // shutdown throws, we still want to attempt file deletion + key
  // wipe so the device ends in a clean state. The most likely cause
  // of failure is "persistence wasn't initialized" (pre-unlock erase
  // is a no-op for the close step).
  // UCP stops before its database closes (its search store and guard claims read it).
  try {
    await closeVault();
  } catch {
    // Intentional: best-effort close.
  }
  // A wiped node forgets its key ring with its record; a restore adopts the host's.
  setUcpSigningGeneration(null);

  // Walk the document directory and delete every `.sqlite` family
  // file (.sqlite, .sqlite-wal, .sqlite-shm). Other files in the
  // document directory (Expo cache, fonts, etc.) are left alone.
  try {
    const docDir = Paths.document;
    if (docDir.exists) {
      const entries: (Directory | File)[] = docDir.list();
      for (const entry of entries) {
        const name = entry.name;
        if (isSqliteArtifact(name)) {
          try {
            entry.delete();
          } catch {
            // One file failing should not abort the whole wipe.
          }
        }
      }
    }
  } catch {
    // Directory listing failed — proceed to identity clear so the
    // app can at least re-onboard, even if old DB files linger.
  }

  // Sweep every keychain entry the app owns — startup mode + auto-
  // passphrase, infra preferences (PDS / AppView URLs), LLM provider
  // keys, role + verification flags. The narrow `signOutLocal()` only
  // clears identity + wrapped seed + display-name override. For Tier 2
  // ("Erase everything"), the user's expectation is that NOTHING
  // survives, so call the broad sweep to match the label.
  try {
    await clearOrphanKeychainState();
    // Starter Credits custody: the grant key + state die with the
    // identity (docs/CREDITS_DESIGN.md §key-as-secret).
    await clearCreditsState();
  } catch {
    // Best-effort — `clearOrphanKeychainState` already swallows per-
    // service failures internally; this catch handles a host that
    // can't reach Keychain at all (extremely rare).
  }

  await signOutLocal();

  // This is still the same app installation. Keep/recreate its marker so
  // re-onboarding in the current JS session can safely write a new wrapped
  // seed. If the marker were deleted here, UnlockGate would not remount to
  // recreate it; the next cold boot would misclassify that new seed as an
  // orphan left by an uninstalled copy and wipe it. A real OS uninstall
  // removes the marker with the documents directory, preserving MT-27.
  writeInstallMarker();
}

/**
 * True for SQLite database files (and their WAL/SHM sidecars), including
 * ones unlock set aside as unreadable (`<name>.unreadable-<stamp>`, see
 * `setAsideUnreadableVaultFiles`): "Erase everything" means nothing survives.
 */
function isSqliteArtifact(name: string): boolean {
  const base = name.replace(/\.unreadable-\d+$/, '');
  return (
    base.endsWith('.sqlite') ||
    base.endsWith('.sqlite-wal') ||
    base.endsWith('.sqlite-shm') ||
    base.endsWith('.sqlite-journal')
  );
}
