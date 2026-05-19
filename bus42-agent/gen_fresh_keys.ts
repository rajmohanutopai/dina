/**
 * Mint fresh brain + admin Ed25519 seeds for a brand-new lite Core
 * install. Uses node:crypto.randomBytes directly to avoid the
 * unawaited-Promise bug that `gen_admin_key.ts` had (Crypto.randomBytes
 * from @dina/adapters-node is async; calling .set() on the returned
 * Promise silently produced an all-zeros seed every time).
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { deriveDIDKey, getPublicKey } from '@dina/core';

async function main(): Promise<void> {
  const keyDir = process.argv[2];
  if (!keyDir) throw new Error('usage: tsx gen_fresh_keys.ts <key-dir>');

  const brainSeed = new Uint8Array(nodeRandomBytes(32));
  await writeFile(join(keyDir, 'brain.ed25519'), Buffer.from(brainSeed), { mode: 0o600 });
  const brainDid = deriveDIDKey(getPublicKey(brainSeed));
  await writeFile('/tmp/dina-cic-fresh-brain-did', brainDid);

  const adminSeed = new Uint8Array(nodeRandomBytes(32));
  await writeFile('/tmp/dina-cic-fresh-admin.ed25519', Buffer.from(adminSeed), { mode: 0o600 });
  const adminDid = deriveDIDKey(getPublicKey(adminSeed));
  await writeFile('/tmp/dina-cic-fresh-admin-did', adminDid);

  console.log('brain DID:', brainDid);
  console.log('admin DID:', adminDid);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
