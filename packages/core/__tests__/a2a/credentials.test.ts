/**
 * A2A M1b real outbound credentials (design §5.3, §1.3): each matches a scheme
 * the pinned card declares; the material leaves through one door and is never
 * shown; rotation makes a new reference, moves the bindings and voids any
 * approval made under the old one; revocation deletes the material; OAuth
 * tokens come from the card's own token endpoint, form-posted, cached in
 * memory, fetched again when refused.
 */

import { parseStrictJson, type JsonObject } from '@dina/a2a';

import {
  activateRemoteAgent,
  beginOutboundDispatch,
  bindRemoteSkill,
  cardSchemeChoices,
  createNoneCredential,
  createRemoteCredential,
  forgetCachedToken,
  outboundOperationView,
  parseDelegationConsentCard,
  proposeDelegation,
  registerRemoteAgent,
  remoteAuthHeaders,
  reverifyRemoteAgent,
  revokeRemoteAgent,
  revokeRemoteCredential,
  rotateRemoteCredential,
  setA2AHostTransport,
  useRemoteCredentialSecret,
  type A2AHttpRequest,
} from '../../src/a2a';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerA2ARoutes } from '../../src/server/routes/a2a';

import { CARD_URL, LaneWorld, RUNNER_DID, SESSION, agentCard } from './outbound_fixture';

const SCHEMES = {
  key: { apiKeySecurityScheme: { location: 'header', name: 'X-Api-Key' } },
  query: { apiKeySecurityScheme: { location: 'query', name: 'k' } },
  hostHeader: { apiKeySecurityScheme: { location: 'header', name: 'Host' } },
  bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
  basic: { httpAuthSecurityScheme: { scheme: 'Basic' } },
  oauth: {
    oauth2SecurityScheme: {
      flows: {
        clientCredentials: {
          tokenUrl: 'https://auth.example/token',
          scopes: { 'tasks.read': 'Read tasks', 'tasks.write': 'Write tasks' },
        },
      },
    },
  },
};

const CAP = 'owner-capability-for-tests';
let world: LaneWorld;
let agentId: string;
let tokenRequests: A2AHttpRequest[];
let tokenAnswer: { status: number; body: unknown };

const deps = () => ({ store: world.store, nowMs: () => world.clock });

beforeEach(async () => {
  world = new LaneWorld();
  world.cards.set(CARD_URL, agentCard({ securitySchemes: SCHEMES, securityRequirements: [{ schemes: { key: { list: [] } } }] }));
  const reg = await registerRemoteAgent(deps(), CARD_URL);
  if (!reg.ok) throw new Error(reg.reason);
  agentId = reg.agent.agent_id;
  tokenRequests = [];
  tokenAnswer = { status: 200, body: { access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 } };
  const cardTransport = (world as unknown as { cards: Map<string, JsonObject> }).cards;
  setA2AHostTransport(async (request) => {
    if (request.url === 'https://auth.example/token') {
      tokenRequests.push(request);
      return { ok: true, status: tokenAnswer.status, body: JSON.stringify(tokenAnswer.body), connectedAddress: '203.0.114.5' };
    }
    const card = cardTransport.get(request.url);
    if (card === undefined) return { ok: false, error: 'dns_failed', sent: false };
    return { ok: true, status: 200, body: JSON.stringify(card), connectedAddress: '203.0.114.9' };
  });
});
afterEach(() => world.close());

