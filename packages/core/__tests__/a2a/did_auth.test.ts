/**
 * DID credentials for Lane 2 clients (design §5.1, M4): the owner's
 * single-use challenge for one client and one DID, the binding (every
 * check, the swap in one commit, and races with whatever moves while a DID
 * resolves), which keys a DID document offers (the real did:plc shape
 * included), the host's re-check of bound keys, per-request DID signatures
 * (time, nonce, body, path and operation all bound), and the durable replay
 * guard.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { A2A_DID_BINDING_PATH, didBindingSigningInput } from '@dina/a2a';

import {
  A2A_RPC_PATH,
  DID_CHALLENGE_TTL_MS,
  PrincipalBudgets,
  a2aNonceGuard,
  createA2AClient,
  didAuthenticationKeys,
  getA2AClient,
  ingressCompleteDidBinding,
  ingressGetTask,
  ingressSendMessage,
  parseInboundReviewCard,
  installA2ADidResolver,
  issueDidChallenge,
  purgeExpiredA2ANonces,
  refreshBoundDidKeys,
  revokeA2AClient,
  rotateA2AClientToken,
  type A2ADidResolution,
  type GatewayEnvelope,
} from '../../src/a2a';
import { signRequest } from '../../src/auth/canonical';
import { getPublicKey, sign } from '../../src/crypto/ed25519';
import { DIDResolver } from '../../src/d2d/resolver';
import { deriveDIDKey, publicKeyToMultibase } from '../../src/identity/did';
import { clearPairingState } from '../../src/pairing/ceremony';

import { INBOUND_NODE_DID, InboundWorld, bookingListing, didRequestSignature, errorOf, resultOf, save, sentTask } from './inbound_fixture';

const NODE_DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
/** A secp256k1 Multikey, as PLC lists a DID's `#atproto` key: it cannot sign a Dina request. */
const SECP256K1_MULTIKEY = 'zQ3shXjHeiBuRCKmM36cuYnm7YEMzhGnCmCyW92sRJ9pribSF';

const keyOf = (n: number) => {
  const privateKey = new Uint8Array(32).fill(n);
  const publicKey = getPublicKey(privateKey);
  return { privateKey, publicKey, did: deriveDIDKey(publicKey) };
};
type Signer = ReturnType<typeof keyOf>;
const ALICE = keyOf(11);
const MALLORY = keyOf(12);
const ALICE_NEXT = keyOf(13);

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
});
afterEach(() => {
  installA2ADidResolver(null);
  iw.close();
});

function newClient(over: { expected_did?: string } = {}) {
  const out = createA2AClient(iw.world.store, { display_name: 'Other', ...over }, iw.world.clock);
  if (!out.ok) throw new Error(out.reason);
  return { clientId: out.client.client_id, token: out.token };
}

function challenge(did: string, clientId = iw.clientId): string {
  const out = issueDidChallenge(iw.world.store, clientId, did, iw.world.clock);
  if (!out.ok) throw new Error(out.reason);
  return out.challenge;
}

function bindingBody(args: {
  did: string;
  challenge: string;
  signer: Uint8Array;
  clientId?: string;
  nodeDid?: string;
}): string {
  const input = didBindingSigningInput({
    nodeDid: args.nodeDid ?? NODE_DID,
    clientId: args.clientId ?? iw.clientId,
    did: args.did,
    challenge: args.challenge,
  });
  const signature = bytesToHex(sign(args.signer, new TextEncoder().encode(input)));
  return JSON.stringify({ did: args.did, challenge: args.challenge, signature });
}

/** The binding request as the gateway forwards it: no credential but the challenge. */
const bind = (body: string) =>
  ingressCompleteDidBinding(
    iw.rt,
    { request: { method: 'POST', path: A2A_DID_BINDING_PATH, query: '', body }, client_auth: {} },
    NODE_DID,
  );

/** Bind the world's client to `did`, signed by `signer`, through a fresh owner challenge. */
async function bindAs(did: string, signer: Signer, clientId = iw.clientId): Promise<void> {
  const answer = await bind(
    bindingBody({ did, challenge: challenge(did, clientId), signer: signer.privateKey, clientId }),
  );
  expect(answer).toEqual({
    status: 200,
    body: { client_id: clientId, principal: `a2a:${clientId}`, did },
  });
}

function didSignature(method: string, path: string, body: string, signer: Signer, did = signer.did) {
  return didRequestSignature({ method, path, body, signer, did });
}

function signatureOf(e: GatewayEnvelope) {
  const sig = e.client_auth.did_signature;
  if (sig === undefined) throw new Error('not DID-signed');
  return sig;
}

