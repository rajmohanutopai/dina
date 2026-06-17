/**
 * BrowserCoreProxyClient smoke — proves the WEB CoreClient maps each
 * wired method to the right same-origin `/api/v1/*` request (method, URL,
 * query, body) and parses the response, that un-migrated methods throw a
 * loud `notProxied`, and that it NEVER signs (no auth headers attached).
 */

import { BrowserCoreProxyClient } from '../../src/client/browser-core-proxy-client';

interface RecordedFetch {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
}

/** Stub fetch: records calls, returns canned status/body per a handler. */
function makeFetch(
  handler: (url: string) => { status?: number; body?: unknown; text?: string },
): { fetchFn: typeof globalThis.fetch; calls: RecordedFetch[] } {
  const calls: RecordedFetch[] = [];
  const fetchFn = (async (url: string, init?: RecordedFetch['init']) => {
    calls.push({ url, init });
    const r = handler(url);
    const status = r.status ?? 200;
    const text =
      r.text !== undefined ? r.text : r.body !== undefined ? JSON.stringify(r.body) : '';
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return JSON.parse(text === '' ? 'null' : text);
      },
      async text() {
        return text;
      },
    };
  }) as unknown as typeof globalThis.fetch;
  return { fetchFn, calls };
}

const BASE = 'http://test/api/v1';

describe('BrowserCoreProxyClient — wired methods', () => {
  it('identity GETs /identity and returns { did, handle }', async () => {
    const { fetchFn, calls } = makeFetch(() => ({
      body: { did: 'did:plc:alonso', handle: 'alonso.test.example' },
    }));
    const c = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: fetchFn });

    const id = await c.identity();

    expect(id).toEqual({ did: 'did:plc:alonso', handle: 'alonso.test.example' });
    expect(calls[0]?.url).toBe(`${BASE}/identity`);
    expect(calls[0]?.init?.method).toBe('GET');
    // Never signs: no auth headers, no body on a GET.
    expect(calls[0]?.init?.headers?.['x-signature']).toBeUndefined();
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('vaultQuery POSTs persona in the querystring + search params in the body', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ body: { items: [{ id: 'i1' }], count: 1 } }));
    const c = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: fetchFn });

    const res = await c.vaultQuery('health', { text: 'bp', mode: 'hybrid', limit: 5 });

    expect(res.count).toBe(1);
    expect(calls[0]?.url).toBe(`${BASE}/vault/query?persona=health`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body ?? '{}')).toEqual({ text: 'bp', mode: 'hybrid', limit: 5 });
  });

  it('vaultGet returns the item, and maps 404 → null', async () => {
    const found = makeFetch(() => ({ body: { id: 'i9', type: 'note' } }));
    const c1 = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: found.fetchFn });
    await expect(c1.vaultGet('general', 'i9')).resolves.toMatchObject({ id: 'i9' });
    expect(found.calls[0]?.url).toBe(`${BASE}/vault/item/i9?persona=general`);

    const missing = makeFetch(() => ({ status: 404, body: { error: 'item not found' } }));
    const c2 = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: missing.fetchFn });
    await expect(c2.vaultGet('general', 'nope')).resolves.toBeNull();
  });

  it('vaultStore POSTs the item with persona in the query', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ body: { id: 'new', storedAt: '2026-06-17' } }));
    const c = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: fetchFn });

    const r = await c.vaultStore('work', { type: 'note', content: { text: 'hi' } });

    expect(r.id).toBe('new');
    expect(calls[0]?.url).toBe(`${BASE}/vault/store?persona=work`);
    expect(JSON.parse(calls[0]?.init?.body ?? '{}')).toMatchObject({ type: 'note' });
  });

  it('vaultList serialises limit/offset/type into the querystring', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ body: { items: [], count: 0, total: 7 } }));
    const c = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: fetchFn });

    const r = await c.vaultList('general', { limit: 10, offset: 20, type: 'contact' });

    expect(r.total).toBe(7);
    expect(calls[0]?.url).toBe(`${BASE}/vault/list?persona=general&limit=10&offset=20&type=contact`);
  });

  it('vaultItemsForPerson returns items[] (and [] when absent)', async () => {
    const present = makeFetch(() => ({ body: { items: [{ id: 's1' }] } }));
    const c1 = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: present.fetchFn });
    await expect(c1.vaultItemsForPerson('general', 'p1', 3)).resolves.toHaveLength(1);
    expect(present.calls[0]?.url).toBe(`${BASE}/vault/subjects?persona=general&person_id=p1&limit=3`);

    const empty = makeFetch(() => ({ body: {} }));
    const c2 = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: empty.fetchFn });
    await expect(c2.vaultItemsForPerson('general', 'p1', 3)).resolves.toEqual([]);
  });

  it('vaultDelete DELETEs the path id with persona in query', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ body: { deleted: true } }));
    const c = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: fetchFn });

    await expect(c.vaultDelete('general', 'i1')).resolves.toEqual({ deleted: true });
    expect(calls[0]?.url).toBe(`${BASE}/vault/item/i1?persona=general`);
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('personasList unwraps { personas } → array (and [] when absent)', async () => {
    const present = makeFetch(() => ({
      body: { personas: [{ name: 'general', tier: 'default', isOpen: true }] },
    }));
    const c1 = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: present.fetchFn });
    await expect(c1.personasList()).resolves.toHaveLength(1);
    expect(present.calls[0]?.url).toBe(`${BASE}/personas`);

    const empty = makeFetch(() => ({ body: {} }));
    const c2 = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: empty.fetchFn });
    await expect(c2.personasList()).resolves.toEqual([]);
  });

});