describe('a credential matches a scheme the pinned card declares', () => {
  it('offers the card’s schemes to the owner, marking what Dina cannot provide', () => {
    const agent = world.store.getAgent(agentId);
    expect(cardSchemeChoices(agent?.schemes_json ?? '')).toEqual([
      { name: 'basic', label: 'basic', kind: 'unsupported' },
      { name: 'bearer', label: 'bearer', kind: 'bearer' },
      { name: 'hostHeader', label: 'hostHeader', kind: 'unsupported' },
      { name: 'key', label: 'key', kind: 'api_key', header: 'X-Api-Key' },
      { name: 'oauth', label: 'oauth', kind: 'oauth2_client', token_host: 'auth.example', scopes: ['tasks.read', 'tasks.write'] },
      { name: 'query', label: 'query', kind: 'unsupported' },
    ]);
  });

  it('shows the owner the card’s scheme names cleaned and bounded, keeping the raw key', () => {
    const raw = `pay\u202emoc.live${'x'.repeat(3000)}`;
    const [choice] = cardSchemeChoices(JSON.stringify({ securitySchemes: { [raw]: { httpAuthSecurityScheme: { scheme: 'Bearer' } } } }));
    expect(choice?.name).toBe(raw);
    expect([...(choice?.label ?? '')].length).toBeLessThanOrEqual(80);
    expect(choice?.label).not.toMatch(/\u202e/);
  });

  it.each([
    ['a scheme the card lacks', { kind: 'bearer', scheme: 'nope', secret: { token: 't' } }, 'scheme_not_on_card'],
    ['the wrong kind for the scheme', { kind: 'bearer', scheme: 'key', secret: { token: 't' } }, 'scheme_kind_mismatch'],
    ['a key outside a header', { kind: 'api_key', scheme: 'query', secret: { value: 'v' } }, 'api_key_not_in_header'],
    ['a header the transport owns', { kind: 'api_key', scheme: 'hostHeader', secret: { value: 'v' } }, 'api_key_header_refused'],
    ['HTTP Basic', { kind: 'bearer', scheme: 'basic', secret: { token: 't' } }, 'scheme_kind_mismatch'],
    ['a secret with a line break', { kind: 'api_key', scheme: 'key', secret: { value: 'a\r\nX-Evil: 1' } }, 'secret_invalid'],
    ['a secret with a space', { kind: 'bearer', scheme: 'bearer', secret: { token: 'a b' } }, 'secret_invalid'],
    ['an empty secret', { kind: 'bearer', scheme: 'bearer', secret: { token: '' } }, 'secret_invalid'],
    ['scopes the card does not offer', { kind: 'oauth2_client', scheme: 'oauth', secret: { client_id: 'c', client_secret: 's' }, scopes: ['admin'] }, 'scope_not_on_card'],
    ['no scope choice', { kind: 'oauth2_client', scheme: 'oauth', secret: { client_id: 'c', client_secret: 's' } }, 'scopes_required'],
    ['an unknown kind', { kind: 'password', scheme: 'key', secret: {} }, 'credential_kind_unsupported'],
  ])('refuses %s', (_name, input, reason) => {
    expect(createRemoteCredential(deps(), agentId, input)).toEqual({ ok: false, reason });
    expect(world.store.listCredentials(agentId)).toEqual([]);
  });

  it('refuses the “none” credential for a card that requires one', () => {
    expect(createNoneCredential(deps(), agentId)).toEqual({ ok: false, reason: 'credential_required_by_card' });
  });
});

describe('the material', () => {
  it('leaves through one door only: the views and lists never carry it', async () => {
    const out = createRemoteCredential(deps(), agentId, { kind: 'api_key', scheme: 'key', secret: { value: 'SECRET-KEY-123' } });
    if (!out.ok) throw new Error(out.reason);
    const router = new CoreRouter();
    registerA2ARoutes(router, CAP);
    const view = await router.handle({
      method: 'GET',
      path: `/v1/owner/a2a/remote-agents/${agentId}`,
      query: {},
      headers: {},
      body: undefined,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'owner',
      ownerCapability: CAP,
    } as CoreRequest);
    expect(JSON.stringify(view.body)).not.toContain('SECRET-KEY-123');
    expect(JSON.stringify(world.store.listCredentials(agentId))).not.toContain('SECRET-KEY-123');
    expect(useRemoteCredentialSecret(world.store, out.credential.credential_ref, (m) => m.value)).toBe('SECRET-KEY-123');
    expect(parseStrictJson(out.credential.scope_json)).toEqual({ ok: true, value: { kind: 'api_key', scheme: 'key', header: 'X-Api-Key' } });
  });

  it('builds headers per request: API key, bearer, none', async () => {
    const key = createRemoteCredential(deps(), agentId, { kind: 'api_key', scheme: 'key', secret: { value: 'k-1' } });
    const bearer = createRemoteCredential(deps(), agentId, { kind: 'bearer', scheme: 'bearer', secret: { token: 'b-1' } });
    if (!key.ok || !bearer.ok) throw new Error('create');
    expect(await remoteAuthHeaders(world.store, key.credential.credential_ref)).toEqual({ ok: true, headers: { 'X-Api-Key': 'k-1' } });
    expect(await remoteAuthHeaders(world.store, bearer.credential.credential_ref)).toEqual({ ok: true, headers: { Authorization: 'Bearer b-1' } });
  });

  it('revocation deletes the material', async () => {
    const out = createRemoteCredential(deps(), agentId, { kind: 'bearer', scheme: 'bearer', secret: { token: 'b-1' } });
    if (!out.ok) throw new Error(out.reason);
    expect(revokeRemoteCredential(deps(), out.credential.credential_ref)).toBe(true);
    expect(world.db.query('SELECT COUNT(*) AS n FROM a2a_credential_secrets')[0]).toEqual({ n: 0 });
    expect(await remoteAuthHeaders(world.store, out.credential.credential_ref)).toEqual({ ok: false, reason: 'credential_unusable' });
  });
});