/** A JSON-RPC call signed with a bound DID, as the gateway forwards it. */
let rpcId = 1000;
function signedCall(
  method: string,
  params: Record<string, unknown>,
  signer: Signer,
  did = signer.did,
): GatewayEnvelope {
  rpcId += 1;
  const body = JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params });
  return {
    request: { method: 'POST', path: A2A_RPC_PATH, query: '', body, version: '1.0' },
    client_auth: { did_signature: didSignature('POST', A2A_RPC_PATH, body, signer, did) },
  };
}

const getTaskAs = (signer: Signer, did = signer.did) =>
  ingressGetTask(iw.rt, signedCall('GetTask', { id: 'none' }, signer, did), 'none').status;

const history = (clientId = iw.clientId) =>
  (
    iw.world.store.db.query(
      'SELECT binding_type, revoked_at FROM a2a_credential_bindings WHERE client_id = ? ORDER BY id',
      [clientId],
    ) as { binding_type: string; revoked_at: number | null }[]
  ).map((h) => [h.binding_type, h.revoked_at === null ? 'live' : 'ended']);

describe('the owner challenge', () => {
  it('names one client and one DID; a fresh one replaces an unused one', () => {
    const first = challenge(ALICE.did);
    const second = challenge(ALICE.did);
    const rows = iw.world.store.db.query(
      'SELECT challenge_hash, did FROM a2a_did_challenges WHERE client_id = ?',
      [iw.clientId],
    );
    // Kept as its sha256 (design §9), never in clear.
    expect(rows).toEqual([{ challenge_hash: bytesToHex(sha256(new TextEncoder().encode(second))), did: ALICE.did }]);
    expect(JSON.stringify(iw.world.store.db.query('SELECT * FROM a2a_did_challenges'))).not.toContain(second);
    expect(first).not.toBe(second);
  });

  it.each([
    ['no DID', undefined, 'did_malformed'],
    ['a DID that is not one', 'alice', 'did_malformed'],
  ])('refuses %s', (_name, did, reason) => {
    expect(issueDidChallenge(iw.world.store, iw.clientId, did, iw.world.clock)).toEqual({
      ok: false,
      reason,
    });
  });

  it('holds to the DID the owner expected when the client was made', () => {
    const pinned = newClient({ expected_did: MALLORY.did });
    expect(issueDidChallenge(iw.world.store, pinned.clientId, ALICE.did, iw.world.clock)).toEqual({
      ok: false,
      reason: 'did_not_expected',
    });
    expect(issueDidChallenge(iw.world.store, pinned.clientId, MALLORY.did, iw.world.clock).ok).toBe(true);
  });
});

