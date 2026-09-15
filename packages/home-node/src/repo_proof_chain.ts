/**
 * The repo-proof CHAIN (RESEARCHER_KERNEL_ARCHITECTURE.md §5.C1), platform
 * neutral. Install-time authenticity is a REPO PROOF, not a CID: the
 * publisher's DID document gives the signing key; a proof-carrying CAR from
 * their PDS gives the signed commit + the MST inclusion path to the release
 * record; the commit names its repo DID and its signature ties the record set
 * to the DID's key; `rkey = f(cid)` ties the record to its content
 * (immutability). Only then is the CID pinned.
 *
 * Both hosts run THIS chain. It holds no platform code: the fetch and the two
 * audited AT-Protocol libraries (`@atproto/repo`, `@atproto/identity`) are
 * handed in by the network adapter — `@dina/net-node` loads them with a dynamic
 * `import()` (CommonJS package, ESM-only libraries); `@dina/net-expo` imports
 * them statically for Metro. Core stays pure and invokes the injected
 * `RepoProofVerifier` callback (`setRepoProofVerifier`); the network, the CAR
 * and the crypto live behind this seam, on the audited stack, never in a
 * hand-rolled proof checker on a security boundary.
 *
 * DID resolution and the fetch are BOTH injectable so the chain is tested
 * fully offline (a fixture DID doc + a fixture CAR).
 */

import {
  checkReleaseIntegrity,
  repoProofFailure,
  type RepoProofRequest,
  type RepoProofResult,
  type RepoProofVerifier,
} from '@dina/protocol';

// ── Minimal DID-document + AT-Protocol surface (typed local wrappers) ────────

export interface DidVerificationMethod {
  id: string;
  type: string;
  controller?: string;
  publicKeyMultibase?: string;
}
export interface DidService {
  id: string;
  type: string;
  serviceEndpoint: string | Record<string, unknown>;
}
export interface DidDoc {
  id: string;
  verificationMethod?: DidVerificationMethod[];
  service?: DidService[];
}

export interface AtCid {
  toString(): string;
}
export interface AtReadableRepo {
  commit: { rev: string };
  /** The DID the signed commit names — must equal the DID being verified. */
  did: string;
  data: { get(key: string): Promise<AtCid | null> };
  getRecord(collection: string, rkey: string): Promise<unknown>;
}
export interface AtprotoRepoModule {
  readCarWithRoot(bytes: Uint8Array): Promise<{ root: AtCid; blocks: unknown }>;
  MemoryBlockstore: new (blocks: unknown) => unknown;
  // `Repo extends ReadableRepo` and is the top-level export; `Repo.load` reads a
  // repo from a blockstore and exposes commit / data / getRecord.
  Repo: { load(storage: unknown, commitCid: AtCid): Promise<AtReadableRepo> };
  verifyCommitSig(commit: AtReadableRepo['commit'], didKey: string): Promise<boolean>;
}
export interface AtprotoIdentityModule {
  getKey(doc: DidDoc): string | undefined;
  /** The `#atproto_pds` service of type AtprotoPersonalDataServer, or undefined. */
  getPds(doc: DidDoc): string | undefined;
  IdResolver: new (opts?: { plcUrl?: string }) => { did: { resolve(did: string): Promise<DidDoc | null> } };
}

// ── Public deps ──────────────────────────────────────────────────────────────

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  /**
   * A streaming body, when the platform fetch has one (Node 22 and the web
   * `Response` do). Read chunk by chunk under the byte ceiling so a hostile
   * PDS cannot make the verifier buffer an unbounded body; `arrayBuffer()` is
   * the fallback for a response without one.
   */
  readonly body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBufferLike>;
}
/**
 * The fetch options the verifier needs honoured: the endpoint comes from a
 * publisher-controlled DID document, so this is the first code to touch
 * attacker-chosen bytes on the install boundary. No redirects (a 302 would
 * defeat the https rule), and a deadline.
 */