describe('OAuth client credentials', () => {
  function oauth() {
    const out = createRemoteCredential(deps(), agentId, {
      kind: 'oauth2_client',
      scheme: 'oauth',
      secret: { client_id: 'dina client', client_secret: 's3cr3t:x' },
      scopes: ['tasks.read'],
    });
    if (!out.ok) throw new Error(out.reason);
    return out.credential.credential_ref;
  }

  it('form-posts the client-credentials grant to the card’s token endpoint, with RFC 6749 Basic auth', async () => {
    const ref = oauth();
    expect(await remoteAuthHeaders(world.store, ref, world.clock)).toEqual({ ok: true, headers: { Authorization: 'Bearer tok-1' } });
    const [request] = tokenRequests;
    expect(request).toMatchObject({ method: 'POST', url: 'https://auth.example/token', contentType: 'application/x-www-form-urlencoded' });
    expect(request?.body).toBe('grant_type=client_credentials&scope=tasks.read');
    const basic = Buffer.from(String(request?.headers.Authorization).replace('Basic ', ''), 'base64').toString('utf8');
    expect(basic).toBe('dina%20client:s3cr3t%3Ax');
  });

  it('caches the token until shortly before it expires, and drops it when the remote refuses it', async () => {
    const ref = oauth();
    await remoteAuthHeaders(world.store, ref, world.clock);
    await remoteAuthHeaders(world.store, ref, world.clock + 1000);
    expect(tokenRequests).toHaveLength(1);
    await remoteAuthHeaders(world.store, ref, world.clock + 3600_000);
    expect(tokenRequests).toHaveLength(2);
    forgetCachedToken(ref);
    await remoteAuthHeaders(world.store, ref, world.clock + 3600_000);
    expect(tokenRequests).toHaveLength(3);
  });

  it.each([
    ['a refusal', { status: 401, body: {} }],
    ['a token type other than bearer', { status: 200, body: { access_token: 't', token_type: 'mac' } }],
    ['no access token', { status: 200, body: { token_type: 'Bearer' } }],
    ['a token with a line break', { status: 200, body: { access_token: 'a\nb', token_type: 'Bearer' } }],
  ])('cannot use the credential after %s', async (_name, answer) => {
    tokenAnswer = answer;
    expect(await remoteAuthHeaders(world.store, oauth(), world.clock)).toEqual({ ok: false, reason: 'credential_unusable' });
  });
});

