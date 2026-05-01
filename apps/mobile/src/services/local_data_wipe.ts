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
import { clearWrappedSeed } from './wrapped_seed_store';
import { clearIdentitySeeds } from './identity_store';
import { clearPersistedDid } from './identity_record';
import { clearDisplayNameOverride } from './display_name_override';
import { resetUnlockState } from '../hooks/useUnlock';
import { shutdownAllPersistence } from '../storage/init';

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

  await signOutLocal();
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
