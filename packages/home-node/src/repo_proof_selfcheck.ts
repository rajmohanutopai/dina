/**
 * The repo-proof SELF-CHECK (RESEARCHER_KERNEL §5.C1): run the whole chain
 * once, offline, against a fixture repo this package ships, and report whether
 * it RAN on this host.
 *
 * WHY. The chain wraps every library call and maps a throw to a permanent
 * failure code (`record_malformed`, `signature_invalid`, `proof_invalid`) —
 * correct for a hostile CAR, wrong for a platform fault: on a runtime missing a
 * global the library needs (Hermes and `Buffer`), a genuine release would be
 * reported to the owner as a release that failed authenticity. The self-check
 * separates the two. A host that fails it must not wire the verifier at all;
 * its install door stays closed and says so.
 *
 * The fixture (`repo_proof_fixture.ts`) is served by a resolver and a fetch
 * that live inside this function — nothing reaches the network, and the
 * fixture's DID is trusted for nothing beyond this check.
 */

import { createRepoProofChain, type AtprotoLibs, type DidDoc } from './repo_proof_chain';
import { REPO_PROOF_FIXTURE } from './repo_proof_fixture';

export type RepoProofSelfCheck =
  | { ok: true }
  /** `fault` is a class name or a failure code — metadata, never request data. */
  | { ok: false; fault: string };

/** The fixture's DID document: its signing key and an https PDS the fetch below answers for. */
function fixtureDidDoc(): DidDoc {
  const { did, signingKey, pds } = REPO_PROOF_FIXTURE;
  return {
    id: did,
    verificationMethod: [{ id: `${did}#atproto`, type: 'Multikey', controller: did, publicKeyMultibase: signingKey }],
    service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds }],
  };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function selfCheckRepoProofChain(libs: AtprotoLibs): Promise<RepoProofSelfCheck> {
  const car = hexToBytes(REPO_PROOF_FIXTURE.carHex);
  const verify = createRepoProofChain({
    libs,
    resolveDid: async () => fixtureDidDoc(),
    fetch: async () => ({
      ok: true,
      status: 200,
      body: null,
      arrayBuffer: async () => car.buffer.slice(car.byteOffset, car.byteOffset + car.byteLength),
    }),
  });
  let result;
  try {
    result = await verify({
      did: REPO_PROOF_FIXTURE.did,
      collection: REPO_PROOF_FIXTURE.collection,
      rkey: REPO_PROOF_FIXTURE.rkey,
    });
  } catch (err) {
    return { ok: false, fault: err instanceof Error ? err.constructor.name : typeof err };
  }
  if (!result.ok) return { ok: false, fault: result.code };
  if (result.cid !== REPO_PROOF_FIXTURE.cid) return { ok: false, fault: 'cid_mismatch' };
  return { ok: true };
}
