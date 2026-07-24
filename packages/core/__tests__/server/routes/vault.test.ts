/**
 * Vault route ⇄ CoreClient contract — drives the REAL router
 * (`registerVaultRoutes`) through `InProcessTransport`, so a path or
 * persona mismatch between the client and the registered routes fails
 * here (the per-transport tests use fake routers and can't catch that).
 */

import {
  InMemoryAgentGrantRepository,
  setAgentGrantRepository,
} from '../../../src/agent/grant_repository';
import { resetAuditState } from '../../../src/audit/service';
import { InProcessTransport } from '../../../src/client/in-process-transport';
import { createPersona, resetPersonaState } from '../../../src/persona/service';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerVaultRoutes } from '../../../src/server/routes/vault';
import { SessionRegistry, setSessionRegistry } from '../../../src/session/registry';
import {
  InMemoryVaultRepository,
  setVaultRepository,
  resetVaultRepositories,
} from '../../../src/vault/repository';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../../src/workflow/service';

function build(): InProcessTransport {
  const router = new CoreRouter();
  registerVaultRoutes(router);
  return new InProcessTransport(router);
}

describe('vault routes ⇄ CoreClient contract', () => {
  beforeEach(() => {
    resetVaultRepositories();
    setVaultRepository('general', new InMemoryVaultRepository());
    setVaultRepository('health', new InMemoryVaultRepository());
  });
  afterEach(() => resetVaultRepositories());

  it('vaultStore routes to the requested persona (not general)', async () => {
    const t = build();
    const { id } = await t.vaultStore('health', { type: 'note', content: { text: 'bp reading' } });
    expect(id).toBeTruthy();

    // It must be retrievable from `health`, and NOT from `general` — the
    // persona-in-body-vs-query bug would have landed it in general.
    expect(await t.vaultGet('health', id)).not.toBeNull();
    expect(await t.vaultGet('general', id)).toBeNull();
  });

  it('vaultList + vaultDelete hit registered routes (no 404)', async () => {
    const t = build();
    const { id } = await t.vaultStore('general', { type: 'note', content: { text: 'x' } });
    // The route is registered (a 404 would throw here).
    await expect(t.vaultList('general')).resolves.toBeDefined();

    const del = await t.vaultDelete('general', id);
    expect(del.deleted).toBe(true);
    expect(await t.vaultGet('general', id)).toBeNull();
  });

  it('vaultItemsForPerson returns subject-linked items for a persona', async () => {
    const repo = new InMemoryVaultRepository();
    setVaultRepository('general', repo);
    const t = build();
    const { id } = await t.vaultStore('general', { type: 'note', content: { text: 'loves eggs' } });
    repo.linkSubjectSync(id, 'person-q');
    const items = await t.vaultItemsForPerson('general', 'person-q', 5);
    expect(items.map((i) => i.id)).toEqual([id]);
  });

  it('vaultList honours the type filter the client sends', async () => {
    const t = build();
    await t.vaultStore('general', { type: 'note', content: { text: 'note one' } });
    await t.vaultStore('general', { type: 'email', content: { text: 'an email' } });
    await t.vaultStore('general', { type: 'note', content: { text: 'note two' } });

    // No filter → everything.
    expect((await t.vaultList('general')).count).toBe(3);

    // type='note' → only the two notes (the filter used to be a silent
    // no-op: the client advertised it, the server ignored it).
    const notes = await t.vaultList('general', { type: 'note' });
    expect(notes.count).toBe(2);
    expect((notes.items as { type: string }[]).every((i) => i.type === 'note')).toBe(true);

    const emails = await t.vaultList('general', { type: 'email' });
    expect(emails.count).toBe(1);
  });
});

