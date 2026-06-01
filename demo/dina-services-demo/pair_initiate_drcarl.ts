/**
 * Mint a pairing code on the Dr Carl lite Core (:18299) so the
 * drcarl-agent can complete pairing via `dina configure --pairing-code`.
 *
 * Same as pair_initiate.ts but targets the second node + uses the Dr
 * Carl admin key (/tmp/drcarl-admin.ed25519, whose DID is registered as
 * DINA_ADMIN_DID on the :18299 Core).
 */

import { readFile } from 'node:fs/promises';

import { Crypto, HttpClient, createCanonicalRequestSigner } from '@dina/adapters-node';
import { deriveDIDKey, getPublicKey } from '@dina/core';

async function main(): Promise<void> {
  const seedBuf = await readFile('/tmp/drcarl-admin.ed25519');
  const seed = new Uint8Array(32);
  seed.set(seedBuf);
  const crypto = new Crypto();
  const did = deriveDIDKey(getPublicKey(seed));
  const signer = createCanonicalRequestSigner({
    did,
    privateKey: seed,
    sign: (priv, msg) => crypto.ed25519Sign(priv, msg),
    nonce: (n) => Promise.resolve(crypto.randomBytes(n)),
  });

  const bodyBytes = new TextEncoder().encode(
    JSON.stringify({ device_name: 'drcarl-agent', role: 'agent' }),
  );
  const signed = await signer({
    method: 'POST',
    path: '/v1/pair/initiate',
    query: '',
    body: bodyBytes,
  });

  const client = new HttpClient({ timeoutMs: 10000 });
  const res = await client.request('http://127.0.0.1:18299/v1/pair/initiate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-DID': signed.did,
      'X-Timestamp': signed.timestamp,
      'X-Nonce': signed.nonce,
      'X-Signature': signed.signature,
    },
    body: bodyBytes,
  });
  console.log('status:', res.status);
  console.log('body:', typeof res.body === 'string' ? res.body : new TextDecoder().decode(res.body));
}

main().catch((err) => {
  console.error('[pair_initiate_drcarl] FAILED:', err.message);
  process.exit(1);
});
