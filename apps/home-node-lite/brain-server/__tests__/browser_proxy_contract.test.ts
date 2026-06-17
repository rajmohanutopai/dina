/**
 * Browser↔brain WIRE CONTRACT — drives the real `BrowserCoreProxyClient`
 * (the web CoreClient) against the real Fastify `/api/v1/*` proxy routes,
 * backed by a MockCoreClient. The client's fetch is pointed at Fastify's
 * `inject`, so the FULL path is exercised: client builds URL/method/body
 * → route parses it → CoreClient receives the right call → client parses
 * the response.
 *
 * Why this exists (not just the two unit suites): the client and the
 * routes were written to the same spec independently. A drift in a path,
 * query-param name, or body shape would pass both unit suites yet break
 * at runtime. This is the cross-layer guard.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { BrowserCoreProxyClient } from '@dina/core';
// MockCoreClient lives in @dina/test-harness (NOT @dina/core).
import { MockCoreClient as HarnessMock } from '@dina/test-harness';

import { registerIdentityApiRoutes } from '../src/routes/identity';
import { registerVaultApiRoutes } from '../src/routes/vault';
import { registerPersonaApiRoutes } from '../src/routes/personas';
import { registerServiceConfigApiRoutes } from '../src/routes/service_config';
import { registerWorkflowApiRoutes } from '../src/routes/workflow';
import { registerPolicyApiRoutes } from '../src/routes/policy';

/** Adapt Fastify `inject` to a `fetch`-shaped function for the client. */
function injectFetch(app: FastifyInstance): typeof globalThis.fetch {
  return (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const u = new URL(url);
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: u.pathname + u.search,
      ...(init?.body !== undefined ? { payload: init.body } : {}),
      ...(init?.headers !== undefined ? { headers: init.headers } : {}),
    });
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      async json() {
        return res.json();
      },
      async text() {
        return res.body;
      },
    };
  }) as unknown as typeof globalThis.fetch;
}

function makeStack(): { app: FastifyInstance; core: HarnessMock; client: BrowserCoreProxyClient } {
  const core = new HarnessMock();
  const app = Fastify({ logger: false });
  registerIdentityApiRoutes(app, { core });
  registerVaultApiRoutes(app, { core });
  registerPersonaApiRoutes(app, { core });
  registerServiceConfigApiRoutes(app, { core });
  registerWorkflowApiRoutes(app, { core });
  registerPolicyApiRoutes(app, { core });
  const client = new BrowserCoreProxyClient({
    baseUrl: 'http://node.local/api/v1',
    fetch: injectFetch(app),
  });
  return { app, core, client };
}

