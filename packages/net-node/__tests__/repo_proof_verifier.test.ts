/**
 * The production repo-proof verifier (§5.C1), tested fully OFFLINE: the test
 * mints a REAL signed AT-Protocol repo with a plugin-release record using the
 * same `@atproto/repo` write path, exports its proof CAR, and constructs the
 * matching DID document — then drives the verifier through injected `fetch` +
 * `resolveDid`. Positive path plus the hard-fail codes the §5 UX contract splits
 * on: `signature_invalid`, `rkey_mismatch`, `record_malformed`, `deleted`, and
 * the transient `fetch_failed`.
 *
 * `@atproto/*` are ESM-only; this suite runs under CommonJS ts-jest, so they are
 * loaded via a real dynamic `import()` (as the verifier does).
 */

import { selfCheckRepoProofChain, type AtprotoLibs } from '@dina/home-node/repo_proof_chain';
import { releaseRkeyFromCid } from '@dina/protocol';

import {
  createRepoProofVerifier,
  type DidDoc,
  type FetchInitLike,
  type FetchResponseLike,
} from '../src/repo_proof_verifier';

const esmImport = new Function('s', 'return import(s)') as <T>(specifier: string) => Promise<T>;

interface Keypair {
  did(): string;
}
interface AtCid {
  toString(): string;
}
interface AtRepo {
  cid: AtCid;
  commit: { data: AtCid };
  data: { get(key: string): Promise<AtCid | null> };
}
interface AtBlockMap extends Iterable<[AtCid, Uint8Array]> {
  set(cid: AtCid, bytes: Uint8Array): AtBlockMap;
  delete(cid: AtCid): AtBlockMap;
}
interface CryptoModule {
  Secp256k1Keypair: { create(): Promise<Keypair> };
}
interface RepoModule {
  BlockMap: new () => AtBlockMap;
  MemoryBlockstore: new () => { blocks: AtBlockMap };
  Repo: {
    create(
      storage: unknown,
      did: string,
      keypair: Keypair,
      writes: { collection: string; rkey: string; record: unknown }[],
    ): Promise<AtRepo>;
  };
  blocksToCarFile(root: AtCid, blocks: unknown): Promise<Uint8Array>;
}

let crypto: CryptoModule;
let repoLib: RepoModule;

beforeAll(async () => {
  crypto = await esmImport<CryptoModule>('@atproto/crypto');
  repoLib = await esmImport<RepoModule>('@atproto/repo');
});

const COLLECTION = 'com.dinakernel.plugin.release';
const REPO_DID = 'did:plc:testpublisher00000000000';
const RECORD = { $type: COLLECTION, plugin_id: 'com.acme.pack', version: '1.0.0' };

function didDocFor(signingKey: string, did = REPO_DID, pds = 'https://pds.example.com'): DidDoc {
  return {
    id: did,
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: signingKey.replace(/^did:key:/, ''),
      },
    ],
    service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds }],
  };
}

function carResponse(car: Uint8Array): FetchResponseLike {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => car.buffer.slice(car.byteOffset, car.byteOffset + car.byteLength),
  };
}

/** A fetch that serves `car` and records what it was asked for. */
function servingFetch(car: Uint8Array): {
  fetch: (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;
  calls: { url: string; init: FetchInitLike }[];
} {
  const calls: { url: string; init: FetchInitLike }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return carResponse(car);
    },
  };
}

/** A signed repo holding RECORD at `rkey` → its proof CAR + the record's CID. */
async function mintRepo(
  keypair: Keypair,
  rkey: string,
  opts: { did?: string; dropMstRoot?: boolean } = {},
): Promise<{ car: Uint8Array; cid: string }> {
  const storage = new repoLib.MemoryBlockstore();
  const repo = await repoLib.Repo.create(storage, opts.did ?? REPO_DID, keypair, [
    { collection: COLLECTION, rkey, record: RECORD },
  ]);
  const cid = await repo.data.get(`${COLLECTION}/${rkey}`);
  if (cid === null) throw new Error('record not stored');
  let blocks = storage.blocks;
  if (opts.dropMstRoot === true) {
    // A CAR whose commit is intact but whose MST root block is missing: the
    // signature still verifies, the inclusion walk cannot.
    const pruned = new repoLib.BlockMap();
    for (const [blockCid, bytes] of storage.blocks) pruned.set(blockCid, bytes);
    pruned.delete(repo.commit.data);
    blocks = pruned;
  }
  const car = await repoLib.blocksToCarFile(repo.cid, blocks);
  return { car, cid: cid.toString() };
}

