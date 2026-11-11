/**
 * The backup-key check (USER_BACKUP.md §4.3).
 *
 * A call carries the Ed25519 public key in `X-Backup-Key`, an RFC3339
 * `X-Timestamp`, a hex `X-Nonce` and an `X-Signature` over Core's canonical
 * string (`@dina/protocol` `buildCanonicalPayload`). It passes only when:
 *   - SHA-256 of the key equals the `backup_id` in the path;
 *   - the signature verifies over this method, path, query and body;
 *   - the timestamp is within five minutes of now;
 *   - the nonce is new.
 * The signer side is `@dina/core` `backup/store_client.ts`.
 */

import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { buildCanonicalPayload } from '@dina/protocol';

// @noble/ed25519 v3 needs its SHA-512 named.
const edHashes = ed.hashes as { sha512?: (...msgs: Uint8Array[]) => Uint8Array };
edHashes.sha512 = (...msgs: Uint8Array[]) => {
  const h = sha512.create();
  for (const m of msgs) h.update(m);
  return h.digest();
};

export const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const HEX = /^[0-9a-f]+$/;

export type AuthRefusal =
  | 'missing_headers'
  | 'key_does_not_match_id'
  | 'bad_timestamp'
  | 'bad_signature'
  | 'replayed_nonce';

export interface SignedCall {
  method: string;
  path: string;
  query: string;
  body: Uint8Array;
  headers: Record<string, string | string[] | undefined>;
  backupId: string;
}

function header(h: SignedCall['headers'], name: string): string | undefined {
  const v = h[name.toLowerCase()];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function checkSignedCall(
  call: SignedCall,
  nowMs: number,
  claimNonce: (nonce: string) => boolean,
): AuthRefusal | null {
  const keyHex = header(call.headers, 'X-Backup-Key');
  const timestamp = header(call.headers, 'X-Timestamp');
  const nonce = header(call.headers, 'X-Nonce');
  const sigHex = header(call.headers, 'X-Signature');
  if (
    keyHex === undefined ||
    timestamp === undefined ||
    nonce === undefined ||
    sigHex === undefined
  ) {
    return 'missing_headers';
  }
  if (keyHex.length !== 64 || !HEX.test(keyHex)) return 'key_does_not_match_id';
  const key = hexToBytes(keyHex);
  if (bytesToHex(sha256(key)) !== call.backupId) return 'key_does_not_match_id';
  if (!RFC3339.test(timestamp)) return 'bad_timestamp';
  const at = Date.parse(timestamp);
  if (Number.isNaN(at) || Math.abs(nowMs - at) > TIMESTAMP_WINDOW_MS) return 'bad_timestamp';
  if (sigHex.length !== 128 || !HEX.test(sigHex) || nonce.length > 128) return 'bad_signature';
  const canonical = buildCanonicalPayload(
    call.method,
    call.path,
    call.query,
    timestamp,
    nonce,
    bytesToHex(sha256(call.body)),
  );
  let ok = false;
  try {
    ok = ed.verify(hexToBytes(sigHex), new TextEncoder().encode(canonical), key);
  } catch {
    ok = false;
  }
  if (!ok) return 'bad_signature';
  // Last, so a forged call cannot spend someone else's nonce.
  if (!claimNonce(`${call.backupId}:${nonce}`)) return 'replayed_nonce';
  return null;
}
