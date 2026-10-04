/**
 * Lane 1 registration (design §5.3, §5.5, §6.1): the live card fetched under
 * the outbound port, parsed strictly, its interface chosen, its signatures
 * checked against keys from `jku`, pinned; then credentials, bindings,
 * activation, re-verification and revocation.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { base64urlEncode, cardPinHash, signAgentCard, type JsonObject } from '@dina/a2a';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  a2aFetch,
  activateRemoteAgent,
  bindRemoteSkill,
  checkOutboundUrl,
  createNoneCredential,
  jwkThumbprint,
  parsePublicJwk,
  registerRemoteAgent,
  reverifyRemoteAgent,
  revokeRemoteAgent,
  setA2AHostTransport,
  unbindRemoteSkill,
  verifyWithJwk,
  type A2AHttpRequest,
  type A2AHttpResult,
} from '../../src/a2a';
import { A2AStore } from '../../src/a2a/store';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const CARD_URL = 'https://agent.example/.well-known/agent-card.json';
const JKU = 'https://agent.example/jwks.json';
const NOW = 1_800_000_000_000;

const baseCard = (over: Record<string, unknown> = {}): JsonObject =>
  ({
    name: 'Summarizer‮',
    description: 'Summarizes text.',
    supportedInterfaces: [
      { url: 'https://agent.example/grpc', protocolBinding: 'GRPC', protocolVersion: '1.0' },
      { url: 'https://agent.example/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ],
    version: '1.0.0',
    capabilities: { streaming: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      { id: 'summarize', name: 'Summarize', description: 'Summarize a text.', tags: ['text'] },
      { id: 'translate', name: 'Translate', description: 'Translate a text.', tags: ['text'] },
    ],
    ...over,
  }) as JsonObject;

const es256Secret = p256.utils.randomSecretKey();
const es256Point = p256.getPublicKey(es256Secret, false);
const es256Jwk = {
  kty: 'EC',
  crv: 'P-256',
  kid: 'k1',
  use: 'sig',
  x: base64urlEncode(es256Point.slice(1, 33)),
  y: base64urlEncode(es256Point.slice(33)),
};
const edSecret = ed25519.utils.randomSecretKey();
const edJwk = { kty: 'OKP', crv: 'Ed25519', kid: 'e1', x: base64urlEncode(ed25519.getPublicKey(edSecret)) };

async function signedCard(card: JsonObject, opts: { highS?: boolean; jku?: string | null; kid?: string } = {}): Promise<JsonObject> {
  const sig = await signAgentCard(
    card,
    { alg: 'ES256', kid: opts.kid ?? 'k1', ...(opts.jku === null ? {} : { jku: opts.jku ?? JKU }) },
    (input) => {
      const s = p256.sign(input, es256Secret, { lowS: false });
      if (opts.highS === undefined) return s;
      // Force the requested half of S: S and n - S both verify without low-S.
      const n = p256.Point.Fn.ORDER;
      const S = BigInt(`0x${Buffer.from(s.slice(32)).toString('hex')}`);
      const wantHigh = opts.highS;
      const flipped = (S > n / 2n) !== wantHigh ? n - S : S;
      const out = new Uint8Array(64);
      out.set(s.slice(0, 32));
      out.set(Buffer.from(flipped.toString(16).padStart(64, '0'), 'hex'), 32);
      return out;
    },
  );
  return { ...card, signatures: [sig as unknown as JsonObject] };
}

interface Served {
  status?: number;
  body: string;
}

let routes: Map<string, Served | A2AHttpResult>;
let requests: A2AHttpRequest[];

function serve(url: string, value: unknown, status = 200): void {
  routes.set(url, { status, body: typeof value === 'string' ? value : JSON.stringify(value) });
}

let dir: string;
let db: NodeSQLiteAdapter;
let store: A2AStore;
let clock = NOW;
const deps = () => ({ store, nowMs: () => clock });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'a2a-agents-'));
  db = new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: 'cd'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  store = new A2AStore(db);
  clock = NOW;
  routes = new Map();
  requests = [];
  serve(JKU, { keys: [es256Jwk, edJwk] });
  setA2AHostTransport(async (request) => {
    requests.push(request);
    const hit = routes.get(request.url);
    if (hit === undefined) return { ok: false, error: 'dns_failed', sent: false };
    if ('ok' in hit) return hit;
    return { ok: true, status: hit.status ?? 200, body: hit.body, connectedAddress: '203.0.113.9' };
  });
});

afterEach(() => {
  setA2AHostTransport(null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the outbound port', () => {
  it.each([
    ['http://agent.example/x', 'not_https'],
    ['https://u:p@agent.example/x', 'credentials_in_url'],
    ['https://10.0.0.1/x', 'literal_ip'],
    ['https://[fe80::1]/x', 'literal_ip'],
    ['https://agent.example/x#f', 'fragment'],
    ['not a url', 'url_unparseable'],
  ])('refuses %s (%s) before any transport sees it', async (url, reason) => {
    expect(checkOutboundUrl(url)).toEqual({ ok: false, reason });
    expect(await a2aFetch({ method: 'GET', url, headers: {}, maxResponseBytes: 10, timeoutMs: 10 })).toEqual({
      ok: false,
      error: 'url_refused',
      sent: false,
    });
    expect(requests).toEqual([]);
  });

  it('answers unavailable when no host transport is installed (the phone, D6)', async () => {
    setA2AHostTransport(null);
    expect(await a2aFetch({ method: 'GET', url: CARD_URL, headers: {}, maxResponseBytes: 10, timeoutMs: 10 })).toEqual({
      ok: false,
      error: 'unavailable',
      sent: false,
    });
  });

  it('holds its own deadline: a transport that overruns it answers timeout, possibly sent', async () => {
    setA2AHostTransport(() => new Promise<A2AHttpResult>(() => undefined));
    expect(await a2aFetch({ method: 'POST', url: CARD_URL, headers: {}, maxResponseBytes: 10, timeoutMs: 20 })).toEqual({
      ok: false,
      error: 'timeout',
      sent: true,
    });
  });

  it('treats a transport that throws as having possibly sent', async () => {
    setA2AHostTransport(async () => {
      throw new Error('boom');
    });
    expect(await a2aFetch({ method: 'POST', url: CARD_URL, headers: {}, maxResponseBytes: 10, timeoutMs: 10 })).toEqual({
      ok: false,
      error: 'io_error',
      sent: true,
    });
  });
});

describe('registration', () => {
  it('pins an unsigned card as a candidate on its first JSON-RPC 1.0 interface', async () => {
    serve(CARD_URL, baseCard());
    const out = await registerRemoteAgent(deps(), CARD_URL);
    if (!out.ok) throw new Error(out.reason);
    expect(out.agent).toMatchObject({
      status: 'candidate',
      endpoint: 'https://agent.example/rpc',
      endpoint_tenant: '',
      signature_state: 'unsigned',
      name: 'Summarizer',
      card_url: CARD_URL,
    });
    expect(out.agent.card_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(requests.map((r) => [r.method, r.url, r.maxResponseBytes])).toEqual([['GET', CARD_URL, 128 * 1024]]);
  });

  it('records the interface tenant', async () => {
    serve(CARD_URL, baseCard({ supportedInterfaces: [{ url: 'https://agent.example/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0.1', tenant: 't-9' }] }));
    const out = await registerRemoteAgent(deps(), CARD_URL);
    expect(out.ok && out.agent.endpoint_tenant).toBe('t-9');
  });

  it('refuses a second live registration of the same URL', async () => {
    serve(CARD_URL, baseCard());
    const first = await registerRemoteAgent(deps(), CARD_URL);
    const second = await registerRemoteAgent(deps(), CARD_URL);
    expect(second).toEqual({ ok: false, reason: 'already_registered', existingAgentId: first.ok ? first.agent.agent_id : '' });
  });

  it.each([
    ['a transport failure', () => routes.set(CARD_URL, { ok: false, error: 'address_blocked', sent: false }), 'card_fetch_address_blocked'],
    ['a 404', () => serve(CARD_URL, '{}', 404), 'card_fetch_status_404'],
    ['text that is not JSON', () => serve(CARD_URL, '<html>'), 'card_json_syntax'],
    ['duplicate members', () => serve(CARD_URL, '{"name":"a","name":"b"}'), 'card_json_duplicate_member'],
    ['a __proto__ member', () => serve(CARD_URL, '{"__proto__":{}}'), 'card_json_forbidden_member'],
    ['a malformed card', () => serve(CARD_URL, { name: 'x' }), 'card_description_required'],
    ['only gRPC', () => serve(CARD_URL, baseCard({ supportedInterfaces: [{ url: 'https://agent.example/g', protocolBinding: 'GRPC', protocolVersion: '1.0' }] })), 'card_no_jsonrpc_1_0_interface'],
    ['only A2A 0.3', () => serve(CARD_URL, baseCard({ supportedInterfaces: [{ url: 'https://agent.example/rpc', protocolBinding: 'JSONRPC', protocolVersion: '0.3' }] })), 'card_no_jsonrpc_1_0_interface'],
    ['a plain-HTTP endpoint', () => serve(CARD_URL, baseCard({ supportedInterfaces: [{ url: 'http://agent.example/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] })), 'card_no_jsonrpc_1_0_interface'],
  ])('refuses %s', async (_name, setup, reason) => {
    setup();
    expect(await registerRemoteAgent(deps(), CARD_URL)).toEqual({ ok: false, reason });
    expect(store.listAgents()).toEqual([]);
  });

  it('answers already_registered with the winner when a concurrent registration wins the race', async () => {
    serve(CARD_URL, baseCard());
    const winner = await registerRemoteAgent(deps(), CARD_URL);
    if (!winner.ok) throw new Error(winner.reason);
    // The loser checked before the winner committed: replay that empty read.
    const early = jest.spyOn(store, 'getLiveAgentByUrl').mockReturnValueOnce(null);
    try {
      expect(await registerRemoteAgent(deps(), CARD_URL)).toEqual({
        ok: false,
        reason: 'already_registered',
        existingAgentId: winner.agent.agent_id,
      });
    } finally {
      early.mockRestore();
    }
    expect(store.listAgents()).toHaveLength(1);
  });

  it('rethrows an insert failure that no winning registration explains', async () => {
    serve(CARD_URL, baseCard());
    const insert = jest.spyOn(store, 'insertAgent').mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    try {
      await expect(registerRemoteAgent(deps(), CARD_URL)).rejects.toThrow('disk I/O error');
    } finally {
      insert.mockRestore();
    }
  });

  it('refuses a card URL outside the policy without fetching', async () => {
    expect(await registerRemoteAgent(deps(), 'https://192.168.1.4/card.json')).toEqual({ ok: false, reason: 'card_url_literal_ip' });
    expect(requests).toEqual([]);
  });
});

describe('signatures', () => {
  it('verifies an ES256 card through its jku, and pins the key by its RFC 7638 thumbprint, not its kid', async () => {
    const card = await signedCard(baseCard());
    serve(CARD_URL, card);
    const out = await registerRemoteAgent(deps(), CARD_URL);
    if (!out.ok) throw new Error(out.reason);
    expect(out.agent.signature_state).toBe('verified');
    // The owner reads the key by the name the card gave it.
    expect(out.agent.signature_detail).toMatch(/Signed by key k1 from https:\/\/agent\.example\/jwks\.json/);
    // The pin names it by what it is.
    const key = parsePublicJwk(es256Jwk);
    if (key === null) throw new Error('jwk');
    expect(out.agent.card_hash).toBe(cardPinHash(card, [`jwk:${jwkThumbprint(key)}`], sha256));
    expect(out.agent.card_hash).not.toBe(cardPinHash(card, [`${JKU}#k1`], sha256));
  });

  it('accepts a high-S ES256 signature (JWS does not normalize S)', async () => {
    serve(CARD_URL, await signedCard(baseCard(), { highS: true }));
    const out = await registerRemoteAgent(deps(), CARD_URL);
    expect(out.ok && out.agent.signature_state).toBe('verified');
  });

  it('verifies an EdDSA card', async () => {
    const card = baseCard();
    const sig = await signAgentCard(card, { alg: 'EdDSA', kid: 'e1', jku: JKU }, (input) => ed25519.sign(input, edSecret));
    serve(CARD_URL, { ...card, signatures: [sig] });
    const out = await registerRemoteAgent(deps(), CARD_URL);
    expect(out.ok && out.agent.signature_state).toBe('verified');
  });

  it.each([
    ['no jku', async () => signedCard(baseCard(), { jku: null }), /names no key set/],
    ['an unreachable key set', async () => signedCard(baseCard(), { jku: 'https://keys.example/missing.json' }), /could not be found/],
    ['an unknown kid', async () => signedCard(baseCard(), { kid: 'nope' }), /could not be found/],
    ['a tampered card', async () => ({ ...(await signedCard(baseCard())), description: 'Changed after signing.' }), /does not match/],
  ])('registers %s as invalid, and says why', async (_name, build, detail) => {
    serve(CARD_URL, await build());
    const out = await registerRemoteAgent(deps(), CARD_URL);
    if (!out.ok) throw new Error(out.reason);
    expect(out.agent.signature_state).toBe('invalid');
    expect(out.agent.signature_detail).toMatch(detail);
  });

  it('checks at most 8 signatures: a card with more is invalid, and no key set is fetched', async () => {
    const one = (await signedCard(baseCard())).signatures as JsonObject[];
    serve(CARD_URL, { ...baseCard(), signatures: Array.from({ length: 9 }, () => one[0]) });
    const out = await registerRemoteAgent(deps(), CARD_URL);
    expect(out.ok && out.agent.signature_state).toBe('invalid');
    expect(requests.filter((r) => r.url !== CARD_URL)).toEqual([]);
  });

  it('fetches at most 2 distinct key sets for one card', async () => {
    const sets = ['a', 'b', 'c', 'd', 'e'].map((n) => `https://keys.example/${n}.json`);
    const signatures = await Promise.all(sets.map(async (jku) => ((await signedCard(baseCard(), { jku })).signatures as JsonObject[])[0]));
    serve(CARD_URL, { ...baseCard(), signatures });
    await registerRemoteAgent(deps(), CARD_URL);
    expect(requests.filter((r) => r.url.startsWith('https://keys.example/'))).toHaveLength(2);
  });

  it('refuses a key set of more than 32 keys', async () => {
    serve(JKU, { keys: Array.from({ length: 33 }, () => es256Jwk) });
    serve(CARD_URL, await signedCard(baseCard()));
    const out = await registerRemoteAgent(deps(), CARD_URL);
    expect(out.ok && out.agent.signature_state).toBe('invalid');
  });

  it('tries at most 4 keys under one kid', async () => {
    const wrongPoint = p256.getPublicKey(p256.utils.randomSecretKey(), false);
    const wrong = { ...es256Jwk, x: base64urlEncode(wrongPoint.slice(1, 33)), y: base64urlEncode(wrongPoint.slice(33)) };
    serve(JKU, { keys: [wrong, wrong, wrong, wrong, es256Jwk] });
    serve(CARD_URL, await signedCard(baseCard()));
    const out = await registerRemoteAgent(deps(), CARD_URL);
    expect(out.ok && out.agent.signature_state).toBe('invalid');
    serve(JKU, { keys: [wrong, wrong, wrong, es256Jwk] });
    const again = await reverifyRemoteAgent(deps(), out.ok ? out.agent.agent_id : '');
    expect(again.ok && again.agent.signature_state).toBe('verified');
  });

  it('does not use a key whose declared use is not signing', async () => {
    serve(JKU, { keys: [{ ...es256Jwk, use: 'enc' }] });
    serve(CARD_URL, await signedCard(baseCard()));
    const out = await registerRemoteAgent(deps(), CARD_URL);
    expect(out.ok && out.agent.signature_state).toBe('invalid');
  });

  it('refuses a JWK that carries a private member, and thumbprints per RFC 7638', () => {
    expect(parsePublicJwk({ ...es256Jwk, d: 'secret' })).toBeNull();
    const parsed = parsePublicJwk(es256Jwk);
    if (parsed === null) throw new Error('parse');
    expect(jwkThumbprint(parsed)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(jwkThumbprint(parsed)).toBe(jwkThumbprint(parsePublicJwk({ ...es256Jwk, kid: 'other', use: undefined }) ?? parsed));
    expect(verifyWithJwk(parsed, 'EdDSA', new Uint8Array(1), new Uint8Array(64))).toBe(false);
  });

  it('keeps the pin when unchanged content is re-signed, and changes it when the key changes', async () => {
    serve(CARD_URL, await signedCard(baseCard()));
    const reg = await registerRemoteAgent(deps(), CARD_URL);
    if (!reg.ok) throw new Error(reg.reason);
    serve(CARD_URL, await signedCard(baseCard(), { highS: true })); // new signature bytes, same key
    const same = await reverifyRemoteAgent(deps(), reg.agent.agent_id);
    expect(same.ok && same.changed).toBe(false);
    serve(CARD_URL, baseCard()); // the signature is gone
    const lost = await reverifyRemoteAgent(deps(), reg.agent.agent_id);
    expect(lost.ok && lost.changed).toBe(true);
    expect(lost.ok && lost.agent.status).toBe('changed');
  });

  // Cold audit C3-16: a new key under the same kid and jku is a new signer
  it('changes the pin when another key signs the same content under the same kid and key set', async () => {
    serve(CARD_URL, await signedCard(baseCard()));
    const reg = await registerRemoteAgent(deps(), CARD_URL);
    if (!reg.ok) throw new Error(reg.reason);
    // The publisher rotates: key B now answers to kid k1 at the same jku, and signs the unchanged card.
    const secretB = p256.utils.randomSecretKey();
    const pointB = p256.getPublicKey(secretB, false);
    const jwkB = { ...es256Jwk, x: base64urlEncode(pointB.slice(1, 33)), y: base64urlEncode(pointB.slice(33)) };
    serve(JKU, { keys: [jwkB, edJwk] });
    const card = baseCard();
    const sigB = await signAgentCard(card, { alg: 'ES256', kid: 'k1', jku: JKU }, (input) => p256.sign(input, secretB));
    serve(CARD_URL, { ...card, signatures: [sigB as unknown as JsonObject] });
    const rotated = await reverifyRemoteAgent(deps(), reg.agent.agent_id);
    if (!rotated.ok) throw new Error(rotated.reason);
    // Still verified, by another key: the owner's review is due again.
    expect([rotated.agent.signature_state, rotated.changed, rotated.agent.status]).toEqual(['verified', true, 'changed']);
  });
});

describe('credentials, bindings, activation', () => {
  async function registered(card: JsonObject = baseCard()): Promise<string> {
    serve(CARD_URL, card);
    const out = await registerRemoteAgent(deps(), CARD_URL);
    if (!out.ok) throw new Error(out.reason);
    return out.agent.agent_id;
  }

  it('creates versioned none credentials, and refuses one for a card that requires credentials', async () => {
    const id = await registered();
    const a = createNoneCredential(deps(), id);
    const b = createNoneCredential(deps(), id);
    expect(a.ok && a.credential).toMatchObject({ kind: 'none', revision: 1, status: 'active', scope_json: '{"kind":"none"}' });
    expect(b.ok && b.credential.revision).toBe(2);
    revokeRemoteAgent(deps(), id);
    const secured = await registered(baseCard({ securityRequirements: [{ schemes: { bearer: { list: [] } } }] }));
    expect(createNoneCredential(deps(), secured)).toEqual({ ok: false, reason: 'credential_required_by_card' });
  });

  it('binds only skills on the pinned card, with an active credential of the same agent', async () => {
    const id = await registered();
    const cred = createNoneCredential(deps(), id);
    if (!cred.ok) throw new Error(cred.reason);
    const ref = cred.credential.credential_ref;
    expect(bindRemoteSkill(deps(), id, { skill: 'nope', actionClass: 'read', credentialRef: ref })).toEqual({ ok: false, reason: 'skill_not_on_card' });
    expect(bindRemoteSkill(deps(), id, { skill: 'summarize', actionClass: 'payment', credentialRef: ref })).toEqual({ ok: false, reason: 'payment_unassignable' });
    expect(bindRemoteSkill(deps(), id, { skill: 'summarize', actionClass: 'read', credentialRef: 'other' })).toEqual({ ok: false, reason: 'credential_not_found' });
    const bound = bindRemoteSkill(deps(), id, {
      skill: 'summarize',
      actionClass: 'read',
      credentialRef: ref,
      resultSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    });
    expect(bound.ok && bound.binding).toMatchObject({ revision: 1, action_class: 'read', result_schema_json: '{"properties":{"summary":{"type":"string"}},"required":["summary"],"type":"object"}' });
    store.revokeCredential(ref, NOW);
    expect(bindRemoteSkill(deps(), id, { skill: 'translate', actionClass: 'read', credentialRef: ref })).toEqual({ ok: false, reason: 'credential_revoked' });
  });

  it('activates only with a bound skill, and a changed card needs re-binding', async () => {
    const id = await registered();
    expect(activateRemoteAgent(deps(), id)).toEqual({ ok: false, reason: 'no_bound_skill' });
    const cred = createNoneCredential(deps(), id);
    if (!cred.ok) throw new Error(cred.reason);
    bindRemoteSkill(deps(), id, { skill: 'summarize', actionClass: 'read', credentialRef: cred.credential.credential_ref });
    expect(activateRemoteAgent(deps(), id)).toEqual({ ok: true });
    expect(activateRemoteAgent(deps(), id)).toEqual({ ok: false, reason: 'already_active' });

    serve(CARD_URL, baseCard({ version: '2.0.0' }));
    const verified = await reverifyRemoteAgent(deps(), id);
    expect(verified.ok && verified.agent.status).toBe('changed');
    expect(activateRemoteAgent(deps(), id)).toEqual({ ok: false, reason: 'no_bound_skill' });
    bindRemoteSkill(deps(), id, { skill: 'summarize', actionClass: 'read', credentialRef: cred.credential.credential_ref });
    expect(activateRemoteAgent(deps(), id)).toEqual({ ok: true });
    expect(unbindRemoteSkill(deps(), id, 'summarize')).toBe(true);
  });

  it('a revoked agent cannot be re-verified, bound or activated, and its URL can be registered again', async () => {
    const id = await registered();
    expect(revokeRemoteAgent(deps(), id)).toBe(true);
    expect(await reverifyRemoteAgent(deps(), id)).toEqual({ ok: false, reason: 'revoked' });
    expect(createNoneCredential(deps(), id)).toEqual({ ok: false, reason: 'revoked' });
    expect(activateRemoteAgent(deps(), id)).toEqual({ ok: false, reason: 'revoked' });
    const again = await registerRemoteAgent(deps(), CARD_URL);
    expect(again.ok && again.agent.agent_id).not.toBe(id);
  });
});
