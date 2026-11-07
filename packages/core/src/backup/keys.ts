/**
 * The backup keys (USER_BACKUP.md §4.1): a third branch from the one seed,
 * beside the signing tree and the vault keys, with a fixed salt so the 24
 * words alone are enough. A leaked backup key yields neither of the others.
 *
 *   key       = HKDF-SHA256(seed, BACKUP_SALT, "dina:backup:key:v1")  — seals copies
 *   signSeed  = HKDF-SHA256(seed, BACKUP_SALT, "dina:backup:sign:v1") — Ed25519 seed
 *   backupId  = hex(SHA-256(Ed25519 public key))
 *
 * The store files copies under `backupId`, never under the DID.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { getPublicKey } from '../crypto/ed25519';
import { BACKUP_SALT, deriveBackupKey, deriveBackupSignSeed } from '../crypto/hkdf';

export interface BackupIdentity {
  /** AES-256-GCM key the copies are sealed under. */
  key: Uint8Array;
  /** Ed25519 private key (seed form): signs copies and store calls. */
  signSeed: Uint8Array;
  publicKey: Uint8Array;
  /** 64 hex characters. */
  backupId: string;
}

export function backupIdForPublicKey(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey));
}

/** `masterSeed` is the same 32 bytes the vault keys come from. */
export function deriveBackupIdentity(masterSeed: Uint8Array): BackupIdentity {
  const key = deriveBackupKey(masterSeed, BACKUP_SALT);
  const signSeed = deriveBackupSignSeed(masterSeed, BACKUP_SALT);
  const publicKey = getPublicKey(signSeed);
  return { key, signSeed, publicKey, backupId: backupIdForPublicKey(publicKey) };
}
