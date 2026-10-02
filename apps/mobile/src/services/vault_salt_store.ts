/**
 * The vault salt — the salt every vault key on this device is derived with:
 * `derivePersonaDEK(masterSeed, persona, vaultSalt)` for the identity store
 * and each persona.
 *
 * WHY ITS OWN ROW. The keys used to take the passphrase-WRAP salt, and every
 * re-wrap picks a new random one. A passphrase change therefore re-keyed every
 * vault: the next start could not open a database and the unlock "self-heal"
 * deleted them all (found on the iPhone, 30 Sep 2026). "Sign out", then
 * recovering with the same phrase on the same device, broke the same way —
 * sign-out clears the wrapped seed and the recovery wrap picks a new salt.
 *
 * So the vault salt lives apart from the wrapped seed, written once:
 *   - a passphrase change and sign-out leave it alone, so the same seed opens
 *     the same vaults afterwards;
 *   - "Erase everything" and the reinstall clean-up clear it with the
 *     databases (`clearOrphanKeychainState` lists this service);
 *   - a device set up before this row existed adopts its current wrap salt at
 *     the first unlock: that is the salt its vaults were made with.
 *
 * Not a secret: without the master seed it opens nothing. It never leaves the
 * device (THIS_DEVICE_ONLY, like the wrapped seed).
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import * as Keychain from './keychain';
import { loadWrappedSeed } from './wrapped_seed_store';

export const VAULT_SALT_SERVICE = 'dina.vault.salt';
const USERNAME = 'dina_vault_salt';
const MIN_SALT_BYTES = 16;

async function readRow(): Promise<Uint8Array | null> {
  const row = await Keychain.getGenericPassword({ service: VAULT_SALT_SERVICE });
  if (!row) return null;
  try {
    const salt = hexToBytes(row.password);
    return salt.length >= MIN_SALT_BYTES ? salt : null;
  } catch {
    return null;
  }
}

async function writeRow(salt: Uint8Array): Promise<void> {
  await Keychain.setGenericPassword(USERNAME, bytesToHex(salt), {
    service: VAULT_SALT_SERVICE,
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

/**
 * The vault salt, pinning one if this device has none yet: the stored row;
 * else the wrapped seed's own salt (a device set up before this row existed —
 * its vaults were made with it); else `fresh` (a device with no record at
 * all). Whatever is returned is written, so it never changes afterwards.
 */
export async function ensureVaultSalt(fresh: Uint8Array): Promise<Uint8Array> {
  const stored = await readRow();
  if (stored !== null) return stored;
  const legacy = (await loadWrappedSeed())?.salt ?? null;
  const salt = legacy ?? fresh;
  await writeRow(salt);
  return salt;
}

/** The stored vault salt, without pinning one. */
export async function loadVaultSalt(): Promise<Uint8Array | null> {
  return readRow();
}

/** Forget the vault salt — only alongside deleting the databases it keys. */
export async function clearVaultSalt(): Promise<void> {
  await Keychain.resetGenericPassword({ service: VAULT_SALT_SERVICE });
}