describe('binding', () => {
  it('trades the bearer for the DID in one commit; the principal and its tasks carry over', async () => {
    const before = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    await bindAs(ALICE.did, ALICE);
    expect(getA2AClient(iw.world.store, iw.clientId)).toEqual(
      expect.objectContaining({
        bound_did: ALICE.did,
        credential: 'did',
        token_expires_at: null,
        principal: `a2a:${iw.clientId}`,
      }),
    );
    // The bearer is gone.
    expect(iw.call({ skill: 'eta_query', params: { route_id: '42' } }).status).toBe(401);
    // The DID signs; the same principal sees its earlier task.
    const got = ingressGetTask(iw.rt, signedCall('GetTask', { id: before }, ALICE), before);
    expect(resultOf(got).id as string).toBe(before);
    expect(history()).toEqual([
      ['bearer', 'ended'],
      ['did', 'live'],
    ]);
  });

  it('a challenge is single use, belongs to one client, and expires', async () => {
    const c = challenge(ALICE.did);
    expect((await bind(bindingBody({ did: ALICE.did, challenge: c, signer: ALICE.privateKey }))).status).toBe(200);
    expect(await bind(bindingBody({ did: ALICE.did, challenge: c, signer: ALICE.privateKey }))).toEqual({
      status: 400,
      body: { error: 'challenge_invalid' },
    });
    // Another client's challenge, signed as if for this one: the challenge
    // decides the client, so the signature fits nothing.
    const other = newClient();
    const theirs = challenge(MALLORY.did, other.clientId);
    expect(
      (await bind(bindingBody({ did: MALLORY.did, challenge: theirs, signer: MALLORY.privateKey }))).body,
    ).toEqual({ error: 'signature_invalid' });
    const late = challenge(MALLORY.did, other.clientId);
    iw.world.clock += DID_CHALLENGE_TTL_MS;
    expect(
      (
        await bind(
          bindingBody({ did: MALLORY.did, challenge: late, signer: MALLORY.privateKey, clientId: other.clientId }),
        )
      ).body,
    ).toEqual({ error: 'challenge_invalid' });
    expect(getA2AClient(iw.world.store, other.clientId)?.bound_did).toBeNull();
  });

  it('a challenge binds only the DID it names: the bearer and the challenge without that key bind nothing', async () => {
    // What a thief holding the bearer and the owner's message has.
    const c = challenge(ALICE.did);
    expect((await bind(bindingBody({ did: ALICE.did, challenge: c, signer: MALLORY.privateKey }))).body).toEqual({
      error: 'signature_invalid',
    });
    expect((await bind(bindingBody({ did: MALLORY.did, challenge: c, signer: MALLORY.privateKey }))).body).toEqual({
      error: 'challenge_invalid',
    });
    expect(getA2AClient(iw.world.store, iw.clientId)).toEqual(
      expect.objectContaining({ bound_did: null, credential: 'bearer' }),
    );
    // The failed tries spent nothing: the rightful holder still binds.
    expect((await bind(bindingBody({ did: ALICE.did, challenge: c, signer: ALICE.privateKey }))).status).toBe(200);
  });

  it.each([
    ['a body that is not the three members', () => JSON.stringify({ did: ALICE.did }), 'request_malformed', 400],
    [
      'an unknown challenge',
      () => bindingBody({ did: ALICE.did, challenge: `dch_${'A'.repeat(43)}`, signer: ALICE.privateKey }),
      'challenge_invalid',
      400,
    ],
    [
      'a signature by another key',
      () => bindingBody({ did: ALICE.did, challenge: challenge(ALICE.did), signer: MALLORY.privateKey }),
      'signature_invalid',
      403,
    ],
    [
      'a signature for another node',
      () =>
        bindingBody({
          did: ALICE.did,
          challenge: challenge(ALICE.did),
          signer: ALICE.privateKey,
          nodeDid: 'did:plc:other',
        }),
      'signature_invalid',
      403,
    ],
  ])('refuses %s', async (_name, body, error, status) => {
    expect(await bind(body())).toEqual({ status, body: { error } });
    expect(getA2AClient(iw.world.store, iw.clientId)?.bound_did).toBeNull();
  });

  it('refuses a request on any other door than the binding path, and answers 503 with no node DID', async () => {
    const body = bindingBody({ did: ALICE.did, challenge: challenge(ALICE.did), signer: ALICE.privateKey });
    const at = (over: Partial<GatewayEnvelope['request']>, nodeDid: string | null = NODE_DID) =>
      ingressCompleteDidBinding(
        iw.rt,
        { request: { method: 'POST', path: A2A_DID_BINDING_PATH, query: '', body, ...over }, client_auth: {} },
        nodeDid,
      );
    expect((await at({ path: A2A_RPC_PATH })).status).toBe(400);
    expect((await at({ query: 'x=1' })).status).toBe(400);
    expect((await at({ method: 'GET' })).status).toBe(400);
    expect((await at({}, null)).status).toBe(503);
    expect((await at({})).status).toBe(200);
  });

  it("charges each try with a live challenge to the challenge's client", async () => {
    const tight = {
      ...iw.rt,
      budgets: new PrincipalBudgets({ perMinute: 2, replayPerMinute: 10, readPerMinute: 10 }),
    };
    const wrong = bindingBody({ did: ALICE.did, challenge: challenge(ALICE.did), signer: MALLORY.privateKey });
    const envelope: GatewayEnvelope = {
      request: { method: 'POST', path: A2A_DID_BINDING_PATH, query: '', body: wrong },
      client_auth: {},
    };
    expect((await ingressCompleteDidBinding(tight, envelope, NODE_DID)).status).toBe(403);
    expect((await ingressCompleteDidBinding(tight, envelope, NODE_DID)).status).toBe(403);
    expect((await ingressCompleteDidBinding(tight, envelope, NODE_DID)).status).toBe(429);
  });

  it('one DID binds one active client; once that client is revoked, another may take it', async () => {
    await bindAs(ALICE.did, ALICE);
    const other = newClient();
    const body = bindingBody({
      did: ALICE.did,
      challenge: challenge(ALICE.did, other.clientId),
      signer: ALICE.privateKey,
      clientId: other.clientId,
    });
    expect(await bind(body)).toEqual({ status: 409, body: { error: 'did_in_use' } });
    revokeA2AClient(iw.world.store, iw.grants, iw.clientId, iw.world.clock);
    expect(getTaskAs(ALICE)).toBe(401);
    await bindAs(ALICE.did, ALICE, other.clientId);
    expect(getTaskAs(ALICE)).toBe(200);
  });

  it('binding again moves a bound client to a new DID; the old one stops at once', async () => {
    await bindAs(ALICE.did, ALICE);
    await bindAs(MALLORY.did, MALLORY);
    expect(getTaskAs(ALICE)).toBe(401);
    expect(getTaskAs(MALLORY)).toBe(200);
    expect(history()).toEqual([
      ['bearer', 'ended'],
      ['did', 'ended'],
      ['did', 'live'],
    ]);
  });

  it('a bound client has no bearer to rotate; a revoked client gets no challenge and its old one binds nothing', async () => {
    await bindAs(ALICE.did, ALICE);
    expect(rotateA2AClientToken(iw.world.store, iw.clientId, iw.world.clock)).toEqual({
      ok: false,
      reason: 'did_bound',
    });
    const other = newClient();
    const c = challenge(MALLORY.did, other.clientId);
    revokeA2AClient(iw.world.store, iw.grants, other.clientId, iw.world.clock);
    const body = bindingBody({ did: MALLORY.did, challenge: c, signer: MALLORY.privateKey, clientId: other.clientId });
    expect((await bind(body)).body).toEqual({ error: 'challenge_invalid' });
    expect(issueDidChallenge(iw.world.store, other.clientId, MALLORY.did, iw.world.clock)).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });
});

