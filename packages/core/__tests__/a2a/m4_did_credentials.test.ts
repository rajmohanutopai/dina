/**
 * M4 DID credentials (design §5.1, notes M4 step 1): the rules the plan's
 * area D listed with no test of their own. The owner's challenge needs the
 * node DID; the binding body is strict I-JSON and a DID cannot carry a
 * line break; the store holds one active client per DID; did:web does not
 * bind yet; a DID-signed call is bound to its task and its query; a request
 * with some of the four signature headers is never read as a bearer call;
 * a signed call stamps last_used_at; a nonce is spent per DID, and only
 * once a signature is proven.
 */

import { bytesToHex } from '@noble/hashes/utils.js';

import { A2A_DID_BINDING_PATH, didBindingSigningInput } from '@dina/a2a';

import {
  A2A_RPC_PATH,
  createA2AClient,
  getA2AClient,
  ingressCompleteDidBinding,
  ingressGetTask,
  ingressListTasks,
  ingressSendMessage,
  installA2ADidResolver,
  issueDidChallenge,
  revokeA2AClient,
  type GatewayEnvelope,
} from '../../src/a2a';
import { getPublicKey, sign } from '../../src/crypto/ed25519';
import { DIDResolver } from '../../src/d2d/resolver';
import { deriveDIDKey } from '../../src/identity/did';
import { clearPairingState, setNodeDID } from '../../src/pairing/ceremony';
import { CoreRouter, type CoreResponse } from '../../src/server/router';
import { registerA2ARoutes } from '../../src/server/routes/a2a';

import { InboundWorld, didRequestSignature, errorOf, resultOf, sentTask } from './inbound_fixture';

const NODE_DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const CAP = 'owner-capability-for-m4-tests';

const keyOf = (n: number) => {
  const privateKey = new Uint8Array(32).fill(n);
  const publicKey = getPublicKey(privateKey);
  return { privateKey, publicKey, did: deriveDIDKey(publicKey) };
};
type Signer = ReturnType<typeof keyOf>;
const ALICE = keyOf(41);
const MALLORY = keyOf(42);

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
});
afterEach(() => {
  installA2ADidResolver(null);
  clearPairingState();
  iw.close();
});

function challenge(did: string, clientId = iw.clientId): string {
  const out = issueDidChallenge(iw.world.store, clientId, did, iw.world.clock);
  if (!out.ok) throw new Error(out.reason);
  return out.challenge;
}

function signature(args: { did: string; challenge: string; signer: Signer; clientId?: string }): string {
  const input = didBindingSigningInput({
    nodeDid: NODE_DID,
    clientId: args.clientId ?? iw.clientId,
    did: args.did,
    challenge: args.challenge,
  });
  return bytesToHex(sign(args.signer.privateKey, new TextEncoder().encode(input)));
}

/** The binding request as the gateway forwards it: the body as sent, no credential. */
const bind = (body: string) =>
  ingressCompleteDidBinding(
    iw.rt,
    { request: { method: 'POST', path: A2A_DID_BINDING_PATH, query: '', body }, client_auth: {} },
    NODE_DID,
  );

async function bindAs(signer: Signer, clientId = iw.clientId): Promise<void> {
  const c = challenge(signer.did, clientId);
  const body = JSON.stringify({ did: signer.did, challenge: c, signature: signature({ did: signer.did, challenge: c, signer, clientId }) });
  const out = await bind(body);
  if (out.status !== 200) throw new Error(`bind: ${JSON.stringify(out.body)}`);
}

/** A JSON-RPC call signed with `signer`'s DID over the client's own request, as the gateway forwards it. */
let rpcId = 5000;
function signedCall(method: string, params: Record<string, unknown>, signer: Signer, query = ''): GatewayEnvelope {
  rpcId += 1;
  const body = JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params });
  return {
    request: { method: 'POST', path: A2A_RPC_PATH, query, body, version: '1.0' },
    client_auth: { did_signature: didRequestSignature({ query, body, signer }) },
  };
}

/** The same, with the nonce and the time chosen by the test. */
function signedWith(nonce: string, body: string, signer: Signer, did = signer.did): GatewayEnvelope {
  return {
    request: { method: 'POST', path: A2A_RPC_PATH, query: '', body, version: '1.0' },
    client_auth: { did_signature: didRequestSignature({ body, signer, did, nonce }) },
  };
}

