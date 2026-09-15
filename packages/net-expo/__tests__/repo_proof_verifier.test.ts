/**
 * The phone's repo-proof verifier (§5.C1-mobile): the SAME chain the server
 * runs (`@dina/home-node/repo_proof_chain`), reached through this package's
 * STATIC imports of `@atproto/identity` + `@atproto/repo` — the module Metro
 * bundles. The chain's full negative matrix lives in `@dina/net-node`'s suite
 * (one function, one set of tests); this suite proves the static-import route
 * yields a working verifier and re-pins the two properties an install hangs on:
 * an authentic release verifies, and a commit for another DID does not.
 */

import { Secp256k1Keypair } from '@atproto/crypto';
import { blocksToCarFile, MemoryBlockstore, Repo, WriteOpAction } from '@atproto/repo';

import { releaseRkeyFromCid } from '@dina/protocol';

import { createRepoProofVerifier, selfCheckRepoProofVerifier, type DidDoc } from '../src/repo_proof_verifier';

const COLLECTION = 'com.dinakernel.plugin.release';
const REPO_DID = 'did:plc:testpublisher00000000000';
const RECORD = { $type: COLLECTION, plugin_id: 'com.acme.pack', version: '1.0.0' };

function didDocFor(signingKey: string, did = REPO_DID): DidDoc {
  return {
    id: did,
    verificationMethod: [
      { id: `${did}#atproto`, type: 'Multikey', controller: did, publicKeyMultibase: signingKey.replace(/^did:key:/, '') },
    ],
    service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example.com' }],
  };
}

async function mintRelease(keypair: Secp256k1Keypair): Promise<{ car: Uint8Array; cid: string; rkey: string }> {
  const probeStorage = new MemoryBlockstore();
  const probe = await Repo.create(probeStorage, REPO_DID, keypair, [
    { action: WriteOpAction.Create, collection: COLLECTION, rkey: '3jzfcijpj2z2a', record: RECORD },
  ]);
  const probeCid = await probe.data.get(`${COLLECTION}/3jzfcijpj2z2a`);
  if (probeCid === null) throw new Error('record not stored');
  const rkey = releaseRkeyFromCid(probeCid.toString());
  if (rkey === null) throw new Error('unexpected CID shape');
  const storage = new MemoryBlockstore();
  const repo = await Repo.create(storage, REPO_DID, keypair, [
    { action: WriteOpAction.Create, collection: COLLECTION, rkey, record: RECORD },
  ]);
  const cid = await repo.data.get(`${COLLECTION}/${rkey}`);
  if (cid === null) throw new Error('record not stored');
  const car = await blocksToCarFile(repo.cid, storage.blocks);
  return { car, cid: cid.toString(), rkey };
}

const carResponse = (car: Uint8Array) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => car.buffer.slice(car.byteOffset, car.byteOffset + car.byteLength),
});

describe('the phone verifier over static @atproto imports (§5.C1-mobile)', () => {
  it('verifies an authentic, immutable release through the shared chain', async () => {
    const keypair = await Secp256k1Keypair.create();
    const { car, cid, rkey } = await mintRelease(keypair);
    const result = await createRepoProofVerifier({
      fetch: async () => carResponse(car),
      resolveDid: async () => didDocFor(keypair.did()),
    })({ did: REPO_DID, collection: COLLECTION, rkey });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cid).toBe(cid);
      expect(result.record).toMatchObject(RECORD);
    }
  });

  it('the self-check runs the whole chain over the shipped fixture through these imports', async () => {
    await expect(selfCheckRepoProofVerifier()).resolves.toEqual({ ok: true });
  });

  it('binds the commit to the requested DID', async () => {
    const keypair = await Secp256k1Keypair.create();
    const { car, rkey } = await mintRelease(keypair);
    const result = await createRepoProofVerifier({
      fetch: async () => carResponse(car),
      resolveDid: async () => didDocFor(keypair.did(), 'did:web:evil.example'),
    })({ did: 'did:web:evil.example', collection: COLLECTION, rkey });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('signature_invalid');
  });
});
