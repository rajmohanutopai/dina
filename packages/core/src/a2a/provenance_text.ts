/**
 * The one cleaning both sides of a provenance proof get (A2A design §6.2
 * step 2): invisible characters removed, then NFC. What Core records of the
 * owner's words and what Brain later claims are compared only after this, so
 * what is proven is what is sent.
 *
 * Core keeps no copy of the owner's words, only `utteranceDigest`: a proof
 * covers a whole message, so equal digests are the whole test.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { stripInvisible } from '@dina/a2a';

export function cleanForProvenance(s: string): string {
  return stripInvisible(s).normalize('NFC');
}

/** SHA-256 (hex) of a whole message, cleaned and trimmed. */
export function utteranceDigest(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(cleanForProvenance(text).trim())));
}