const listBody = () => {
  rpcId += 1;
  return JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'ListTasks', params: {} });
};
let messageNo = 0;
/** A fresh call (its own message id, so it is never a replay of another). */
const etaMessage = () => {
  messageNo += 1;
  return iw.message({ skill: 'eta_query', params: { route_id: '42' } }, { messageId: `m4-did-${messageNo}` });
};

describe('the owner challenge route (§5.1)', () => {
  const router = new CoreRouter();
  registerA2ARoutes(router, CAP);
  const post = (clientId: string, body: Record<string, unknown>): Promise<CoreResponse> =>
    router.handle({
      method: 'POST',
      path: `/v1/owner/a2a/clients/${clientId}/did-challenge`,
      query: {},
      headers: {},
      body,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'owner',
      ownerCapability: CAP,
    });

  // Plan D7
  it('issues no challenge while the node has no DID to sign into it, and stores nothing', async () => {
    clearPairingState();
    const out = await post(iw.clientId, { did: ALICE.did });
    expect([out.status, (out.body as { error?: string }).error]).toEqual([503, 'node_did_unavailable']);
    expect(iw.world.store.db.query('SELECT challenge_hash FROM a2a_did_challenges')).toEqual([]);
    // With the node DID set, the same request issues one.
    setNodeDID(NODE_DID);
    const issued = await post(iw.clientId, { did: ALICE.did });
    expect(issued.status).toBe(201);
    expect((issued.body as { node_did: string }).node_did).toBe(NODE_DID);
  });
});

describe('the binding body is strict (§5.1 strict I-JSON, the DID charset)', () => {
  // Plan D14
  it('refuses a body with a __proto__ member, and binds nothing', async () => {
    const c = challenge(ALICE.did);
    const sig = signature({ did: ALICE.did, challenge: c, signer: ALICE });
    for (const body of [
      `{"did":"${ALICE.did}","challenge":"${c}","signature":"${sig}","__proto__":{}}`,
      `{"__proto__":{"did":"${MALLORY.did}"},"did":"${ALICE.did}","challenge":"${c}","signature":"${sig}"}`,
    ]) {
      expect(await bind(body)).toEqual({ status: 400, body: { error: 'request_malformed' } });
    }
    expect(getA2AClient(iw.world.store, iw.clientId)?.bound_did).toBeNull();
    // The refused tries spent nothing: the well-formed body still binds.
    expect((await bind(JSON.stringify({ did: ALICE.did, challenge: c, signature: sig }))).status).toBe(200);
  });

  // Plan D14
  it('refuses a DID with a line break, which could forge a line of the signing input', async () => {
    for (const did of [`${ALICE.did}\n${MALLORY.did}`, `${ALICE.did}\n`]) {
      expect(issueDidChallenge(iw.world.store, iw.clientId, did, iw.world.clock)).toEqual({
        ok: false,
        reason: 'did_malformed',
      });
    }
    const c = challenge(ALICE.did);
    const forged = `${ALICE.did}\n`;
    const body = JSON.stringify({ did: forged, challenge: c, signature: signature({ did: forged, challenge: c, signer: ALICE }) });
    expect(await bind(body)).toEqual({ status: 400, body: { error: 'request_malformed' } });
    expect(getA2AClient(iw.world.store, iw.clientId)?.bound_did).toBeNull();
  });
});

