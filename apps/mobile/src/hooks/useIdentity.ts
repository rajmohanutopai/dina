/**
 * Identity settings hook — data layer for Settings → Identity screen.
 *
 * Provides:
 *   - Current DID and public key multibase
 *   - DID Document for display
 *   - Mnemonic backup (gated by passphrase confirmation)
 *   - Identity creation timestamp
 *   - Messaging service endpoint (if configured)
 *
 * Security: mnemonic is NEVER exposed unless the user confirms their
 * passphrase. The hook tracks whether the passphrase was confirmed
 * in the current session.
 *
 * Source: ARCHITECTURE.md Task 4.14
 */

import { getPublicKey } from '../../../core/src/crypto/ed25519';
import { deriveDIDKey, publicKeyToMultibase } from '../../../core/src/identity/did';
import {
  buildDIDDocument,
  validateDIDDocument,
  getMessagingService,
  type DIDDocument,
} from '../../../core/src/identity/did_document';

export interface IdentityInfo {
  did: string;
  publicKeyMultibase: string;
  didDocument: DIDDocument;
  documentValid: boolean;
  validationErrors: string[];
  messagingEndpoint: string | null;
  createdAt: number;
}

export interface MnemonicBackup {
  words: string[];
  confirmed: boolean;
  expiresAt: number; // auto-clear after 60 seconds
}

/** In-memory identity state. */
let currentSeed: Uint8Array | null = null;
let currentMnemonic: string | null = null;
let identityCreatedAt: number = 0;
let mnemonicBackup: MnemonicBackup | null = null;

import { MNEMONIC_DISPLAY_TTL_MS as MNEMONIC_TTL } from '../../../core/src/constants';
const MNEMONIC_DISPLAY_TTL_MS = MNEMONIC_TTL;

/**
 * Initialize identity from seed (called after unlock).
 */
export function initIdentity(seed: Uint8Array, mnemonic: string, createdAt?: number): void {
  currentSeed = seed;
  currentMnemonic = mnemonic;
  identityCreatedAt = createdAt ?? Date.now();
}

/**
 * Get the current identity info for display.
 * Returns null if identity not initialized.
 */
export function getIdentityInfo(msgboxEndpoint?: string): IdentityInfo | null {
  if (!currentSeed) return null;

  const pubKey = getPublicKey(currentSeed);
  const did = deriveDIDKey(pubKey);
  const multibase = publicKeyToMultibase(pubKey);
  const doc = buildDIDDocument(did, multibase, msgboxEndpoint);
  const errors = validateDIDDocument(doc);
  const msgService = getMessagingService(doc);

  return {
    did,
    publicKeyMultibase: multibase,
    didDocument: doc,
    documentValid: errors.length === 0,
    validationErrors: errors,
    messagingEndpoint: msgService?.endpoint ?? null,
    createdAt: identityCreatedAt,
  };
}

/**
 * Request mnemonic backup display.
 *
 * The mnemonic is only exposed after passphrase confirmation.
 * Returns the words array, which auto-expires after 60 seconds.
 *
 * @param passphraseConfirmed — caller must verify passphrase before calling
 */
export function requestMnemonicBackup(passphraseConfirmed: boolean): MnemonicBackup | null {
  if (!passphraseConfirmed) return null;
  if (!currentMnemonic) return null;

  mnemonicBackup = {
    words: currentMnemonic.split(' '),
    confirmed: true,
    expiresAt: Date.now() + MNEMONIC_DISPLAY_TTL_MS,
  };

  return mnemonicBackup;
}

/**
 * Check if the mnemonic backup is still visible (not expired).
 */
export function isMnemonicVisible(): boolean {
  if (!mnemonicBackup) return false;
  if (Date.now() > mnemonicBackup.expiresAt) {
    clearMnemonicBackup();
    return false;
  }
  return true;
}

/**
 * Clear the mnemonic backup from memory (user dismissed or timer expired).
 */
export function clearMnemonicBackup(): void {
  mnemonicBackup = null;
}

/**
 * Get the DID in short format for display (first 8 + last 4 chars).
 */
export function getShortDID(): string | null {
  const info = getIdentityInfo();
  if (!info) return null;
  const did = info.did;
  if (did.length <= 20) return did;
  return `${did.slice(0, 16)}...${did.slice(-4)}`;
}

/**
 * Check if identity is initialized.
 */
export function hasIdentity(): boolean {
  return currentSeed !== null;
}

/**
 * Reset identity state (for testing).
 */
export function resetIdentityHook(): void {
  currentSeed = null;
  currentMnemonic = null;
  identityCreatedAt = 0;
  mnemonicBackup = null;
}
