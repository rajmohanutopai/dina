/**
 * Mint a pairing code on lite Core so the dina-agent venv can complete
 * pairing via `dina configure --pairing-code <code>`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Crypto, HttpClient, createCanonicalRequestSigner } from '@dina/adapters-node';
import { deriveDIDKey, getPublicKey } from '@dina/core';

async function main(): Promise<void> {
  // Use the admin key (not brain) — only admin role is authorized
  // for POST /v1/pair/initiate per Core's authz allowlist.
  const seedBuf = await readFile('/tmp/dina-cic-admin.ed25519');
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
    JSON.stringify({ device_name: 'bus42-agent', role: 'agent' }),
  );
  const signed = await signer({
    method: 'POST',
    path: '/v1/pair/initiate',
    query: '',
    body: bodyBytes,
  });

  const client = new HttpClient({ timeoutMs: 10000 });
  const res = await client.request('http://127.0.0.1:18298/v1/pair/initiate', {
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
  console.error('[pair_initiate] FAILED:', err.message);
  process.exit(1);
});
