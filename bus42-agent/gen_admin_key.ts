import { writeFile } from 'node:fs/promises';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { deriveDIDKey, getPublicKey } from '@dina/core';

async function main(): Promise<void> {
  // `Crypto.randomBytes` from `@dina/adapters-node` is async — using
  // node:crypto directly here avoids the unawaited-Promise pitfall.
  const seed = new Uint8Array(nodeRandomBytes(32));
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