/** A VALID release: rkey = f(record CID). */
async function mintRelease(keypair: Keypair): Promise<{ car: Uint8Array; cid: string; rkey: string }> {
  // Store once at a throwaway rkey to learn the content CID, derive the
  // content-addressed rkey, then mint the repo at that rkey (same CID).
  const probe = await mintRepo(keypair, '3jzfcijpj2z2a');
  const rkey = releaseRkeyFromCid(probe.cid);
  if (rkey === null) throw new Error(`unexpected CID shape: ${probe.cid}`);
  const real = await mintRepo(keypair, rkey);
  return { ...real, rkey };
}

describe('createRepoProofVerifier (§5.C1)', () => {
  it('verifies an authentic, immutable release (repo proof, commit sig, rkey=f(cid))', async () => {
    const keypair = await crypto.Secp256k1Keypair.create();
    const { car, cid, rkey } = await mintRelease(keypair);

    const result = await createRepoProofVerifier({
      fetch: async () => carResponse(car),
      resolveDid: async () => didDocFor(keypair.did()),
    })({ did: REPO_DID, collection: COLLECTION, rkey });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cid).toBe(cid);
      expect(result.record).toMatchObject(RECORD);
      expect(result.rev).not.toBe('');
    }
  });

  it('rejects a commit signed by a DIFFERENT key (signature_invalid)', async () => {
    const keypair = await crypto.Secp256k1Keypair.create();
    const { car, rkey } = await mintRelease(keypair);
    const impostor = await crypto.Secp256k1Keypair.create();

    const result = await createRepoProofVerifier({
      fetch: async () => carResponse(car),
      resolveDid: async () => didDocFor(impostor.did()),
    })({ did: REPO_DID, collection: COLLECTION, rkey });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('signature_invalid');
  });

  it('rejects an overwritten release where rkey != f(cid) (rkey_mismatch)', async () => {
    const keypair = await crypto.Secp256k1Keypair.create();
    const forgedRkey = '3jzfcijpj2z2a';
    const { car } = await mintRepo(keypair, forgedRkey);

    const result = await createRepoProofVerifier({
      fetch: async () => carResponse(car),
      resolveDid: async () => didDocFor(keypair.did()),
    })({ did: REPO_DID, collection: COLLECTION, rkey: forgedRkey });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('rkey_mismatch');
  });

  it('rejects a malformed CAR (record_malformed)', async () => {
    const keypair = await crypto.Secp256k1Keypair.create();
    const { rkey } = await mintRelease(keypair);

    const result = await createRepoProofVerifier({
      fetch: async () => carResponse(new Uint8Array([1, 2, 3, 4, 5])),
      resolveDid: async () => didDocFor(keypair.did()),
    })({ did: REPO_DID, collection: COLLECTION, rkey });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('record_malformed');
  });

  it('maps a 404 to deleted, a transport error to the transient fetch_failed', async () => {
    const keypair = await crypto.Secp256k1Keypair.create();
    const { rkey } = await mintRelease(keypair);
    const doc = didDocFor(keypair.did());

    const deleted = await createRepoProofVerifier({
      fetch: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
      resolveDid: async () => doc,
    })({ did: REPO_DID, collection: COLLECTION, rkey });
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.code).toBe('deleted');

    const down = await createRepoProofVerifier({
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
      resolveDid: async () => doc,
    })({ did: REPO_DID, collection: COLLECTION, rkey });
    expect(down.ok).toBe(false);
    if (!down.ok) {
      expect(down.code).toBe('fetch_failed');
      expect(down.transient).toBe(true);
    }
  });

  it('binds the commit to the REQUESTED DID: a look-alike DID document listing the publisher’s key is refused', async () => {
    // did:web:evil.example lists B's public key and serves B's genuine CAR.
    const publisher = await crypto.Secp256k1Keypair.create();
    const { car, rkey } = await mintRelease(publisher);
    const evil = 'did:web:evil.example';

    const result = await createRepoProofVerifier({
      fetch: async () => carResponse(car),
      resolveDid: async () => didDocFor(publisher.did(), evil, 'https://evil.example'),
    })({ did: evil, collection: COLLECTION, rkey });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('signature_invalid');
      expect(result.transient).toBe(false);
      expect(result.message).toContain(`belongs to ${REPO_DID}`);
    }
  });

  it('MST inclusion: an rkey the repo does not hold is not_found; a proof missing its tree root is proof_invalid', async () => {
    const keypair = await crypto.Secp256k1Keypair.create();
    const { car } = await mintRelease(keypair);
    const doc = didDocFor(keypair.did());

    const absent = await createRepoProofVerifier({
      fetch: async () => carResponse(car),
      resolveDid: async () => doc,
    })({ did: REPO_DID, collection: COLLECTION, rkey: '3jzfcijpj2z2a' });
    expect(absent.ok).toBe(false);
    if (!absent.ok) {
      expect(absent.code).toBe('not_found');
      expect(absent.transient).toBe(false);
    }

    const probe = await mintRepo(keypair, '3jzfcijpj2z2a');
    const rkey = releaseRkeyFromCid(probe.cid);
    if (rkey === null) throw new Error('unexpected CID shape');
    const pruned = await mintRepo(keypair, rkey, { dropMstRoot: true });
    const broken = await createRepoProofVerifier({
      fetch: async () => carResponse(pruned.car),
      resolveDid: async () => doc,
    })({ did: REPO_DID, collection: COLLECTION, rkey });
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      expect(broken.code).toBe('proof_invalid');
      expect(broken.transient).toBe(false);
    }
  });

  it('the DID leg: resolves key + PDS, fetches the exact sync.getRecord URL with no redirects and a deadline', async () => {
    const keypair = await crypto.Secp256k1Keypair.create();
    const { car, rkey } = await mintRelease(keypair);
    const served = servingFetch(car);

    const result = await createRepoProofVerifier({
      fetch: served.fetch,
      resolveDid: async () => didDocFor(keypair.did(), REPO_DID, 'https://pds.example.com/'),
    })({ did: REPO_DID, collection: COLLECTION, rkey });
    expect(result.ok).toBe(true);
    expect(served.calls).toHaveLength(1);
    expect(served.calls[0]?.url).toBe(
      `https://pds.example.com/xrpc/com.atproto.sync.getRecord?did=${encodeURIComponent(REPO_DID)}` +
        `&collection=${encodeURIComponent(COLLECTION)}&rkey=${encodeURIComponent(rkey)}`,
    );
    expect(served.calls[0]?.init.redirect).toBe('error');
    expect(served.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('the DID leg: every resolution failure is did_resolution_failed and transient', async () => {
    const keypair = await crypto.Secp256k1Keypair.create();
    const { car, rkey } = await mintRelease(keypair);
    const req = { did: REPO_DID, collection: COLLECTION, rkey };
    const fetch = async (): Promise<FetchResponseLike> => carResponse(car);
    const good = didDocFor(keypair.did());

    const cases: { name: string; resolveDid: () => Promise<DidDoc | null> }[] = [
      { name: 'resolver throws', resolveDid: async () => { throw new Error('plc down'); } },
      { name: 'resolver returns null', resolveDid: async () => null },
      { name: 'no signing key', resolveDid: async () => ({ ...good, verificationMethod: [] }) },
      { name: 'no PDS service', resolveDid: async () => ({ ...good, service: [] }) },
      {
        name: 'http PDS',
        resolveDid: async () => didDocFor(keypair.did(), REPO_DID, 'http://pds.example.com'),
      },
      {
        name: 'a PDS service of the wrong type',
        resolveDid: async () => ({
          ...good,
          service: [{ id: '#atproto_pds', type: 'SomethingElse', serviceEndpoint: 'https://pds.example.com' }],
        }),
      },
    ];
    for (const c of cases) {
      const result = await createRepoProofVerifier({ fetch, resolveDid: c.resolveDid })(req);
      expect({ name: c.name, ok: result.ok }).toEqual({ name: c.name, ok: false });
      if (!result.ok) {
        expect({ name: c.name, code: result.code }).toEqual({ name: c.name, code: 'did_resolution_failed' });
        expect(result.transient).toBe(true);
      }
    }
  });

  it('a fetch that never answers hits the deadline (fetch_failed); an oversized CAR is refused without decoding', async () => {
    const keypair = await crypto.Secp256k1Keypair.create();
    const { car, rkey } = await mintRelease(keypair);
    const doc = didDocFor(keypair.did());

    const stalled = await createRepoProofVerifier({
      fetchTimeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      resolveDid: async () => doc,
    })({ did: REPO_DID, collection: COLLECTION, rkey });
    expect(stalled.ok).toBe(false);
    if (!stalled.ok) {
      expect(stalled.code).toBe('fetch_failed');
      expect(stalled.transient).toBe(true);
    }

    const oversized = await createRepoProofVerifier({
      maxCarBytes: car.byteLength - 1,
      fetch: async () => carResponse(car),
      resolveDid: async () => doc,
    })({ did: REPO_DID, collection: COLLECTION, rkey });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.code).toBe('record_malformed');
      expect(oversized.message).toContain('ceiling');
    }

    // A STREAMING body is abandoned at the ceiling: the reader stops pulling
    // chunks, so an endless body never gets buffered.
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const streamed = await createRepoProofVerifier({
      maxCarBytes: 4096,
      fetch: async () => ({ ok: true, status: 200, body: endless, arrayBuffer: async () => new ArrayBuffer(0) }),
      resolveDid: async () => doc,
    })({ did: REPO_DID, collection: COLLECTION, rkey });
    expect(streamed.ok).toBe(false);
    if (!streamed.ok) expect(streamed.code).toBe('record_malformed');
    expect(pulled).toBeLessThan(16);

    // And a streaming body UNDER the ceiling verifies exactly like a buffered one.
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(car.slice(0, 100));
        controller.enqueue(car.slice(100));
        controller.close();
      },
    });
    const viaStream = await createRepoProofVerifier({
      fetch: async () => ({ ok: true, status: 200, body: chunked, arrayBuffer: async () => new ArrayBuffer(0) }),
      resolveDid: async () => doc,
    })({ did: REPO_DID, collection: COLLECTION, rkey });
    expect(viaStream.ok).toBe(true);
  });
});