/** A did:plc document as plc.directory renders one for a Dina node: no `authentication` member. */
const PLC = 'did:plc:alice0000000000000000000';
function plcDocument(ed25519Keys: Uint8Array[], over: Record<string, unknown> = {}) {
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: PLC,
    alsoKnownAs: ['at://alice.example'],
    verificationMethod: [
      { id: `${PLC}#atproto`, type: 'Multikey', controller: PLC, publicKeyMultibase: SECP256K1_MULTIKEY },
      ...ed25519Keys.map((key, i) => ({
        id: `${PLC}#dina_signing${i === 0 ? '' : `_${i}`}`,
        type: 'Multikey',
        controller: PLC,
        publicKeyMultibase: publicKeyToMultibase(key),
      })),
    ],
    service: [{ id: '#dina-messaging', type: 'DinaMsgBox', serviceEndpoint: 'wss://msgbox.example' }],
    ...over,
  };
}

/** What the host's lookup answers when it finds `document`. */
const found = (document: unknown): A2ADidResolution => ({ kind: 'document', document });

/** A resolver that holds every resolution until released, to interleave what moves meanwhile. */
function heldResolver(document: () => unknown) {
  const held: (() => void)[] = [];
  installA2ADidResolver(
    () =>
      new Promise((resolve) => {
        held.push(() => resolve(found(document())));
      }),
  );
  return {
    count: () => held.length,
    release: () => {
      for (const go of held.splice(0)) go();
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('a DID the host resolves (did:plc)', () => {
  it('binds with the Ed25519 key of the document plc.directory serves, beside its secp256k1 key', async () => {
    installA2ADidResolver(async (did) =>
      did === PLC ? found(plcDocument([ALICE.publicKey])) : { kind: 'not_found' },
    );
    await bindAs(PLC, ALICE);
    expect(getTaskAs(ALICE, PLC)).toBe(200);
  });

  it.each([
    ['a document with only a secp256k1 key', plcDocument([])],
    [
      'an authentication member naming only the secp256k1 key',
      plcDocument([ALICE.publicKey], { authentication: [`${PLC}#atproto`] }),
    ],
    ['an empty authentication member', plcDocument([ALICE.publicKey], { authentication: [] })],
    ['a document for another DID', plcDocument([ALICE.publicKey], { id: 'did:plc:someoneelse00000000000000' })],
  ])('refuses %s', async (_name, document) => {
    installA2ADidResolver(async () => found(document));
    const body = bindingBody({ did: PLC, challenge: challenge(PLC), signer: ALICE.privateKey });
    expect((await bind(body)).body).toEqual({ error: 'signature_invalid' });
  });

  it.each([
    ['no resolver is installed', null],
    ['the directory has no such DID', async (): Promise<A2ADidResolution> => ({ kind: 'not_found' })],
    ['the DID is deactivated', async (): Promise<A2ADidResolution> => ({ kind: 'deactivated' })],
    ['the directory is down', async (): Promise<A2ADidResolution> => ({ kind: 'unavailable' })],
    ['the resolver throws', async () => Promise.reject(new Error('down'))],
  ])('answers did_unresolvable when %s', async (_name, resolver) => {
    installA2ADidResolver(resolver);
    const body = bindingBody({ did: PLC, challenge: challenge(PLC), signer: ALICE.privateKey });
    expect((await bind(body)).body).toEqual({ error: 'did_unresolvable' });
    expect(getA2AClient(iw.world.store, iw.clientId)?.bound_did).toBeNull();
  });

  it('counts the keys a document names under authentication, embedded or by reference, of the two Ed25519 types', () => {
    const doc = {
      id: PLC,
      verificationMethod: [
        {
          id: '#ref',
          type: 'Ed25519VerificationKey2020',
          publicKeyMultibase: publicKeyToMultibase(ALICE.publicKey),
        },
        { id: '#unnamed', type: 'Multikey', publicKeyMultibase: publicKeyToMultibase(ALICE_NEXT.publicKey) },
        { id: '#jwk', type: 'JsonWebKey2020', publicKeyMultibase: publicKeyToMultibase(ALICE_NEXT.publicKey) },
      ],
      authentication: [
        '#ref',
        '#jwk',
        { id: '#embedded', type: 'Multikey', publicKeyMultibase: publicKeyToMultibase(MALLORY.publicKey) },
      ],
    };
    expect(didAuthenticationKeys(doc, PLC)).toEqual([ALICE.publicKey, MALLORY.publicKey]);
  });
});

describe("through D2D's resolver, looking the DID up as it stands", () => {
  /** A DIDResolver whose directory answers each lookup from `answers`, in turn. */
  function directory(answers: { status: number; body?: unknown }[]) {
    const seen: string[] = [];
    const resolver = new DIDResolver({
      plcDirectory: 'https://plc.example',
      fetch: (async (url: string | URL | Request) => {
        seen.push(String(url));
        const next = answers.length > 1 ? answers.shift() : answers[0];
        if (next === undefined) throw new Error('no answer scripted');
        return new Response(JSON.stringify(next.body ?? {}), {
          status: next.status,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    installA2ADidResolver((did) => resolver.lookup(did));
    return seen;
  }

  it('binds against the live document, then suspends once its owner removes every key', async () => {
    const seen = directory([
      { status: 200, body: plcDocument([ALICE.publicKey]) },
      // Every key gone: a document D2D's messaging checks would reject.
      { status: 200, body: plcDocument([], { verificationMethod: [] }) },
    ]);
    await bindAs(PLC, ALICE);
    expect(await refreshBoundDidKeys(iw.world.store, () => iw.world.clock)).toEqual({
      checked: 1,
      suspended: 1,
      unresolved: 0,
    });
    expect(getTaskAs(ALICE, PLC)).toBe(401);
    // Uncached: each step asked the directory.
    expect(seen).toEqual([`https://plc.example/${PLC}`, `https://plc.example/${PLC}`]);
  });

  it.each([
    ['a tombstone (410) suspends', 410, { checked: 1, suspended: 1, unresolved: 0 }, 401],
    ['a 404 for a DID that bound is the directory\'s fault: left alone', 404, { checked: 1, suspended: 0, unresolved: 1 }, 200],
    ['a 500 is an outage: left alone', 500, { checked: 1, suspended: 0, unresolved: 1 }, 200],
  ])('%s', async (_name, status, counts, after) => {
    directory([{ status: 200, body: plcDocument([ALICE.publicKey]) }, { status }]);
    await bindAs(PLC, ALICE);
    expect(await refreshBoundDidKeys(iw.world.store, () => iw.world.clock)).toEqual(counts);
    expect(getTaskAs(ALICE, PLC)).toBe(after);
  });

  it('reads an answer that is not a document for this DID as unavailable', async () => {
    directory([{ status: 200, body: plcDocument([ALICE.publicKey], { id: 'did:plc:someoneelse00000000000000' }) }]);
    const body = bindingBody({ did: PLC, challenge: challenge(PLC), signer: ALICE.privateKey });
    expect((await bind(body)).body).toEqual({ error: 'did_unresolvable' });
  });
});

describe('what moves while a DID resolves', () => {
  it('two completions of one challenge: exactly one binds', async () => {
    const held = heldResolver(() => plcDocument([ALICE.publicKey]));
    const body = bindingBody({ did: PLC, challenge: challenge(PLC), signer: ALICE.privateKey });
    const both = Promise.all([bind(body), bind(body)]);
    await settle();
    expect(held.count()).toBe(2);
    held.release();
    expect((await both).map((a) => a.status).sort()).toEqual([200, 400]);
    expect(history()).toEqual([
      ['bearer', 'ended'],
      ['did', 'live'],
    ]);
  });

  it('a challenge the owner reissued meanwhile', async () => {
    const held = heldResolver(() => plcDocument([ALICE.publicKey]));
    const pending = bind(bindingBody({ did: PLC, challenge: challenge(PLC), signer: ALICE.privateKey }));
    await settle();
    challenge(PLC);
    held.release();
    expect((await pending).body).toEqual({ error: 'challenge_invalid' });
  });

  it('a client the owner revoked meanwhile', async () => {
    const held = heldResolver(() => plcDocument([ALICE.publicKey]));
    const pending = bind(bindingBody({ did: PLC, challenge: challenge(PLC), signer: ALICE.privateKey }));
    await settle();
    revokeA2AClient(iw.world.store, iw.grants, iw.clientId, iw.world.clock);
    held.release();
    expect((await pending).body).toEqual({ error: 'challenge_invalid' });
    expect(getA2AClient(iw.world.store, iw.clientId)?.bound_did).toBeNull();
  });

  it('another client that took the DID meanwhile', async () => {
    const other = newClient();
    const held = heldResolver(() => plcDocument([ALICE.publicKey]));
    const mine = bind(bindingBody({ did: PLC, challenge: challenge(PLC), signer: ALICE.privateKey }));
    const theirs = bind(
      bindingBody({
        did: PLC,
        challenge: challenge(PLC, other.clientId),
        signer: ALICE.privateKey,
        clientId: other.clientId,
      }),
    );
    await settle();
    held.release();
    expect([(await mine).status, (await theirs).body]).toEqual([200, { error: 'did_in_use' }]);
  });

  it('a challenge that expired meanwhile', async () => {
    const held = heldResolver(() => plcDocument([ALICE.publicKey]));
    const pending = bind(bindingBody({ did: PLC, challenge: challenge(PLC), signer: ALICE.privateKey }));
    await settle();
    iw.world.clock += DID_CHALLENGE_TTL_MS;
    held.release();
    expect((await pending).body).toEqual({ error: 'challenge_invalid' });
  });
});

describe("the host's re-check of bound keys", () => {
  let document: unknown;
  beforeEach(async () => {
    document = plcDocument([ALICE.publicKey]);
    installA2ADidResolver(async () => found(document));
    await bindAs(PLC, ALICE);
  });
  const refresh = () => refreshBoundDidKeys(iw.world.store, () => iw.world.clock);

  it('leaves a client whose key is still in its document', async () => {
    expect(await refresh()).toEqual({ checked: 1, suspended: 0, unresolved: 0 });
    expect(getTaskAs(ALICE, PLC)).toBe(200);
  });

  it('stops a key its owner removed; the owner binds the client again to the new key', async () => {
    document = plcDocument([ALICE_NEXT.publicKey]);
    expect(await refresh()).toEqual({ checked: 1, suspended: 1, unresolved: 0 });
    expect(getTaskAs(ALICE, PLC)).toBe(401);
    expect(getTaskAs(ALICE_NEXT, PLC)).toBe(401);
    expect(getA2AClient(iw.world.store, iw.clientId)).toEqual(
      expect.objectContaining({ bound_did: PLC, credential: 'did_key_removed' }),
    );
    expect(history()).toEqual([
      ['bearer', 'ended'],
      ['did', 'ended'],
    ]);
    await bindAs(PLC, ALICE_NEXT);
    expect(getTaskAs(ALICE_NEXT, PLC)).toBe(200);
    expect(getA2AClient(iw.world.store, iw.clientId)?.credential).toBe('did');
  });

  it.each([
    ['the directory is down', async (): Promise<A2ADidResolution> => ({ kind: 'unavailable' })],
    ['the lookup throws', async () => Promise.reject(new Error('down'))],
  ])('leaves clients alone when %s: an outage cuts no one off', async (_name, resolver) => {
    installA2ADidResolver(resolver);
    expect(await refresh()).toEqual({ checked: 1, suspended: 0, unresolved: 1 });
    expect(getTaskAs(ALICE, PLC)).toBe(200);
    expect(getA2AClient(iw.world.store, iw.clientId)?.credential).toBe('did');
  });

  it('stops a client whose DID its owner deactivated', async () => {
    installA2ADidResolver(async () => ({ kind: 'deactivated' }));
    expect(await refresh()).toEqual({ checked: 1, suspended: 1, unresolved: 0 });
    expect(getTaskAs(ALICE, PLC)).toBe(401);
    expect(getA2AClient(iw.world.store, iw.clientId)?.credential).toBe('did_key_removed');
  });

  it('leaves a client whose bound DID the directory says it never knew: that is the directory at fault', async () => {
    installA2ADidResolver(async () => ({ kind: 'not_found' }));
    expect(await refresh()).toEqual({ checked: 1, suspended: 0, unresolved: 1 });
    expect(getTaskAs(ALICE, PLC)).toBe(200);
  });

  it('skips did:key clients, whose key cannot change', async () => {
    const other = newClient();
    await bindAs(MALLORY.did, MALLORY, other.clientId);
    expect((await refresh()).checked).toBe(1);
  });

  it('keeps a key bound while the re-check was resolving', async () => {
    // The re-check's lookup is held; the binding's goes straight through.
    let release = (): void => undefined;
    let calls = 0;
    installA2ADidResolver(() => {
      calls += 1;
      const doc = found(plcDocument([ALICE_NEXT.publicKey]));
      return calls === 1 ? new Promise((resolve) => (release = () => resolve(doc))) : Promise.resolve(doc);
    });
    const pending = refresh();
    await settle();
    // The client binds its new key while the re-check waits on the old document.
    await bindAs(PLC, ALICE_NEXT);
    release();
    expect(await pending).toEqual({ checked: 1, suspended: 0, unresolved: 0 });
    expect(getTaskAs(ALICE_NEXT, PLC)).toBe(200);
    expect(getA2AClient(iw.world.store, iw.clientId)?.credential).toBe('did');
  });

  it('a re-check that lands first still leaves the binding that follows it in place', async () => {
    const held = heldResolver(() => plcDocument([ALICE_NEXT.publicKey]));
    const pending = refresh();
    await settle();
    const binding = bind(bindingBody({ did: PLC, challenge: challenge(PLC), signer: ALICE_NEXT.privateKey }));
    await settle();
    held.release();
    expect((await pending).suspended).toBe(1);
    expect((await binding).status).toBe(200);
    expect(getTaskAs(ALICE_NEXT, PLC)).toBe(200);
    expect(history()).toEqual([
      ['bearer', 'ended'],
      ['did', 'ended'],
      ['did', 'live'],
    ]);
  });
});

describe('a DID-signed request', () => {
  beforeEach(async () => {
    await bindAs(ALICE.did, ALICE);
  });
  const eta = () => iw.message({ skill: 'eta_query', params: { route_id: '42' } });

  it('runs a call', () => {
    expect(sentTask(ingressSendMessage(iw.rt, signedCall('SendMessage', eta(), ALICE))).status).toEqual(
      expect.objectContaining({ state: 'TASK_STATE_SUBMITTED' }),
    );
  });

  it.each([
    [
      'a replayed nonce',
      (e: GatewayEnvelope) => {
        expect(ingressSendMessage(iw.rt, e).status).toBe(200);
        return e;
      },
    ],
    [
      'a body changed after signing',
      (e: GatewayEnvelope) => ({ ...e, request: { ...e.request, body: e.request.body.replace('42', '43') } }),
    ],
    [
      'another path than the one signed',
      (e: GatewayEnvelope) => ({ ...e, request: { ...e.request, path: '/a2a/v2' } }),
    ],
    [
      'a query the signer never sent',
      (e: GatewayEnvelope) => ({ ...e, request: { ...e.request, query: 'x=1' } }),
    ],
    [
      'a signature by another key',
      (e: GatewayEnvelope) => ({
        ...e,
        client_auth: {
          did_signature: {
            ...signatureOf(e),
            signature: didSignature('POST', A2A_RPC_PATH, e.request.body, MALLORY).signature,
          },
        },
      }),
    ],
    [
      'a bearer as well',
      (e: GatewayEnvelope) => ({
        ...e,
        client_auth: { ...e.client_auth, authorization: `Bearer ${iw.token}` },
      }),
    ],
  ])('refuses %s (401)', (_name, tamper) => {
    const envelope = tamper(signedCall('SendMessage', eta(), ALICE));
    expect(ingressSendMessage(iw.rt, envelope).status).toBe(401);
  });

  // Cold audit C4-5: the review card says how the caller proved who it is
  it('a DID-bound client’s review card names the DID whose key signed the call, and no token', async () => {
    await save(bookingListing(), 'bus');
    await bindAs(ALICE.did, ALICE);
    const params = iw.message({ skill: 'appointment_book', params: { slot: '9am' } }, { messageId: 'did-review-1' });
    const task = sentTask(ingressSendMessage(iw.rt, signedCall('SendMessage', params, ALICE)));
    const card = parseInboundReviewCard(iw.childOf(task.id as string).payload);
    expect(card?.display.detail).toContain(`The agent proved only that it holds the key of ${ALICE.did}, the DID it bound.`);
    expect(card?.display.detail).not.toMatch(/token/);
  });

  // Cold audit C3-2: one DID may be a client of many nodes, and every gateway serves the same paths
  it('refuses a request signed for another node, the same client, body, time and nonce otherwise', () => {
    rpcId += 1;
    const body = JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'SendMessage', params: eta() });
    const at = (nodeDid: string, nonce: string): GatewayEnvelope => ({
      request: { method: 'POST', path: A2A_RPC_PATH, query: '', body, version: '1.0' },
      client_auth: { did_signature: didRequestSignature({ body, signer: ALICE, nodeDid, nonce }) },
    });
    // Signed for node X, as node X's operator, gateway or TLS terminator could pass it on.
    expect(ingressSendMessage(iw.rt, at('did:plc:anotherdinanode', 'x'.repeat(32))).status).toBe(401);
    // The same request signed for this node goes through: the audience was the only fault.
    expect(ingressSendMessage(iw.rt, at(INBOUND_NODE_DID, 'y'.repeat(32))).status).toBe(200);
  });

  it('refuses Dina’s plain request signature, which names no audience', () => {
    rpcId += 1;
    const body = JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'SendMessage', params: eta() });
    const h = signRequest('POST', A2A_RPC_PATH, '', new TextEncoder().encode(body), ALICE.privateKey, ALICE.did);
    const envelope: GatewayEnvelope = {
      request: { method: 'POST', path: A2A_RPC_PATH, query: '', body, version: '1.0' },
      client_auth: { did_signature: { did: h['X-DID'], timestamp: h['X-Timestamp'], nonce: h['X-Nonce'], signature: h['X-Signature'] } },
    };
    expect(ingressSendMessage(iw.rt, envelope).status).toBe(401);
  });

  it('refuses every DID-signed request while the node has no DID to be the audience', () => {
    clearPairingState();
    expect(ingressSendMessage(iw.rt, signedCall('SendMessage', eta(), ALICE)).status).toBe(401);
  });

  it('refuses a replay after a restart: the spent nonce is on disk, not in the process', () => {
    const envelope = signedCall('SendMessage', eta(), ALICE);
    expect(ingressSendMessage(iw.rt, envelope).status).toBe(200);
    const restarted = { ...iw.rt, budgets: new PrincipalBudgets() };
    expect(ingressSendMessage(restarted, envelope).status).toBe(401);
  });

  it('refuses a request signed — validly — at a time outside the window, either side', () => {
    rpcId += 1;
    const body = JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'SendMessage', params: eta() });
    const signedAt = (at: Date, nonce: string): GatewayEnvelope => ({
      request: { method: 'POST', path: A2A_RPC_PATH, query: '', body, version: '1.0' },
      client_auth: {
        did_signature: didRequestSignature({ body, signer: ALICE, timestamp: at.toISOString().replace(/\.\d{3}Z$/, 'Z'), nonce }),
      },
    });
    expect(ingressSendMessage(iw.rt, signedAt(new Date(Date.now() - 10 * 60_000), 'a'.repeat(32))).status).toBe(
      401,
    );
    expect(ingressSendMessage(iw.rt, signedAt(new Date(Date.now() + 10 * 60_000), 'b'.repeat(32))).status).toBe(
      401,
    );
    // The same request at the right time goes through: the window was the only fault.
    expect(ingressSendMessage(iw.rt, signedAt(new Date(), 'c'.repeat(32))).status).toBe(200);
  });

  it('binds the operation to the signed body: a signed GetTask sent to another door is refused', () => {
    const envelope = signedCall('GetTask', { id: 'x' }, ALICE);
    expect(errorOf(ingressSendMessage(iw.rt, envelope))).toEqual(
      expect.objectContaining({ reason: 'operation_mismatch' }),
    );
  });
});

describe('the replay guard', () => {
  const T = Date.parse('2027-03-01T12:00:00Z');
  const at = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = 'n'.repeat(32);

  it('keeps a nonce until its own time plus the window, for a signer whose clock runs ahead', () => {
    let now = T;
    const guard = a2aNonceGuard(iw.world.store, () => now);
    const signedAt = T + 4 * 60_000;
    expect(guard.check(nonce, at(signedAt), ALICE.did)).toBe(true);
    // Past now + 5 min, before its own time + 5 min: still spent.
    now = T + 6 * 60_000;
    expect(purgeExpiredA2ANonces(iw.world.store, now)).toBe(0);
    expect(guard.check(nonce, at(signedAt), ALICE.did)).toBe(false);
    // Once the signature could no longer pass, the row may go.
    expect(purgeExpiredA2ANonces(iw.world.store, signedAt + 5 * 60_000)).toBe(1);
  });

  it('keeps a nonce dated in the past for the window from now', () => {
    const guard = a2aNonceGuard(iw.world.store, () => T);
    expect(guard.check(nonce, at(T - 4 * 60_000), ALICE.did)).toBe(true);
    expect(purgeExpiredA2ANonces(iw.world.store, T + 5 * 60_000 - 1)).toBe(0);
    expect(purgeExpiredA2ANonces(iw.world.store, T + 5 * 60_000)).toBe(1);
  });

  it('scopes nonces to their DID', () => {
    const guard = a2aNonceGuard(iw.world.store, () => T);
    expect(guard.check(nonce, at(T), ALICE.did)).toBe(true);
    expect(guard.check(nonce, at(T), MALLORY.did)).toBe(true);
    expect(guard.check(nonce, at(T), ALICE.did)).toBe(false);
  });

  it.each([
    ['too short', 'n'.repeat(15)],
    ['too long', 'n'.repeat(129)],
    ['outside the alphabet', `${'n'.repeat(31)}/`],
  ])('refuses a nonce %s, storing nothing', (_name, bad) => {
    const guard = a2aNonceGuard(iw.world.store, () => T);
    expect(guard.check(bad, at(T), ALICE.did)).toBe(false);
    expect(iw.world.store.db.query('SELECT nonce FROM a2a_request_nonces')).toEqual([]);
  });

  it('refuses a timestamp it cannot read', () => {
    expect(a2aNonceGuard(iw.world.store, () => T).check(nonce, 'yesterday', ALICE.did)).toBe(false);
  });
});