describe('one active client per DID, in the store itself (design §9, idx_a2a_clients_bound_did)', () => {
  // Plan D19
  it('refuses a second active row on one DID, by UPDATE or by INSERT; a revoked row no longer holds the DID', async () => {
    const UNIQUE = /UNIQUE constraint failed: a2a_clients\.bound_did/;
    await bindAs(ALICE);
    const other = createA2AClient(iw.world.store, { display_name: 'Other' }, iw.world.clock);
    if (!other.ok) throw new Error(other.reason);
    const update = () =>
      iw.world.store.db.execute('UPDATE a2a_clients SET bound_did = ? WHERE client_id = ?', [ALICE.did, other.client.client_id]);
    const insert = (clientId: string) => () =>
      iw.world.store.db.execute(
        "INSERT INTO a2a_clients (client_id, display_name, bound_did, status, created_at) VALUES (?, 'Direct', ?, 'active', ?)",
        [clientId, ALICE.did, iw.world.clock],
      );
    expect(update).toThrow(UNIQUE);
    expect(insert('ac_direct_1')).toThrow(UNIQUE);
    expect(getA2AClient(iw.world.store, other.client.client_id)?.bound_did).toBeNull();
    expect(getA2AClient(iw.world.store, 'ac_direct_1')).toBeNull();
    // A revoked row on the DID holds nothing: the same writes now go through.
    revokeA2AClient(iw.world.store, iw.grants, iw.clientId, iw.world.clock);
    expect(update).not.toThrow();
    expect(getA2AClient(iw.world.store, other.client.client_id)?.bound_did).toBe(ALICE.did);
    // And the row just written holds the DID in its turn.
    expect(insert('ac_direct_2')).toThrow(UNIQUE);
  });
});