// issues.txt §2 — the route-level agent persona-access gate. Drives the
// REAL router so the wiring (callerType discrimination → requireAgent-
// PersonaAccess → 403 approval_required, no vault read) is exercised.
describe('vault/query — agent persona-access gate', () => {
  const agentDID = 'did:key:agentX';
  let sessionId: string;

  beforeEach(() => {
    resetVaultRepositories();
    setVaultRepository('general', new InMemoryVaultRepository());
    setVaultRepository('health', new InMemoryVaultRepository());
    resetPersonaState();
    resetAuditState();
    createPersona('general', 'default');
    createPersona('health', 'sensitive');
    setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
    setAgentGrantRepository(new InMemoryAgentGrantRepository());
    const sessions = new SessionRegistry();
    sessionId = sessions.start({ agentDid: agentDID, hostSessionId: 'vault-test' }).sessionId;
    setSessionRegistry(sessions);
  });
  afterEach(() => {
    resetVaultRepositories();
    resetPersonaState();
    setWorkflowService(null);
    setAgentGrantRepository(null);
    setSessionRegistry(null);
  });

  function queryReq(
    persona: string,
    callerType?: string,
    session: string | null = sessionId,
  ): CoreRequest {
    return {
      method: 'POST',
      path: '/v1/vault/query',
      query: { persona },
      headers: {},
      body: {
        text: 'private health question',
        mode: 'fts5',
        ...(session !== null ? { session_id: session } : {}),
      },
      rawBody: new Uint8Array(),
      params: {},
      // trustedInProcess bypasses auth; we inject callerType to exercise
      // the handler's caller-type branch directly (in prod the auth layer
      // sets it). callerType undefined models the owner's in-process app.
      trustedInProcess: true,
      ...(callerType !== undefined ? { callerType, callerDID: agentDID } : {}),
    };
  }

  it('an AGENT querying a sensitive persona gets 403 approval_required — vault NOT read', async () => {
    const router = new CoreRouter();
    registerVaultRoutes(router);
    const resp = await router.handle(queryReq('health', 'agent'));
    expect(resp.status).toBe(403);
    expect((resp.body as { approval_required?: boolean }).approval_required).toBe(true);
    expect((resp.body as { task_id?: string }).task_id).toBeTruthy();
  });

  it('the OWNER (in-process, no callerType) reads the sensitive persona freely', async () => {
    const router = new CoreRouter();
    registerVaultRoutes(router);
    const resp = await router.handle(queryReq('health')); // no callerType → owner
    expect(resp.status).toBe(200);
  });

  it('an AGENT reads a free (default) persona without approval', async () => {
    const router = new CoreRouter();
    registerVaultRoutes(router);
    const resp = await router.handle(queryReq('general', 'agent'));
    expect(resp.status).toBe(200);
  });

  it('an AGENT must bind even a free-persona read to a live signed session', async () => {
    const router = new CoreRouter();
    registerVaultRoutes(router);
    const missing = await router.handle(queryReq('general', 'agent', null));
    expect(missing.status).toBe(401);
    expect((missing.body as { error?: string }).error).toBe('invalid_session');

    const headerOnly = queryReq('general', 'agent', null);
    headerOnly.headers['x-session'] = sessionId;
    const unsignedHeader = await router.handle(headerOnly);
    expect(unsignedHeader.status).toBe(401);
    expect((unsignedHeader.body as { error?: string }).error).toBe('invalid_session');
  });

  it('an ended or foreign session cannot reach the vault gate', async () => {
    const sessions = new SessionRegistry();
    const ended = sessions.start({ agentDid: agentDID, hostSessionId: 'ended' });
    sessions.end(ended.sessionId, agentDID);
    const foreign = sessions.start({ agentDid: 'did:key:other', hostSessionId: 'foreign' });
    setSessionRegistry(sessions);

    const router = new CoreRouter();
    registerVaultRoutes(router);
    for (const invalid of [ended.sessionId, foreign.sessionId]) {
      const response = await router.handle(queryReq('general', 'agent', invalid));
      expect(response.status).toBe(401);
      expect((response.body as { error?: string }).error).toBe('invalid_session');
    }
  });

  it('the gate also covers /v1/vault/list (not just query) — agent on sensitive → 403', async () => {
    const router = new CoreRouter();
    registerVaultRoutes(router);
    const resp = await router.handle({
      method: 'GET',
      path: '/v1/vault/list',
      query: { persona: 'health', session_id: sessionId },
      headers: {},
      body: undefined,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'agent',
      callerDID: agentDID,
    });
    expect(resp.status).toBe(403);
    expect((resp.body as { approval_required?: boolean }).approval_required).toBe(true);
  });

  it('an agent caller with no DID is denied (no stray empty-DID grant match)', async () => {
    const router = new CoreRouter();
    registerVaultRoutes(router);
    const resp = await router.handle({
      ...queryReq('health', 'agent'),
      callerDID: '', // authenticated agent but DID unset
    });
    expect(resp.status).toBe(403);
    expect((resp.body as { reason?: string }).reason).toMatch(/no DID/);
  });

  it('agent WRITES (store + delete) on a sensitive persona are gated too (write mode)', async () => {
    const router = new CoreRouter();
    registerVaultRoutes(router);
    const base = {
      headers: {},
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'agent',
      callerDID: agentDID,
    } as const;
    const store = await router.handle({
      ...base,
      method: 'POST',
      path: '/v1/vault/store',
      query: { persona: 'health' },
      body: { type: 'note', content: { text: 'x' }, session_id: sessionId },
    });
    expect(store.status).toBe(403);
    expect((store.body as { approval_required?: boolean }).approval_required).toBe(true);

    const del = await router.handle({
      ...base,
      method: 'DELETE',
      path: '/v1/vault/item/some-id',
      query: { persona: 'health', session_id: sessionId },
      body: undefined,
      params: { id: 'some-id' },
    });
    expect(del.status).toBe(403);
  });
});

