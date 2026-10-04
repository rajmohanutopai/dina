/**
 * Lane 1 registration gaps (design §5.3, §6.1, §6.6, §8.4; A2A-I1, A2A-I13):
 * which interface Dina pins, which key sets it fetches, what card text the
 * owner and Brain see, what a card that changes and changes back allows,
 * what a directory candidate allows, and which OAuth token endpoints a
 * credential may name.
 */

import { p256 } from '@noble/curves/nist.js';

import { DINA_A2A_EXTENSION_URI, base64urlEncode, signAgentCard, type JsonObject } from '@dina/a2a';

import {
  activateRemoteAgent,
  bindRemoteSkill,
  cardSchemeChoices,
  createNoneCredential,
  createRemoteCredential,
  installA2ADirectoryEvidence,
  parseDelegationConsentCard,
  pinnedRemoteSkills,
  proposeDelegation,
  registerRemoteAgent,
  reverifyRemoteAgent,
} from '../../src/a2a';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { brainAgentsView, registerA2ARoutes } from '../../src/server/routes/a2a';

import { CARD_URL, LaneWorld, SESSION, agentCard } from './outbound_fixture';

const OTHER_URL = 'https://other.example/.well-known/agent-card.json';
const JKU = 'https://other.example/jwks.json';

/** Bidi controls, zero-width characters and the BOM: none may reach the owner or Brain. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u;

const secret = p256.utils.randomSecretKey();
const point = p256.getPublicKey(secret, false);
const jwk = {
  kty: 'EC',
  crv: 'P-256',
  kid: 'k1',
  use: 'sig',
  x: base64urlEncode(point.slice(1, 33)),
  y: base64urlEncode(point.slice(33)),
};

async function signed(card: JsonObject, jku: string): Promise<JsonObject> {
  const sig = await signAgentCard(card, { alg: 'ES256', kid: 'k1', jku }, (input) => p256.sign(input, secret, { lowS: false }));
  return { ...card, signatures: [sig as unknown as JsonObject] };
}

let world: LaneWorld;
const deps = () => ({ store: world.store, nowMs: () => world.clock });

beforeEach(() => {
  world = new LaneWorld();
});
afterEach(() => world.close());

async function register(url: string): Promise<string> {
  const out = await registerRemoteAgent(deps(), url);
  if (!out.ok) throw new Error(`register: ${out.reason}`);
  return out.agent.agent_id;
}

describe('the interface Dina pins (design §6.6)', () => {
  const iface = (url: string) => ({ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' });
  const BAD = [
    iface('https://203.0.113.7/rpc'),
    iface('https://[2001:db8::1]/rpc'),
    iface('https://user:pw@other.example/rpc'),
    iface('https://other.example/rpc#part'),
  ];

  // Plan B10
  it('never pins an endpoint at a literal IP, with credentials in its URL, or with a fragment', async () => {
    world.cards.set(OTHER_URL, agentCard({ supportedInterfaces: [...BAD, iface('https://other.example/rpc')] }));
    const out = await registerRemoteAgent(deps(), OTHER_URL);
    expect(out.ok && out.agent.endpoint).toBe('https://other.example/rpc');

    const only = 'https://bad.example/.well-known/agent-card.json';
    world.cards.set(only, agentCard({ supportedInterfaces: BAD }));
    expect(await registerRemoteAgent(deps(), only)).toEqual({ ok: false, reason: 'card_no_jsonrpc_1_0_interface' });
    expect(world.store.listAgents().map((a) => a.card_url)).toEqual([OTHER_URL]);
  });
});

describe('key sets come only through the outbound policy (design §6.6 "every connection")', () => {
  // Plan B20
  it.each([
    ['plain HTTP', 'http://other.example/jwks.json'],
    ['a literal IP', 'https://203.0.113.5/jwks.json'],
    ['credentials in the URL', 'https://u:p@other.example/jwks.json'],
  ])('never fetches a key set named over %s, and its signature verifies nothing', async (_name, jku) => {
    // Served, so a fetch that slipped past the policy would verify the card.
    world.cards.set(jku, { keys: [jwk] } as unknown as JsonObject);
    world.cards.set(OTHER_URL, await signed(agentCard(), jku));
    const out = await registerRemoteAgent(deps(), OTHER_URL);
    if (!out.ok) throw new Error(out.reason);
    expect(out.agent.signature_state).toBe('invalid');
    expect(world.requests.map((r) => r.url)).toEqual([OTHER_URL]);
  });

  it('fetches a key set the policy allows, so the refusals above are the policy at work', async () => {
    world.cards.set(JKU, { keys: [jwk] } as unknown as JsonObject);
    world.cards.set(OTHER_URL, await signed(agentCard(), JKU));
    const out = await registerRemoteAgent(deps(), OTHER_URL);
    expect(out.ok && out.agent.signature_state).toBe('verified');
    expect(world.requests.map((r) => r.url)).toEqual([OTHER_URL, JKU]);
  });
});

describe('Core cleans and bounds the card text the owner and Brain see (notes M1a)', () => {
  // Plan B24
  it('cleans and bounds the remote’s name and skill names on every surface: the agent, its skills, the consent card and Brain’s list', async () => {
    const longName = `Sum\u202Emarizer\u200B ${'N'.repeat(300)}`;
    const longSkill = `Summa\u2066rize\uFEFF ${'S'.repeat(300)}`;
    world.cards.set(
      OTHER_URL,
      agentCard({
        name: longName,
        skills: [{ id: 'summarize', name: longSkill, description: `Sum\u200Dup ${'D'.repeat(3000)}`, tags: ['t\u202Ax'] }],
      }),
    );
    const agentId = await register(OTHER_URL);
    const agent = world.store.getAgent(agentId);
    if (agent === null) throw new Error('agent');
    const credential = createNoneCredential(deps(), agentId);
    if (!credential.ok) throw new Error(credential.reason);
    expect(bindRemoteSkill(deps(), agentId, { skill: 'summarize', actionClass: 'read', credentialRef: credential.credential.credential_ref }).ok).toBe(true);
    expect(activateRemoteAgent(deps(), agentId)).toEqual({ ok: true });
    world.turn();
    const p = proposeDelegation(world.runtime, { agentId, skill: 'summarize', text: 'Summarize the note.', releaseSession: SESSION });
    if (!p.ok) throw new Error(p.reason);
    const card = parseDelegationConsentCard(world.repo.getById(p.approvalTaskId)?.payload ?? '');
    const brain = brainAgentsView(world.store).find((a) => a.agent_id === agentId) as
      | { name: string; skills: { name: string }[] }
      | undefined;
    const skill = pinnedRemoteSkills(agent)[0];

    const shown = [agent.name, skill?.name ?? '', card?.display.agent_name ?? '', card?.display.skill_name ?? '', brain?.name ?? '', brain?.skills[0]?.name ?? ''];
    for (const text of shown) {
      expect(text).not.toBe('');
      expect(text).not.toMatch(INVISIBLE);
      expect([...text].length).toBeLessThanOrEqual(120);
    }
    expect(agent.name.startsWith('Summarizer N')).toBe(true);
    expect(skill?.name.startsWith('Summarize S')).toBe(true);
    expect(skill?.description).not.toMatch(INVISIBLE);
    expect(skill?.tags).toEqual(['tx']);
  });

  // Cold audit C4-3: ids and the endpoint come from the card too
  it('offers no skill whose id hides or reorders text, and shows the endpoint as it is called', async () => {
    world.cards.set(
      OTHER_URL,
      agentCard({
        supportedInterfaces: [{ url: 'https://agent.example/r\u202Epc\u200B', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        skills: [
          { id: 'summarize', name: 'Summarize', description: 'Summarize a text.', tags: ['text'] },
          { id: 'sum\u202Emarize', name: 'Looks like summarize', description: 'x', tags: ['text'] },
          { id: 'ext\u200Bract', name: 'Extract', description: 'x', tags: ['text'] },
          { id: 'tab\tbed', name: 'Control', description: 'x', tags: ['text'] },
        ],
      }),
    );
    const agentId = await register(OTHER_URL);
    const agent = world.store.getAgent(agentId);
    if (agent === null) throw new Error('agent');
    expect(pinnedRemoteSkills(agent).map((s) => s.id)).toEqual(['summarize']);
    // Percent-encoded: what the owner reads is what Dina will call.
    expect(agent.endpoint).toBe('https://agent.example/r%E2%80%AEpc%E2%80%8B');
    const credential = createNoneCredential(deps(), agentId);
    if (!credential.ok) throw new Error(credential.reason);
    const ref = credential.credential.credential_ref;
    expect(bindRemoteSkill(deps(), agentId, { skill: 'sum\u202Emarize', actionClass: 'read', credentialRef: ref })).toEqual({
      ok: false,
      reason: 'skill_not_on_card',
    });
    expect(bindRemoteSkill(deps(), agentId, { skill: 'summarize', actionClass: 'read', credentialRef: ref }).ok).toBe(true);
  });
});

describe('a card that changes and changes back (design §5.5, interpretation recorded in the plan)', () => {
  // Plan B26
  it('stays uncallable after the card returns to its first form until the owner activates it again', async () => {
    const { agentId } = await world.activeAgent();
    const first = world.store.getAgent(agentId)?.card_hash;

    world.cards.set(CARD_URL, agentCard({ version: '2.0.0' }));
    expect((await reverifyRemoteAgent(deps(), agentId)).ok).toBe(true);
    expect(proposeDelegation(world.runtime, { agentId, skill: 'summarize', text: 'x', releaseSession: SESSION })).toEqual({ ok: false, reason: 'agent_changed' });

    world.cards.set(CARD_URL, agentCard());
    const back = await reverifyRemoteAgent(deps(), agentId);
    expect(back.ok && back.changed).toBe(true);
    expect(back.ok && back.agent).toMatchObject({ status: 'changed', card_hash: first });
    // Nothing the owner approved under the first card is callable on its own.
    expect(proposeDelegation(world.runtime, { agentId, skill: 'summarize', text: 'x', releaseSession: SESSION })).toEqual({ ok: false, reason: 'agent_changed' });

    // The owner looks again and activates: the bindings made on that pin serve again.
    expect(activateRemoteAgent(deps(), agentId)).toEqual({ ok: true });
    expect(proposeDelegation(world.runtime, { agentId, skill: 'summarize', text: 'x', releaseSession: SESSION }).ok).toBe(true);
  });
});

describe('a directory candidate (design §6.1, §8.4; A2A-I13)', () => {
  const CAP = 'owner-capability-for-tests';
  const NODE_DID = 'did:plc:abcdefghijklmnopqrstuvwx';
  const owner = (method: CoreRequest['method'], path: string, body: Record<string, unknown> = {}): CoreRequest => ({
    method,
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'owner',
    ownerCapability: CAP,
  });

  afterEach(() => installA2ADirectoryEvidence(null));

  // Plan B30, X-6 (the owner's review and "grants nothing"; the search_a2a_agents
  // tool that finds the candidate does not run here)
  it('registers from the live card when the owner hands Core a whole directory candidate, shows the host’s PeerLens evidence, and grants nothing until the owner binds and activates it', async () => {
    world.cards.set(
      OTHER_URL,
      agentCard({ name: 'Live card', capabilities: { extensions: [{ uri: DINA_A2A_EXTENSION_URI, params: { did: NODE_DID } }] } }),
    );
    // The directory as this trusted host reads it.
    // The candidate names another DID, whose directory card would vouch for this endpoint at 0.99:
    // the evidence must follow the live card's DID, never the candidate's word.
    const CANDIDATE_DID = 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz';
    installA2ADirectoryEvidence(async (did) =>
      did === NODE_DID
        ? { endpoint: 'https://agent.example/rpc', trustScore: 0.42, recommendation: 'caution', indexedAt: '2026-10-01T00:00:00.000Z', stale: false }
        : did === CANDIDATE_DID
          ? { endpoint: 'https://agent.example/rpc', trustScore: 0.99, recommendation: 'proceed', indexedAt: '2026-10-02T00:00:00.000Z', stale: false }
          : null,
    );
    const router = new CoreRouter();
    registerA2ARoutes(router, CAP);

    // A search_a2a_agents candidate as Brain shows it, with an endpoint hint beside it:
    // every field but card_url is the directory's word, never the pin.
    const candidate = {
      did: CANDIDATE_DID,
      card_url: OTHER_URL,
      name: 'Directory copy',
      endpoint: 'https://elsewhere.example/rpc',
      skills: ['eta_query'],
      trust_score: 0.99,
      recommendation: 'proceed',
      stale: false,
      indexed_at: '2026-09-01T00:00:00.000Z',
    };
    const reg = await router.handle(owner('POST', '/v1/owner/a2a/remote-agents', candidate));
    expect(reg.status).toBe(201);
    const view = reg.body as { agent_id: string; skills: { id: string }[] };
    expect(view).toMatchObject({ status: 'candidate', name: 'Live card', card_url: OTHER_URL, endpoint: 'https://agent.example/rpc' });
    expect(view.skills.map((s) => s.id)).toEqual(['summarize', 'extract']);
    expect(world.requests.map((r) => [r.method, r.url])).toEqual([['GET', OTHER_URL]]);
    const agentId = view.agent_id;

    // The review shows the directory's evidence as the host reads it, never the candidate's numbers.
    const evidence = await router.handle(owner('GET', `/v1/owner/a2a/remote-agents/${agentId}/evidence`));
    expect(evidence).toEqual({
      status: 200,
      body: { status: 'listed', did: NODE_DID, trust_score: 0.42, recommendation: 'caution', indexed_at: '2026-10-01T00:00:00.000Z', stale: false },
    });

    world.turn();
    const ask = () => proposeDelegation(world.runtime, { agentId, skill: 'summarize', text: 'Summarize this.', releaseSession: SESSION });
    expect(ask()).toEqual({ ok: false, reason: 'agent_candidate' });
    expect(brainAgentsView(world.store).map((a) => a.agent_id)).not.toContain(agentId);

    const credential = createNoneCredential(deps(), agentId);
    if (!credential.ok) throw new Error(credential.reason);
    expect(bindRemoteSkill(deps(), agentId, { skill: 'summarize', actionClass: 'read', credentialRef: credential.credential.credential_ref }).ok).toBe(true);
    expect(ask()).toEqual({ ok: false, reason: 'agent_candidate' });
    expect(activateRemoteAgent(deps(), agentId)).toEqual({ ok: true });
    expect(ask().ok).toBe(true);
  });
});

describe('an OAuth token endpoint must pass the outbound policy (design §5.3 "exchanges run under §6.6")', () => {
  const oauthCard = (tokenUrl: string) =>
    agentCard({
      securitySchemes: {
        oauth: { oauth2SecurityScheme: { flows: { clientCredentials: { tokenUrl, scopes: { run: 'Run' } } } } },
      },
      securityRequirements: [{ schemes: { oauth: { list: ['run'] } } }],
    });

  // Plan B36
  it.each([
    ['plain HTTP', 'http://other.example/token'],
    ['a literal IP', 'https://198.51.100.4/token'],
    ['credentials in the URL', 'https://u:p@other.example/token'],
    ['a fragment', 'https://other.example/token#x'],
  ])('refuses a credential whose token endpoint uses %s, stores nothing, and offers the owner no such choice', async (_name, tokenUrl) => {
    world.cards.set(OTHER_URL, oauthCard(tokenUrl));
    const agentId = await register(OTHER_URL);
    const made = createRemoteCredential(deps(), agentId, {
      kind: 'oauth2_client',
      scheme: 'oauth',
      secret: { client_id: 'client', client_secret: 'CLIENT-SECRET-1' },
      scopes: ['run'],
    });
    expect(made).toEqual({ ok: false, reason: 'token_url_refused' });
    expect(world.store.listCredentials(agentId)).toEqual([]);
    expect(cardSchemeChoices(world.store.getAgent(agentId)?.schemes_json ?? '')).toEqual([
      { name: 'oauth', label: 'oauth', kind: 'unsupported' },
    ]);
    expect(world.requests.map((r) => r.url)).toEqual([OTHER_URL]);
  });

  it('accepts a token endpoint the policy allows, so the refusals above are the policy at work', async () => {
    world.cards.set(OTHER_URL, oauthCard('https://other.example/token'));
    const agentId = await register(OTHER_URL);
    const made = createRemoteCredential(deps(), agentId, {
      kind: 'oauth2_client',
      scheme: 'oauth',
      secret: { client_id: 'client', client_secret: 'CLIENT-SECRET-1' },
      scopes: ['run'],
    });
    expect(made.ok).toBe(true);
    expect(cardSchemeChoices(world.store.getAgent(agentId)?.schemes_json ?? '')).toEqual([
      { name: 'oauth', label: 'oauth', kind: 'oauth2_client', token_host: 'other.example', scopes: ['run'] },
    ]);
  });
});