describe('did:web (notes M4: the host has no did:web resolver yet)', () => {
  // Plan D32
  it('cannot bind through the host’s lookup, which opens no connection for it', async () => {
    const fetched: string[] = [];
    const resolver = new DIDResolver({
      plcDirectory: 'https://plc.example',
      fetch: (async (url: string | URL | Request) => {
        fetched.push(String(url));
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    // The host's lookup is asked, and declines did:web without a connection.
    const asked: string[] = [];
    installA2ADidResolver((d) => {
      asked.push(d);
      return resolver.lookup(d);
    });
    const did = 'did:web:agent.example';
    const c = challenge(did);
    const body = JSON.stringify({ did, challenge: c, signature: signature({ did, challenge: c, signer: ALICE }) });
    expect(await bind(body)).toEqual({ status: 400, body: { error: 'did_unresolvable' } });
    expect(asked).toEqual([did]);
    expect(fetched).toEqual([]);
    expect(getA2AClient(iw.world.store, iw.clientId)).toEqual(
      expect.objectContaining({ bound_did: null, credential: 'bearer' }),
    );
  });
});

describe('a DID-signed call is bound to the task and the query it signed (§5.1 dispatch binding)', () => {
  beforeEach(async () => {
    await bindAs(ALICE);
  });

  // Plan D38
  it('refuses a signed GetTask for one task sent to another task’s route, and reveals neither', () => {
    const a = sentTask(ingressSendMessage(iw.rt, signedCall('SendMessage', etaMessage(), ALICE))).id as string;
    const b = sentTask(ingressSendMessage(iw.rt, signedCall('SendMessage', etaMessage(), ALICE))).id as string;
    expect(b).not.toBe(a);
    const out = ingressGetTask(iw.rt, signedCall('GetTask', { id: a }, ALICE), b);
    expect(errorOf(out)).toEqual({ code: -32600, reason: 'id_mismatch' });
    expect(JSON.stringify(out.body)).not.toContain(a);
    expect(JSON.stringify(out.body)).not.toContain(b);
    // The same signed read at its own route goes through.
    expect(resultOf(ingressGetTask(iw.rt, signedCall('GetTask', { id: a }, ALICE), a)).id).toBe(a);
  });

  // Plan D39
  it('refuses a signed query other than A2A-Version, though the signature covers it', () => {
    const body = listBody();
    const signedQuery = (query: string): GatewayEnvelope => {
      return {
        request: { method: 'POST', path: A2A_RPC_PATH, query, body, version: '1.0' },
        client_auth: { did_signature: didRequestSignature({ query, body, signer: ALICE }) },
      };
    };
    expect(errorOf(ingressListTasks(iw.rt, signedQuery('debug=1')))).toEqual({ code: -32600, reason: 'query_not_allowed' });
    expect(ingressListTasks(iw.rt, signedQuery('A2A-Version=1.0')).status).toBe(200);
    expect(resultOf(ingressListTasks(iw.rt, signedQuery('A2A-Version=1.0'))).tasks).toEqual([]);
  });
});

describe('one credential, never half of one (§5.1)', () => {
  /** What the gateway forwards when the client sent X-DID and no other signature header. */
  const didAlone = (did: string) => ({ did, timestamp: '', nonce: '', signature: '' });

  // Plan D41
  it('reads a request with only some of the four headers as no credential, even beside a valid bearer', async () => {
    const body = listBody();
    const envelope = (client_auth: GatewayEnvelope['client_auth']): GatewayEnvelope => ({
      request: { method: 'POST', path: A2A_RPC_PATH, query: '', body, version: '1.0' },
      client_auth,
    });
    // The bearer alone works: the refusals below are the half signature's.
    expect(ingressListTasks(iw.rt, envelope({ authorization: `Bearer ${iw.token}` })).status).toBe(200);
    expect(
      ingressListTasks(iw.rt, envelope({ authorization: `Bearer ${iw.token}`, did_signature: didAlone(ALICE.did) })).status,
    ).toBe(401);
    expect(ingressListTasks(iw.rt, envelope({ did_signature: didAlone(ALICE.did) })).status).toBe(401);
    // A client bound to that DID gets nothing from X-DID alone either.
    await bindAs(ALICE);
    expect(ingressListTasks(iw.rt, envelope({ did_signature: didAlone(ALICE.did) })).status).toBe(401);
    expect(ingressListTasks(iw.rt, envelope({ did_signature: { ...didAlone(ALICE.did), nonce: 'n'.repeat(32) } })).status).toBe(
      401,
    );
  });
});

describe('a DID-signed call is a use of the credential (§5.1 last_used_at)', () => {
  const lastUsed = () => getA2AClient(iw.world.store, iw.clientId)?.last_used_at;

  // Plan D43
  it('stamps last_used_at as a bearer call does; a refused signature stamps nothing', async () => {
    await bindAs(ALICE);
    iw.world.store.db.execute('UPDATE a2a_clients SET last_used_at = NULL WHERE client_id = ?', [iw.clientId]);
    const forged = signedCall('ListTasks', {}, ALICE);
    const sig = forged.client_auth.did_signature;
    if (sig === undefined) throw new Error('not signed');
    const tampered: GatewayEnvelope = { ...forged, client_auth: { did_signature: { ...sig, signature: 'ab'.repeat(64) } } };
    expect(ingressListTasks(iw.rt, tampered).status).toBe(401);
    expect(lastUsed()).toBeNull();
    expect(ingressListTasks(iw.rt, signedCall('ListTasks', {}, ALICE)).status).toBe(200);
    expect(lastUsed()).toBe(iw.world.clock);
    iw.world.clock += 61_000;
    expect(ingressListTasks(iw.rt, signedCall('ListTasks', {}, ALICE)).status).toBe(200);
    expect(lastUsed()).toBe(iw.world.clock);
  });
});

describe('the nonce replay store (§5.1, notes M4: per DID, after a proven signature)', () => {
  beforeEach(async () => {
    await bindAs(ALICE);
  });
  const nonceRows = (nonce: string) =>
    iw.world.store.db.query('SELECT did FROM a2a_request_nonces WHERE nonce = ?', [nonce]) as { did: string }[];

  // Plan D54
  it('spends a nonce for its DID, whatever request it came with: another signed body under it is a replay', () => {
    const nonce = 'S'.repeat(32);
    expect(ingressListTasks(iw.rt, signedWith(nonce, listBody(), ALICE)).status).toBe(200);
    // Signed afresh, over another body, with the same nonce.
    expect(ingressListTasks(iw.rt, signedWith(nonce, listBody(), ALICE)).status).toBe(401);
    expect(nonceRows(nonce)).toEqual([{ did: ALICE.did }]);
  });

  // Plan D55
  it('spends nothing for a request whose signature fails: the real signer’s request with that nonce still runs', () => {
    const nonce = 'F'.repeat(32);
    // Signed with another key, claiming to be ALICE.
    expect(ingressListTasks(iw.rt, signedWith(nonce, listBody(), MALLORY, ALICE.did)).status).toBe(401);
    expect(nonceRows(nonce)).toEqual([]);
    expect(ingressListTasks(iw.rt, signedWith(nonce, listBody(), ALICE)).status).toBe(200);
    expect(nonceRows(nonce)).toEqual([{ did: ALICE.did }]);
  });
});
