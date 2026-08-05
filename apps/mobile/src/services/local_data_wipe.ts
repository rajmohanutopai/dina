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

import { clearCreditsState } from '../ai/credits';
import { resetUnlockState } from '../hooks/useUnlock';
import { shutdownAllPersistence } from '../storage/init';

import { clearDisplayNameOverride } from './display_name_override';
import { clearPersistedDid } from './identity_record';
import { clearIdentitySeeds } from './identity_store';
import { clearOrphanKeychainState, writeInstallMarker } from './install_marker';
import { clearAutoPassphrase } from './startup_preferences';
import { clearWrappedSeed } from './wrapped_seed_store';

/**
 * Tier 1 — "Sign out from this device".
 *
 * Removes the wrapped master seed, the raw identity keys in the OS
 * keychain, and the persisted DID record. After this returns, the
 * next app launch shows the onboarding screen.
 *
 * Encrypted vault databases are NOT touched. Re-onboarding with the
 * recovery phrase re-derives the same DEKs, so the data is
 * recoverable on this same device.
 */
export async function signOutLocal(): Promise<void> {
  await clearWrappedSeed();
  await clearIdentitySeeds();
  await clearPersistedDid();
  await clearDisplayNameOverride();
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
  try {
    await shutdownAllPersistence();
  } catch {
    // Intentional: best-effort close.
  }

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

  // Cancel every scheduled local notification (reminders, briefings)
  // so a freshly-erased device doesn't ping the user about reminders
  // that no longer exist in any vault. Push registration with the OS
  // is not unregistered explicitly here — the next install / OS
  // re-grant flow re-registers, and stale device tokens drop off the
  // server's send queue naturally.
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {
    // Best-effort — a misconfigured Notifications module shouldn't
    // block the wipe path.
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

/** True for SQLite database files (and their WAL/SHM sidecars). */
function isSqliteArtifact(name: string): boolean {
  return (
    name.endsWith('.sqlite') ||
    name.endsWith('.sqlite-wal') ||
    name.endsWith('.sqlite-shm') ||
    name.endsWith('.sqlite-journal')
  );
}
