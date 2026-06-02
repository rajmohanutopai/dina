/**
 * Send a signed POST /v1/service/query against the lite Core using
 * the admin key. Triggers the egress D2D path; the same lite Core
 * receives the message back through MsgBox loopback, mints a
 * workflow_task, the daemon claims+executes, and the Response Bridge
 * pushes service.response back to admin DID (whom we register as the
 * sender below — service.response will land via the same MsgBox WS).
 */

import { readFile } from 'node:fs/promises';

import { Crypto, HttpClient, createCanonicalRequestSigner } from '@dina/adapters-node';
import { deriveDIDKey, getPublicKey } from '@dina/core';
import { computeSchemaHash, listCapabilities } from '@dina/brain';

async function main(): Promise<void> {
  const targetDid =
    process.argv[2] ?? 'did:plc:gzw2idhdc4b6k3wsyqmhyyuw';
  const capability = process.argv[3] ?? 'eta_query';
  const paramsJson = process.argv[4] ?? '{"route_id":"42","stop_id":"100"}';

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

  const queryId = `q-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(16)}`;
  const cap = listCapabilities().find((c) => c.name === capability);
  // Registry caps (eta_query) compute schema_hash from the local wire-schema.
  // Non-registry caps (price_check / custom NSIDs) have no local wire-schema —
  // the real product path skips sender-side schema validation and trusts the
  // discovered listing's schema_hash. This harness accepts that hash via argv[6]
  // so multi-service / custom flows can be driven without a registry entry.
  const schemaHashOverride = process.argv[6];
  if (cap === undefined && schemaHashOverride === undefined) {
    throw new Error(
      `capability "${capability}" not in local registry — pass schema_hash as argv[6] (from the published listing)`,
    );
  }
  const schemaHash = cap !== undefined ? computeSchemaHash(cap.paramsSchema) : schemaHashOverride!;
  // service_uri = the "link / QR / invite" access grant for a specific
  // listing. When present, egress trusts it (authority must == recipient)
  // and skips the AppView public-discovery check — the path for invoking
  // an unlisted service, and the way to drive the flow when AppView
  // discovery is unavailable. Defaults to the target's `self` listing.
  const serviceUri =
    process.argv[5] ?? `at://${targetDid}/com.dinakernel.service.profile/self`;
  const queryBody = {
    to_did: targetDid,
    capability,
    query_id: queryId,
    params: JSON.parse(paramsJson),
    ttl_seconds: 60,
    service_name: 'Dina Lite Bus 42',
    schema_hash: schemaHash,
    service_uri: serviceUri,
  };
  const bodyBytes = new TextEncoder().encode(JSON.stringify(queryBody));
  const signed = await signer({
    method: 'POST',
    path: '/v1/service/query',
    query: '',
    body: bodyBytes,
  });

  const client = new HttpClient({ timeoutMs: 15000 });
  const res = await client.request('http://127.0.0.1:18298/v1/service/query', {
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
  console.log('admin DID:', did);
  console.log('target:', targetDid, capability, paramsJson);
  console.log('status:', res.status);
  const bodyStr = typeof res.body === 'string' ? res.body : new TextDecoder().decode(res.body);
  console.log('body:', bodyStr);
}

main().catch((err) => {
  console.error('[send_service_query] FAILED:', err.message);
  process.exit(1);
});