describe('selfCheckRepoProofChain (§5.C1 — does the chain run on this host?)', () => {
  const realLibs: AtprotoLibs = {
    identity: () => esmImport('@atproto/identity'),
    repo: () => esmImport('@atproto/repo'),
  };

  it('passes with the real libraries against the shipped fixture — CAR read, signature, MST walk, rkey=f(cid)', async () => {
    await expect(selfCheckRepoProofChain(realLibs)).resolves.toEqual({ ok: true });
  });

  it('reports a platform fault by class name when a library throws — never as a verdict on a release', async () => {
    const repo = await esmImport<Record<string, unknown>>('@atproto/repo');
    const faulty: AtprotoLibs = {
      identity: realLibs.identity,
      repo: async () =>
        ({
          ...repo,
          readCarWithRoot: () => {
            throw new ReferenceError('Buffer is not defined');
          },
        }) as unknown as Awaited<ReturnType<AtprotoLibs['repo']>>,
    };
    // The chain maps the throw to `record_malformed`; the self-check surfaces
    // that code as the fault so boot can refuse to wire, instead of a device
    // reporting every genuine release as malformed.
    await expect(selfCheckRepoProofChain(faulty)).resolves.toEqual({ ok: false, fault: 'record_malformed' });
  });

  it('a signature library that lies fails the check (the fixture must actually verify)', async () => {
    const repo = await esmImport<Record<string, unknown>>('@atproto/repo');
    const lying: AtprotoLibs = {
      identity: realLibs.identity,
      repo: async () => ({ ...repo, verifyCommitSig: async () => false }) as unknown as Awaited<ReturnType<AtprotoLibs['repo']>>,
    };
    await expect(selfCheckRepoProofChain(lying)).resolves.toEqual({ ok: false, fault: 'signature_invalid' });
  });
});