// Item A (Codex review) — the vault route binds its storage origin to WHO is
// calling, so a compromised Brain (an untrusted `service` caller on the server
// split) cannot delete owner items or overwrite them, even on a FREE persona
// where the agent persona-access gate does not fire.
describe('vault routes — caller-bound origin (Brain ambient-authority fix)', () => {
  beforeEach(() => {
    resetVaultRepositories();
    setVaultRepository('general', new InMemoryVaultRepository());
    resetPersonaState();
    resetAuditState();
    createPersona('general', 'default');
    setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
    setAgentGrantRepository(new InMemoryAgentGrantRepository());
  });
  afterEach(() => {
    resetVaultRepositories();
    resetPersonaState();
    setWorkflowService(null);
    setAgentGrantRepository(null);
  });

  function router(): CoreRouter {
    const r = new CoreRouter();
    registerVaultRoutes(r);
    return r;
  }
  // On a real signed request the router stamps the FINE-GRAINED role, so Brain
  // arrives as callerType:'brain' (never the coarse 'service') — exercise that.
  const service = {
    headers: {},
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true, // bypass HTTP auth; the callerType is what we exercise
    callerType: 'brain',
    callerDID: 'did:key:brain',
  } as const;

  it('a BRAIN (service) caller may APPEND on a free persona (staging_item origin)', async () => {
    const resp = await router().handle({
      ...service,
      method: 'POST',
      path: '/v1/vault/store',
      query: { persona: 'general' },
      body: { type: 'note', summary: 'brain-ingested fact', body: 'b' },
    });
    expect(resp.status).toBe(201);
    expect((resp.body as { id?: string }).id).toBeTruthy();
  });

  it('a BRAIN (service) caller CANNOT DELETE — origin denied (403), owner items survive', async () => {
    // The owner stores an item in-process (owner_request).
    const r = router();
    const stored = await r.handle({
      headers: {},
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true, // no callerType → owner
      method: 'POST',
      path: '/v1/vault/store',
      query: { persona: 'general' },
      body: { type: 'note', summary: 'owner secret', body: 'keep me' },
    });
    const id = (stored.body as { id: string }).id;

    // Brain tries to delete it — refused at the origin seam.
    const del = await r.handle({
      ...service,
      method: 'DELETE',
      path: `/v1/vault/item/${id}`,
      query: { persona: 'general' },
      body: undefined,
      params: { id },
    });
    expect(del.status).toBe(403);
    expect((del.body as { reason?: string }).reason).toMatch(/may not delete/);

    // The item is still there (owner can still read it).
    const got = await r.handle({
      headers: {},
      rawBody: new Uint8Array(),
      params: { id },
      trustedInProcess: true,
      method: 'GET',
      path: `/v1/vault/item/${id}`,
      query: { persona: 'general' },
      body: undefined,
    });
    expect(got.status).toBe(200);
  });

  it('a BRAIN (service) caller CANNOT OVERWRITE an existing owner item by id (403)', async () => {
    const r = router();
    const stored = await r.handle({
      headers: {},
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true, // owner
      method: 'POST',
      path: '/v1/vault/store',
      query: { persona: 'general' },
      body: { type: 'note', summary: 'owner note', body: 'original' },
    });
    const id = (stored.body as { id: string }).id;

    // Brain re-stores with the SAME id but tampered content → append-only origin
    // refuses to overwrite.
    const overwrite = await r.handle({
      ...service,
      method: 'POST',
      path: '/v1/vault/store',
      query: { persona: 'general' },
      body: { id, type: 'note', summary: 'tampered', body: 'evil' },
    });
    expect(overwrite.status).toBe(403);
    expect((overwrite.body as { reason?: string }).reason).toMatch(/overwrite/);
  });

  it('a PLUGIN caller cannot write (read-only origin → 403)', async () => {
    const resp = await router().handle({
      headers: {},
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'plugin',
      callerDID: 'did:key:plugin',
      method: 'POST',
      path: '/v1/vault/store',
      query: { persona: 'general' },
      body: { type: 'note', summary: 'x' },
    });
    expect(resp.status).toBe(403);
    expect((resp.body as { reason?: string }).reason).toMatch(/may not write/);
  });

  it('a CONNECTOR (store-only) caller may APPEND but not DELETE', async () => {
    const conn = {
      headers: {},
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'connector',
      callerDID: 'did:key:connector',
    } as const;
    const r = router();
    const stored = await r.handle({
      ...conn,
      method: 'POST',
      path: '/v1/vault/store',
      query: { persona: 'general' },
      body: { type: 'note', summary: 'connector fact' },
    });
    expect(stored.status).toBe(201);
    const id = (stored.body as { id: string }).id;
    const del = await r.handle({
      ...conn,
      method: 'DELETE',
      path: `/v1/vault/item/${id}`,
      query: { persona: 'general' },
      body: undefined,
      params: { id },
    });
    expect(del.status).toBe(403);
    expect((del.body as { reason?: string }).reason).toMatch(/may not delete/);
  });

  it('an ADMIN (operator) caller retains owner authority (delete allowed)', async () => {
    const admin = {
      headers: {},
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'admin',
      callerDID: 'did:key:admin',
    } as const;
    const r = router();
    const stored = await r.handle({
      ...admin,
      method: 'POST',
      path: '/v1/vault/store',
      query: { persona: 'general' },
      body: { type: 'note', summary: 'op note' },
    });
    expect(stored.status).toBe(201);
    const id = (stored.body as { id: string }).id;
    const del = await r.handle({
      ...admin,
      method: 'DELETE',
      path: `/v1/vault/item/${id}`,
      query: { persona: 'general' },
      body: undefined,
      params: { id },
    });
    expect(del.status).toBe(200);
    expect((del.body as { deleted?: boolean }).deleted).toBe(true);
  });

  it('the OWNER (in-process) still deletes and overwrites freely', async () => {
    const owner = {
      headers: {},
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true, // no callerType → owner
    } as const;
    const r = router();
    const stored = await r.handle({
      ...owner,
      method: 'POST',
      path: '/v1/vault/store',
      query: { persona: 'general' },
      body: { type: 'note', summary: 'v1', body: 'a' },
    });
    const id = (stored.body as { id: string }).id;

    // Owner overwrite (same id) is allowed.
    const overwrite = await r.handle({
      ...owner,
      method: 'POST',
      path: '/v1/vault/store',
      query: { persona: 'general' },
      body: { id, type: 'note', summary: 'v2', body: 'b' },
    });
    expect(overwrite.status).toBe(201);

    // Owner delete is allowed.
    const del = await r.handle({
      ...owner,
      method: 'DELETE',
      path: `/v1/vault/item/${id}`,
      query: { persona: 'general' },
      body: undefined,
      params: { id },
    });
    expect(del.status).toBe(200);
    expect((del.body as { deleted?: boolean }).deleted).toBe(true);
  });
});