describe('rotation', () => {
  async function activeWithKey(value = 'k-1') {
    const out = createRemoteCredential(deps(), agentId, { kind: 'api_key', scheme: 'key', secret: { value } });
    if (!out.ok) throw new Error(out.reason);
    bindRemoteSkill(deps(), agentId, { skill: 'summarize', actionClass: 'read', credentialRef: out.credential.credential_ref });
    expect(activateRemoteAgent(deps(), agentId).ok).toBe(true);
    world.turn();
    return out.credential;
  }

  it('makes a new reference, moves the bindings, revokes the old one and deletes its material', async () => {
    const old = await activeWithKey();
    const before = world.store.listBindings(agentId, world.store.getAgent(agentId)?.card_hash ?? '')[0];
    const out = rotateRemoteCredential(deps(), old.credential_ref, { value: 'k-2' });
    if (!out.ok) throw new Error(out.reason);
    expect(out.credential.credential_ref).not.toBe(old.credential_ref);
    expect(out.credential.revision).toBeGreaterThan(old.revision);
    expect(out.credential.scope_json).toBe(old.scope_json);
    const after = world.store.listBindings(agentId, world.store.getAgent(agentId)?.card_hash ?? '')[0];
    expect(after?.credential_ref).toBe(out.credential.credential_ref);
    expect(after?.revision).toBe((before?.revision ?? 0) + 1);
    expect(world.store.getCredential(old.credential_ref)?.status).toBe('revoked');
    expect(useRemoteCredentialSecret(world.store, old.credential_ref, (m) => m)).toBeNull();
    expect(await remoteAuthHeaders(world.store, out.credential.credential_ref)).toEqual({ ok: true, headers: { 'X-Api-Key': 'k-2' } });
  });

  it('voids an approval made under the old reference (cross-credential reuse)', async () => {
    const old = await activeWithKey();
    const p = proposeDelegation(world.runtime, { agentId, skill: 'summarize', text: 'go', releaseSession: SESSION });
    if (!p.ok) throw new Error(p.reason);
    expect(parseDelegationConsentCard(world.repo.getById(p.approvalTaskId)?.payload ?? '')?.display.credential).toMatch(
      /An API key in the X-Api-Key header .*Whatever that credential allows/,
    );
    world.workflow.approve(p.approvalTaskId);
    rotateRemoteCredential(deps(), old.credential_ref, { value: 'k-2' });
    const task = world.claim(agentId);
    if (task === null) throw new Error('no claim');
    expect(beginOutboundDispatch(world.runtime, { childTaskId: task.id, claimId: task.claim_id as string, runnerDid: RUNNER_DID })).toMatchObject({
      kind: 'settled',
      state: 'stale_authority',
    });
  });

  it('refuses to rotate “none”, a revoked credential, or with a bad secret', async () => {
    const old = await activeWithKey();
    expect(rotateRemoteCredential(deps(), old.credential_ref, { value: 'two words' })).toEqual({ ok: false, reason: 'secret_invalid' });
    revokeRemoteCredential(deps(), old.credential_ref);
    expect(rotateRemoteCredential(deps(), old.credential_ref, { value: 'k-3' })).toEqual({ ok: false, reason: 'revoked' });
  });
});

describe('what removing an agent or changing its card does to its credentials', () => {
  it('removing the agent revokes every credential and deletes its material', () => {
    const a = createRemoteCredential(deps(), agentId, { kind: 'api_key', scheme: 'key', secret: { value: 'k-1' } });
    const b = createRemoteCredential(deps(), agentId, { kind: 'bearer', scheme: 'bearer', secret: { token: 'b-1' } });
    if (!a.ok || !b.ok) throw new Error('create');
    expect(revokeRemoteAgent(deps(), agentId)).toBe(true);
    expect(world.store.listCredentials(agentId).map((c) => c.status)).toEqual(['revoked', 'revoked']);
    expect(world.db.query('SELECT COUNT(*) AS n FROM a2a_credential_secrets')[0]).toEqual({ n: 0 });
  });

  it('refuses to bind a credential the current card no longer offers', async () => {
    const out = createRemoteCredential(deps(), agentId, { kind: 'api_key', scheme: 'key', secret: { value: 'k-1' } });
    if (!out.ok) throw new Error(out.reason);
    // The card changes: its key scheme now uses another header.
    world.cards.set(CARD_URL, agentCard({ securitySchemes: { key: { apiKeySecurityScheme: { location: 'header', name: 'X-Other' } } } }));
    await reverifyRemoteAgent(deps(), agentId);
    expect(bindRemoteSkill(deps(), agentId, { skill: 'summarize', actionClass: 'read', credentialRef: out.credential.credential_ref })).toEqual({
      ok: false,
      reason: 'credential_not_on_card',
    });
  });
});