describe('Browser↔brain wire contract (BrowserCoreProxyClient → /api/v1/* → CoreClient)', () => {
  it('identity round-trips end to end', async () => {
    const { app, core, client } = makeStack();
    core.identityResult = { did: 'did:plc:alonso', handle: 'alonso.test.example' };
    try {
      await expect(client.identity()).resolves.toEqual({
        did: 'did:plc:alonso',
        handle: 'alonso.test.example',
      });
    } finally {
      await app.close();
    }
  });

  it('vaultQuery: client persona+params reach CoreClient.vaultQuery unchanged', async () => {
    const { app, core, client } = makeStack();
    core.vaultQueryResult = { items: [{ id: 'i1' }], count: 1 } as never;
    try {
      const res = await client.vaultQuery('health', { text: 'bp', mode: 'hybrid', limit: 5 });
      expect(res.count).toBe(1);
      const call = core.calls.find((c) => c.method === 'vaultQuery');
      expect(call?.args[0]).toBe('health');
      expect(call?.args[1]).toMatchObject({ text: 'bp', mode: 'hybrid', limit: 5 });
    } finally {
      await app.close();
    }
  });

  it('vaultGet: 404 from the route maps back to null at the client', async () => {
    const { app, core, client } = makeStack();
    core.vaultGetResult = null;
    try {
      await expect(client.vaultGet('general', 'missing')).resolves.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('vaultStore / vaultList / vaultDelete / subjects all round-trip', async () => {
    const { app, core, client } = makeStack();
    core.vaultListResult = { items: [], count: 0, total: 3 } as never;
    core.vaultItemsForPersonResult = [{ id: 's1' }] as never;
    try {
      await expect(
        client.vaultStore('work', { type: 'note', content: { text: 'hi' } }),
      ).resolves.toMatchObject({ id: 'mock-item-id' });

      await expect(client.vaultList('general', { limit: 10, type: 'contact' })).resolves.toMatchObject(
        { total: 3 },
      );
      const listCall = core.calls.find((c) => c.method === 'vaultList');
      expect(listCall?.args[1]).toEqual({ limit: 10, type: 'contact' });

      await expect(client.vaultItemsForPerson('general', 'p1', 3)).resolves.toHaveLength(1);
      const subjCall = core.calls.find((c) => c.method === 'vaultItemsForPerson');
      expect(subjCall?.args).toEqual(['general', 'p1', 3]);

      await expect(client.vaultDelete('general', 'i1')).resolves.toEqual({ deleted: true });
    } finally {
      await app.close();
    }
  });

  it('personasList round-trips (switcher reads tier+isOpen from the list)', async () => {
    const { app, core, client } = makeStack();
    core.personasListResult = [
      { name: 'general', tier: 'default', isOpen: true },
      { name: 'health', tier: 'sensitive', isOpen: false },
    ] as never;
    try {
      const personas = await client.personasList();
      expect(personas).toHaveLength(2);
      expect(personas[1]).toMatchObject({ name: 'health', tier: 'sensitive', isOpen: false });
    } finally {
      await app.close();
    }
  });

  it('service-config put → serviceConfig → list round-trips (P2)', async () => {
    const { app, client } = makeStack();
    try {
      await client.putServiceConfig({ capabilities: [{ nsid: 'com.x.demo' }] } as never);
      await expect(client.serviceConfig()).resolves.toMatchObject({
        capabilities: [{ nsid: 'com.x.demo' }],
      });
      await expect(client.listServiceConfigs()).resolves.toHaveLength(1);

      await client.putServiceConfig({ capabilities: [] } as never, 'rk1');
      await expect(client.serviceConfig('rk1')).resolves.toMatchObject({ capabilities: [] });
      await client.deleteServiceConfig('rk1');
      await expect(client.serviceConfig('rk1')).resolves.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('workflow list → get → approve round-trips (P2)', async () => {
    const { app, core, client } = makeStack();
    core.workflowTasks.push({
      id: 't1',
      kind: 'service_query',
      status: 'pending_approval',
    } as never);
    try {
      await expect(
        client.listWorkflowTasks({ kind: 'service_query', state: 'pending_approval' }),
      ).resolves.toHaveLength(1);
      await expect(client.getWorkflowTask('t1')).resolves.toMatchObject({ id: 't1' });
      await expect(client.approveWorkflowTask('t1', { scope: 'single' })).resolves.toMatchObject({
        status: 'queued',
      });
    } finally {
      await app.close();
    }
  });

  it('action-policy get → set → delete round-trips (P3)', async () => {
    const { app, core, client } = makeStack();
    core.actionPolicyResult = { actions: [{ action: 'send_email', risk: 'safe' }] } as never;
    try {
      await expect(client.getActionPolicy()).resolves.toMatchObject({
        actions: [{ action: 'send_email' }],
      });
      await expect(client.setActionRisk('send_email', 'high' as never)).resolves.toMatchObject({
        action: 'send_email',
        risk: 'high',
      });
      await expect(client.deleteActionOverride('send_email')).resolves.toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('a CoreClient failure surfaces as a thrown error at the client (502 bridged)', async () => {
    const { app, core, client } = makeStack();
    core.throwOn.personasList = new Error('core unreachable');
    try {
      await expect(client.personasList()).rejects.toThrow(/502/);
    } finally {
      await app.close();
    }
  });
});