export interface FetchInitLike {
  readonly signal: AbortSignal;
  readonly redirect: 'error';
}
export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;

/**
 * The two audited AT-Protocol libraries, handed in by the platform adapter:
 * the server loads them with a dynamic `import()` (its package is CommonJS and
 * they are ESM-only), the phone imports them statically for Metro. Thunks, so
 * a load is paid on the first verify and never at boot.
 */
export interface AtprotoLibs {
  identity: () => Promise<AtprotoIdentityModule>;
  repo: () => Promise<AtprotoRepoModule>;
}

export interface RepoProofChainDeps {
  libs: AtprotoLibs;
  /** The platform fetch (net adapter), used to pull the proof CAR. */
  fetch: FetchLike;
  /**
   * Resolve a DID to its document. Defaults to a real `@atproto/identity`
   * resolver; tests inject a fixture resolver so nothing hits the network.
   */
  resolveDid?: (did: string) => Promise<DidDoc | null>;
  /** PLC directory for the default resolver. */
  plcUrl?: string;
  /** Deadline for the proof-CAR fetch (default 15 s). */
  fetchTimeoutMs?: number;
  /** Largest proof CAR accepted (default 4 MiB — a release proof is tens of KB). */
  maxCarBytes?: number;
}

const DEFAULT_PLC_URL = 'https://plc.directory';
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CAR_BYTES = 4 * 1024 * 1024;