describe('BrowserCoreProxyClient — error mapping + defaults', () => {
  it('throws on a non-2xx, surfacing status + error detail', async () => {
    const { fetchFn } = makeFetch(() => ({ status: 502, body: { error: 'core unreachable' } }));
    const c = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: fetchFn });

    await expect(c.personasList()).rejects.toThrow(/502 — core unreachable/);
  });

  it('defaults baseUrl to same-origin /api/v1 and strips a trailing slash', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ body: { did: null, handle: null } }));
    // Trailing slash on an explicit base must not double up.
    const c = new BrowserCoreProxyClient({ baseUrl: 'http://test/api/v1/', fetch: fetchFn });
    await c.identity();
    expect(calls[0]?.url).toBe('http://test/api/v1/identity');
  });
});

describe('BrowserCoreProxyClient — un-migrated methods', () => {
  it('throw a loud, greppable notProxied error (not a silent wrong answer)', async () => {
    const { fetchFn } = makeFetch(() => ({ body: {} }));
    const c = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: fetchFn });

    await expect(c.healthz()).rejects.toThrow(/healthz\(\) is not proxied/);
    await expect(c.personaStatus('general')).rejects.toThrow(/personaStatus\(\) is not proxied/);
    await expect(c.personaUnlock('financial', 'pw')).rejects.toThrow(/personaUnlock\(\) is not proxied/);
    await expect(c.reminderListByPersona('general')).rejects.toThrow(/not proxied/);
    await expect(c.createWorkflowTask({} as never)).rejects.toThrow(/not proxied/);
  });
});

describe('BrowserCoreProxyClient — service-config (P2)', () => {
  it('serviceConfig() GETs the self path; 404 → null', async () => {
    const ok = makeFetch(() => ({ body: { capabilities: [] } }));
    const c1 = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: ok.fetchFn });
    await expect(c1.serviceConfig()).resolves.toMatchObject({ capabilities: [] });
    expect(ok.calls[0]?.url).toBe(`${BASE}/service/config`);

    const missing = makeFetch(() => ({ status: 404, body: { error: 'no service config' } }));
    const c2 = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: missing.fetchFn });
    await expect(c2.serviceConfig()).resolves.toBeNull();
  });

  it('serviceConfig(rkey) GETs the per-listing path (rkey encoded)', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ body: { capabilities: [] } }));
    const c = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: fetchFn });
    await c.serviceConfig('my rkey');
    expect(calls[0]?.url).toBe(`${BASE}/service/config/my%20rkey`);
  });

  it('listServiceConfigs unwraps { listings } → array (and [] when absent)', async () => {
    const present = makeFetch(() => ({ body: { listings: [{ rkey: 'self' }] } }));
    const c1 = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: present.fetchFn });
    await expect(c1.listServiceConfigs()).resolves.toHaveLength(1);
    expect(present.calls[0]?.url).toBe(`${BASE}/service/configs`);

    const empty = makeFetch(() => ({ body: {} }));
    const c2 = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: empty.fetchFn });
    await expect(c2.listServiceConfigs()).resolves.toEqual([]);
  });

  it('putServiceConfig PUTs the body to self / per-listing paths', async () => {
    const self = makeFetch(() => ({ body: { ok: true } }));
    const c1 = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: self.fetchFn });
    await c1.putServiceConfig({ capabilities: [] } as never);
    expect(self.calls[0]?.url).toBe(`${BASE}/service/config`);
    expect(self.calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(self.calls[0]?.init?.body ?? '{}')).toMatchObject({ capabilities: [] });

    const perListing = makeFetch(() => ({ body: { ok: true } }));
    const c2 = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: perListing.fetchFn });
    await c2.putServiceConfig({ capabilities: [] } as never, 'rk1');
    expect(perListing.calls[0]?.url).toBe(`${BASE}/service/config/rk1`);
  });

  it('deleteServiceConfig DELETEs the per-listing path', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ body: { deleted: true } }));
    const c = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: fetchFn });
    await c.deleteServiceConfig('rk1');
    expect(calls[0]?.url).toBe(`${BASE}/service/config/rk1`);
    expect(calls[0]?.init?.method).toBe('DELETE');
  });
});

