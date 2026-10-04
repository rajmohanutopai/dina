/**
 * The one digest A2A uses everywhere: lowercase sha256 hex over UTF-8 text,
 * and over the RFC 8785 form of a JSON value.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { canonicalize } from '@dina/a2a';

export function sha256HexOfText(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

/** Throws `JcsError` when `value` has no RFC 8785 form (callers at a trust boundary catch it). */
export function canonicalDigest(value: unknown): string {
  return sha256HexOfText(canonicalize(value));
}
