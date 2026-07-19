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
  });
  afterEach(() => {
    resetVaultRepositories();
    resetPersonaState();
    setWorkflowService(null);
    setAgentGrantRepository(null);
  });

  function queryReq(persona: string, callerType?: string): CoreRequest {
    return {
      method: 'POST',
      path: '/v1/vault/query',
      query: { persona },
      headers: {},
      body: { text: 'private health question', mode: 'fts5' },
      rawBody: new Uint8Array(),
      params: {},
      // trustedInProcess bypasses auth; we inject callerType to exercise
      // the handler's caller-type branch directly (in prod the auth layer
      // sets it). callerType undefined models the owner's in-process app.
      trustedInProcess: true,
      ...(callerType !== undefined ? { callerType, callerDID: 'did:key:agentX' } : {}),
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

  it('the gate also covers /v1/vault/list (not just query) — agent on sensitive → 403', async () => {
    const router = new CoreRouter();
    registerVaultRoutes(router);
    const resp = await router.handle({
      method: 'GET',
      path: '/v1/vault/list',
      query: { persona: 'health' },
      headers: {},
      body: undefined,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'agent',
      callerDID: 'did:key:agentX',
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
      callerDID: 'did:key:agentX',
    } as const;
    const store = await router.handle({
      ...base,
      method: 'POST',
      path: '/v1/vault/store',
      query: { persona: 'health' },
      body: { type: 'note', content: { text: 'x' } },
    });
    expect(store.status).toBe(403);
    expect((store.body as { approval_required?: boolean }).approval_required).toBe(true);

    const del = await router.handle({
      ...base,
      method: 'DELETE',
      path: '/v1/vault/item/some-id',
      query: { persona: 'health' },
      body: undefined,
      params: { id: 'some-id' },
    });
    expect(del.status).toBe(403);
  });
});
