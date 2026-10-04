/**
 * The gateway's own service key: a raw 32-byte Ed25519 seed in its key
 * directory, readable by the gateway's OS user only. It signs the gateway's
 * calls into Core and nothing else; Core knows only its did:key, registered
 * as caller type `gateway`. The gateway never holds Core's master seed,
 * Brain's key, or any vault key (design §4.1).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { deriveDIDKey, getPublicKey } from '@dina/core';

export interface GatewayServiceKey {
  seed: Uint8Array;
  did: string;
}

export type ServiceKeyLoad =
  | { ok: true; key: GatewayServiceKey }
  | { ok: false; reason: 'key_missing' | 'key_unreadable' | 'key_invalid' | 'did_mismatch' };

export async function loadServiceKey(dir: string, file: string, expectedDid?: string): Promise<ServiceKeyLoad> {
  if (dir === '') return { ok: false, reason: 'key_missing' };
  let bytes: Uint8Array;
  try {
    bytes = await readFile(join(dir, file));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'key_missing' : 'key_unreadable' };
  }
  if (bytes.byteLength !== 32) return { ok: false, reason: 'key_invalid' };
  const seed = new Uint8Array(bytes);
  const did = deriveDIDKey(getPublicKey(seed));
  if (expectedDid !== undefined && expectedDid !== did) return { ok: false, reason: 'did_mismatch' };
  return { ok: true, key: { seed, did } };
}