// Cold audit C3-7: what can be created is what can be bound
describe('creating and binding read one set of schemes and scopes: the ones Dina offers from the card', () => {
  /**
   * 17 schemes: an OAuth one with 33 scopes (sc00…sc32), named to sort first, and 16 bearer ones
   * (s00…s15). Offered: the first 16 by name (a_oauth, s00…s14), and 32 scopes (sc00…sc31).
   */
  async function wideCard(): Promise<string> {
    const schemes: Record<string, JsonObject> = {};
    for (let i = 0; i < 16; i += 1) schemes[`s${String(i).padStart(2, '0')}`] = { httpAuthSecurityScheme: { scheme: 'Bearer' } };
    const scopes = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`sc${String(i).padStart(2, '0')}`, 'A scope']));
    schemes['a_oauth'] = { oauth2SecurityScheme: { flows: { clientCredentials: { tokenUrl: 'https://auth.example/token', scopes } } } };
    world.cards.set('https://wide.example/.well-known/agent-card.json', agentCard({ securitySchemes: schemes }));
    const reg = await registerRemoteAgent(deps(), 'https://wide.example/.well-known/agent-card.json');
    if (!reg.ok) throw new Error(reg.reason);
    return reg.agent.agent_id;
  }
  const oauth = (scopes: string[]) => ({ kind: 'oauth2_client', scheme: 'a_oauth', secret: { client_id: 'c', client_secret: 's' }, scopes });

  it('a scheme past the 16 offered is refused at creation, and stores nothing', async () => {
    const wide = await wideCard();
    const before = world.store.db.query('SELECT COUNT(*) AS n FROM a2a_remote_credentials');
    expect(createRemoteCredential(deps(), wide, { kind: 'bearer', scheme: 's15', secret: { token: 't' } })).toEqual({ ok: false, reason: 'scheme_not_on_card' });
    expect(world.store.db.query('SELECT COUNT(*) AS n FROM a2a_remote_credentials')).toEqual(before);
  });

  it('a scope past the 32 offered is refused at creation', async () => {
    const wide = await wideCard();
    expect(createRemoteCredential(deps(), wide, oauth(['sc32']))).toEqual({ ok: false, reason: 'scope_not_on_card' });
  });

  it('control: every scheme and scope creation accepts, a binding accepts too', async () => {
    const wide = await wideCard();
    const made = [
      createRemoteCredential(deps(), wide, { kind: 'bearer', scheme: 's14', secret: { token: 't' } }),
      createRemoteCredential(deps(), wide, oauth(['sc00', 'sc31'])),
    ];
    for (const out of made) {
      if (!out.ok) throw new Error(out.reason);
      expect(bindRemoteSkill(deps(), wide, { skill: 'summarize', actionClass: 'read', credentialRef: out.credential.credential_ref })).toEqual(
        expect.objectContaining({ ok: true }),
      );
    }
  });
});

// Cold audit C4-10: a `none` credential has no material to delete, so its status alone refuses it
it('builds no headers for a revoked `none` credential: it is unusable, not an empty set of headers', async () => {
  // An agent whose card asks for no credential: the one a `none` reference is made for.
  world.cards.set('https://open.example/.well-known/agent-card.json', agentCard());
  const open = await registerRemoteAgent(deps(), 'https://open.example/.well-known/agent-card.json');
  if (!open.ok) throw new Error(open.reason);
  const none = createNoneCredential(deps(), open.agent.agent_id);
  if (!none.ok) throw new Error(none.reason);
  expect(await remoteAuthHeaders(world.store, none.credential.credential_ref, world.clock)).toEqual({ ok: true, headers: {} });
  expect(revokeRemoteCredential(deps(), none.credential.credential_ref)).toBe(true);
  expect(await remoteAuthHeaders(world.store, none.credential.credential_ref, world.clock)).toEqual({ ok: false, reason: 'credential_unusable' });
});