describe('BrowserCoreProxyClient — workflow / approvals (P2)', () => {
  it('listWorkflowTasks serialises kind+state+limit and unwraps { tasks }', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ body: { tasks: [{ id: 't1' }] } }));
    const c = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: fetchFn });
    await expect(
      c.listWorkflowTasks({ kind: 'service_query', state: 'pending_approval', limit: 10 }),
    ).resolves.toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${BASE}/workflow/tasks?kind=service_query&state=pending_approval&limit=10`,
    );
  });

  it('getWorkflowTask unwraps { task }; 404 → null', async () => {
    const ok = makeFetch(() => ({ body: { task: { id: 't1' } } }));
    const c1 = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: ok.fetchFn });
    await expect(c1.getWorkflowTask('t1')).resolves.toMatchObject({ id: 't1' });
    expect(ok.calls[0]?.url).toBe(`${BASE}/workflow/tasks/t1`);

    const miss = makeFetch(() => ({ status: 404, body: { error: 'task not found' } }));
    const c2 = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: miss.fetchFn });
    await expect(c2.getWorkflowTask('nope')).resolves.toBeNull();
  });

  it('approveWorkflowTask POSTs scope + unwraps { task }', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ body: { task: { id: 't1', status: 'queued' } } }));
    const c = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: fetchFn });
    const t = await c.approveWorkflowTask('t1', { scope: 'session' });
    expect(t).toMatchObject({ status: 'queued' });
    expect(calls[0]?.url).toBe(`${BASE}/workflow/tasks/t1/approve`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body ?? '{}')).toEqual({ scope: 'session' });
  });

  it('cancelWorkflowTask POSTs reason + unwraps { task }', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ body: { task: { id: 't1', status: 'cancelled' } } }));
    const c = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: fetchFn });
    const t = await c.cancelWorkflowTask('t1', 'nope');
    expect(t).toMatchObject({ status: 'cancelled' });
    expect(calls[0]?.url).toBe(`${BASE}/workflow/tasks/t1/cancel`);
    expect(JSON.parse(calls[0]?.init?.body ?? '{}')).toEqual({ reason: 'nope' });
  });
});

describe('BrowserCoreProxyClient — action-risk policy (P3)', () => {
  it('getActionPolicy GETs /policy/actions', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ body: { actions: [] } }));
    const c = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: fetchFn });
    await expect(c.getActionPolicy()).resolves.toMatchObject({ actions: [] });
    expect(calls[0]?.url).toBe(`${BASE}/policy/actions`);
  });

  it('setActionRisk PUTs { risk } to the per-action path', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ body: { action: 'send_email', risk: 'high' } }));
    const c = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: fetchFn });
    await expect(c.setActionRisk('send_email', 'high' as never)).resolves.toMatchObject({
      risk: 'high',
    });
    expect(calls[0]?.url).toBe(`${BASE}/policy/actions/send_email`);
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(calls[0]?.init?.body ?? '{}')).toEqual({ risk: 'high' });
  });

  it('deleteActionOverride DELETEs the per-action path', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ body: { deleted: true } }));
    const c = new BrowserCoreProxyClient({ baseUrl: BASE, fetch: fetchFn });
    await c.deleteActionOverride('send_email');
    expect(calls[0]?.url).toBe(`${BASE}/policy/actions/send_email`);
    expect(calls[0]?.init?.method).toBe('DELETE');
  });
});
