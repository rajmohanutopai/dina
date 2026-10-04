/**
 * `keygen`: create the gateway's service key, once. Writes a random 32-byte
 * Ed25519 seed to the key file (mode 0600), refusing to replace one that
 * exists, and prints the did:key Core must register (DINA_A2A_GATEWAY_DID).
 * An existing key is read and its DID printed, so the step is safe to rerun.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadServiceKey } from './service_key';

export async function ensureServiceKey(dir: string, file: string): Promise<{ did: string; created: boolean }> {
  const existing = await loadServiceKey(dir, file);
  if (existing.ok) return { did: existing.key.did, created: false };
  if (existing.reason !== 'key_missing' || dir === '') {
    throw new Error(`cannot create the gateway key: ${dir === '' ? 'no key directory' : existing.reason}`);
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // `wx`: never replace a key another process wrote in the meantime.
  await writeFile(join(dir, file), randomBytes(32), { flag: 'wx', mode: 0o600 });
  const created = await loadServiceKey(dir, file);
  if (!created.ok) throw new Error(`the new gateway key does not load: ${created.reason}`);
  return { did: created.key.did, created: true };
}