describe('the material never travels with an operation', () => {
  it('is in no consent card, workflow event, operation row or view', async () => {
    const out = createRemoteCredential(deps(), agentId, { kind: 'api_key', scheme: 'key', secret: { value: 'SECRET-KEY-777' } });
    if (!out.ok) throw new Error(out.reason);
    bindRemoteSkill(deps(), agentId, { skill: 'summarize', actionClass: 'read', credentialRef: out.credential.credential_ref });
    activateRemoteAgent(deps(), agentId);
    world.turn();
    const p = proposeDelegation(world.runtime, { agentId, skill: 'summarize', text: 'go', releaseSession: SESSION });
    if (!p.ok) throw new Error(p.reason);
    world.workflow.approve(p.approvalTaskId);
    const task = world.claim(agentId);
    if (task === null) throw new Error('no claim');
    beginOutboundDispatch(world.runtime, { childTaskId: task.id, claimId: task.claim_id as string, runnerDid: RUNNER_DID });
    const op = world.store.getTaskByExternal('outbound', 'owner', p.operationId);
    const everything = JSON.stringify({
      card: world.repo.getById(p.approvalTaskId),
      child: world.repo.getById(task.id),
      events: [...world.repo.listEventsForTask(p.approvalTaskId), ...world.repo.listEventsForTask(task.id)],
      op,
      permits: world.store.permitsOf(op?.id ?? 0),
      view: outboundOperationView(world.runtime, p.operationId),
    });
    expect(everything).not.toContain('SECRET-KEY-777');
  });
});

describe('credentials against a changing card, and a revoke racing a token fetch', () => {
  it('a “none” reference no longer binds once the card requires a credential', async () => {
    world.cards.set(CARD_URL, agentCard());
    await reverifyRemoteAgent(deps(), agentId);
    const none = createNoneCredential(deps(), agentId);
    if (!none.ok) throw new Error(none.reason);
    world.cards.set(CARD_URL, agentCard({ securitySchemes: SCHEMES, securityRequirements: [{ schemes: { key: { list: [] } } }] }));
    await reverifyRemoteAgent(deps(), agentId);
    expect(bindRemoteSkill(deps(), agentId, { skill: 'summarize', actionClass: 'read', credentialRef: none.credential.credential_ref })).toEqual({
      ok: false,
      reason: 'credential_required_by_card',
    });
  });

  it('a token that arrives after its credential was revoked is neither cached nor used', async () => {
    const out = createRemoteCredential(deps(), agentId, {
      kind: 'oauth2_client',
      scheme: 'oauth',
      secret: { client_id: 'c', client_secret: 's' },
      scopes: ['tasks.read'],
    });
    if (!out.ok) throw new Error(out.reason);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = (await import('../../src/a2a')).getA2AHostTransport();
    setA2AHostTransport(async (request) => {
      if (request.url === 'https://auth.example/token') await gate;
      if (inner === null) throw new Error('no transport');
      return inner(request);
    });
    const pending = remoteAuthHeaders(world.store, out.credential.credential_ref, world.clock);
    revokeRemoteCredential(deps(), out.credential.credential_ref);
    release();
    expect(await pending).toEqual({ ok: false, reason: 'credential_unusable' });
    tokenRequests.length = 0;
    expect(await remoteAuthHeaders(world.store, out.credential.credential_ref, world.clock)).toEqual({ ok: false, reason: 'credential_unusable' });
  });

  it('removing an agent clears OAuth and rotated-away credentials alike', () => {
    const oauth = createRemoteCredential(deps(), agentId, {
      kind: 'oauth2_client',
      scheme: 'oauth',
      secret: { client_id: 'c', client_secret: 's' },
      scopes: ['tasks.read'],
    });
    const key = createRemoteCredential(deps(), agentId, { kind: 'api_key', scheme: 'key', secret: { value: 'k-1' } });
    if (!oauth.ok || !key.ok) throw new Error('create');
    const rotated = rotateRemoteCredential(deps(), key.credential.credential_ref, { value: 'k-2' });
    if (!rotated.ok) throw new Error(rotated.reason);
    revokeRemoteAgent(deps(), agentId);
    expect(world.store.listCredentials(agentId).every((c) => c.status === 'revoked')).toBe(true);
    expect(world.db.query('SELECT COUNT(*) AS n FROM a2a_credential_secrets')[0]).toEqual({ n: 0 });
    expect(world.store.liveSuccessor(key.credential.credential_ref)).toBeNull();
  });
});
