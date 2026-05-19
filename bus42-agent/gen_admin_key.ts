import { writeFile } from 'node:fs/promises';
import { Crypto } from '@dina/adapters-node';
import { deriveDIDKey, getPublicKey } from '@dina/core';

async function main(): Promise<void> {
  const crypto = new Crypto();
  const seedBuf = crypto.randomBytes(32);
  // noble's strict Uint8Array check rejects Buffer subclass — copy
  // bytes into a fresh Uint8Array so length/type both match.
  const seed = new Uint8Array(32);
  seed.set(seedBuf);
  const pub = getPublicKey(seed);
  const did = deriveDIDKey(pub);

  await writeFile('/tmp/dina-cic-admin.ed25519', Buffer.from(seed), { mode: 0o600 });
  await writeFile('/tmp/dina-cic-admin-did', did);
  console.log('admin DID:', did);
  console.log('admin key saved: /tmp/dina-cic-admin.ed25519');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