export function createRepoProofChain(deps: RepoProofChainDeps): RepoProofVerifier {
  const resolveDid =
    deps.resolveDid ??
    (async (did: string) => {
      const identity = await deps.libs.identity();
      const resolver = new identity.IdResolver({ plcUrl: deps.plcUrl ?? DEFAULT_PLC_URL });
      return resolver.did.resolve(did);
    });

  return async (req: RepoProofRequest): Promise<RepoProofResult> => {
    // 1) Resolve the publisher's DID → signing key + PDS. Resolution failure is
    //    TRANSIENT (retry), never a bypass.
    let doc: DidDoc | null;
    try {
      doc = await resolveDid(req.did);
    } catch (err) {
      return repoProofFailure('did_resolution_failed', `resolve ${req.did}: ${errMsg(err)}`);
    }
    if (doc === null) {
      return repoProofFailure('did_resolution_failed', `no DID document for ${req.did}`);
    }
    // The library's own readers, not a hand-rolled matcher: the PDS is the
    // `#atproto_pds` service of type AtprotoPersonalDataServer, as the rest of
    // the ecosystem resolves it. The https rule is ours on top.
    const { getKey, getPds } = await deps.libs.identity();
    const signingKey = getKey(doc);
    const pdsRaw = getPds(doc);
    const pds = pdsRaw !== undefined && /^https:\/\//i.test(pdsRaw) ? pdsRaw.replace(/\/+$/, '') : null;
    if (signingKey === undefined || pds === null) {
      return repoProofFailure(
        'did_resolution_failed',
        `DID document for ${req.did} lacks a signing key or an https PDS`,
      );
    }

    // 2) Fetch the proof-carrying CAR. A 404 is a removed release (DELETED); a
    //    transport error, a deadline, or a redirect is TRANSIENT; an oversized
    //    body is refused without being buffered further.
    let carBytes: Uint8Array;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    try {
      const url =
        `${pds}/xrpc/com.atproto.sync.getRecord` +
        `?did=${encodeURIComponent(req.did)}` +
        `&collection=${encodeURIComponent(req.collection)}` +
        `&rkey=${encodeURIComponent(req.rkey)}`;
      const resp = await deps.fetch(url, { signal: controller.signal, redirect: 'error' });
      if (resp.status === 404) {
        return repoProofFailure('deleted', `release ${req.rkey} not found in ${req.did}`);
      }
      if (!resp.ok) {
        return repoProofFailure('fetch_failed', `sync.getRecord ${req.rkey}: HTTP ${resp.status}`);
      }
      const maxBytes = deps.maxCarBytes ?? DEFAULT_MAX_CAR_BYTES;
      const read = await readBodyBounded(resp, maxBytes);
      if (read === null) {
        controller.abort();
        return repoProofFailure(
          'record_malformed',
          `proof CAR for ${req.rkey} exceeds the ${maxBytes}-byte ceiling`,
        );
      }
      carBytes = read;
    } catch (err) {
      return repoProofFailure('fetch_failed', `sync.getRecord ${req.rkey}: ${errMsg(err)}`);
    } finally {
      clearTimeout(deadline);
    }

    // 3) Decode the CAR + load the repo (validates the commit structure).
    const repoMod = await deps.libs.repo();
    let repo: AtReadableRepo;
    try {
      const { root, blocks } = await repoMod.readCarWithRoot(carBytes);
      repo = await repoMod.Repo.load(new repoMod.MemoryBlockstore(blocks), root);
    } catch (err) {
      return repoProofFailure('record_malformed', `proof CAR for ${req.rkey}: ${errMsg(err)}`);
    }

    // 4a) The commit must be THIS DID's. A DID document anyone controls can
    //     list another publisher's public key and point at a PDS that serves
    //     that publisher's genuine CAR; every later step would then pass for a
    //     release the requested DID never authored. The signed commit names
    //     its repo DID — bind it before the signature is even checked.
    if (repo.did !== req.did) {
      return repoProofFailure(
        'signature_invalid',
        `proof CAR commit belongs to ${repo.did}, not ${req.did}`,
      );
    }

    // 4b) The commit signature ties the record set to the DID's signing key.
    let sigOk: boolean;
    try {
      sigOk = await repoMod.verifyCommitSig(repo.commit, signingKey);
    } catch (err) {
      return repoProofFailure('signature_invalid', `commit signature: ${errMsg(err)}`);
    }
    if (!sigOk) {
      return repoProofFailure(
        'signature_invalid',
        `commit signature does not verify against ${req.did}'s signing key`,
      );
    }

    // 5) MST inclusion: the record must be reachable from the signed commit's
    //    data root. `data.get` walks the tree using only the CAR's blocks — a
    //    missing/forged path block throws (proof_invalid); an absent key is
    //    not_found.
    let cid: AtCid | null;
    try {
      cid = await repo.data.get(`${req.collection}/${req.rkey}`);
    } catch (err) {
      return repoProofFailure('proof_invalid', `MST inclusion for ${req.rkey}: ${errMsg(err)}`);
    }
    if (cid === null) {
      return repoProofFailure('not_found', `no record at ${req.collection}/${req.rkey}`);
    }
    const cidStr = cid.toString();

    // 6) `rkey = f(cid)` — immutability, enforced not assumed (an in-place
    //    overwrite fails here). Reuses the pure protocol check.
    const rkeyError = checkReleaseIntegrity({ rkey: req.rkey, cid: cidStr });
    if (rkeyError !== null) return rkeyError;

    // 7) The verified record.
    let record: unknown;
    try {
      record = await repo.getRecord(req.collection, req.rkey);
    } catch (err) {
      return repoProofFailure('record_malformed', `record at ${req.rkey}: ${errMsg(err)}`);
    }

    return { ok: true, cid: cidStr, rev: repo.commit.rev, record };
  };
}

/**
 * The response body, or null once it passes `maxBytes`. A streaming body is
 * read chunk by chunk and abandoned at the ceiling — nothing past it is
 * buffered; a body without a stream is read whole and then checked.
 */
async function readBodyBounded(resp: FetchResponseLike, maxBytes: number): Promise<Uint8Array | null> {
  const stream = resp.body;
  if (stream === undefined || stream === null) {
    const whole = await resp.arrayBuffer();
    return whole.byteLength > maxBytes ? null : new Uint8Array(whole);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
