/**
 * Web thin-client boot — proves `bootWebThinNode` wraps a
 * `BrowserCoreProxyClient` in a `DinaNode`-shaped shell: real coreClient
 * (proxying to /api/v1), no-op lifecycle, NO degradations (so the old
 * limited-mode banner can't reappear), and inert Brain subsystems that
 * throw if a web path wrongly reaches them.
 */

import { BrowserCoreProxyClient } from '@dina/core';

import {
  listServiceListings,
  resetServiceConfigCoreClient,
  ServiceConfigNotConfiguredError,
} from '../../src/hooks/useServiceConfigForm';
import {
  listPendingApprovals,
  resetInboxCoreClient,
  InboxNotConfiguredError,
} from '../../src/hooks/useServiceInbox';
import { bootWebThinNode, makeWebThinNode } from '../../src/services/web_thin_node';

interface RecordedFetch {
  url: string;
  init: { method?: string; body?: string } | undefined;
}

/** Stub fetch: records calls, returns canned status/body per a handler. */
function makeFetch(handler: (url: string) => { status?: number; body?: unknown }): {
  fetchFn: typeof globalThis.fetch;
  calls: RecordedFetch[];
} {
  const calls: RecordedFetch[] = [];
  const fetchFn = (async (url: string, init?: RecordedFetch['init']) => {
    calls.push({ url, init });
    const r = handler(url);
    const status = r.status ?? 200;
    const text = r.body !== undefined ? JSON.stringify(r.body) : '';
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

describe('bootWebThinNode', () => {
  afterEach(() => {
    // The boot installs module-level singletons as a side effect; reset
    // them so a leaked client from one test can't mask another.
    resetInboxCoreClient();
    resetServiceConfigCoreClient();
  });

  it('discovers identity and returns a thin node with no degradations', async () => {
    const { fetchFn, calls } = makeFetch((url) =>
      url.endsWith('/identity')
        ? { body: { did: 'did:plc:alonso', handle: 'alonso.test.example' } }
        : { body: {} },
    );

    const { node, degradations } = await bootWebThinNode({ baseUrl: '/api/v1', fetch: fetchFn });

    expect(node.did).toBe('did:plc:alonso');
    expect(node.role).toBe('both');
    expect(degradations).toEqual([]); // no in-memory repos → no banner
    expect(calls[0]?.url).toBe('/api/v1/identity');
  });

  it('routes node.coreClient calls through the same same-origin proxy', async () => {
    const { fetchFn, calls } = makeFetch((url) =>
      url.includes('/identity')
        ? { body: { did: 'did:plc:alonso', handle: null } }
        : { body: { items: [{ id: 'i1' }], count: 1 } },
    );

    const { node } = await bootWebThinNode({ baseUrl: '/api/v1', fetch: fetchFn });
    const res = await node.coreClient.vaultQuery('general', { text: 'hi' });

    expect(res.count).toBe(1);
    expect(calls.some((c) => c.url === '/api/v1/vault/query?persona=general')).toBe(true);
  });

  it('throws when the node has no identity (null DID → "No Home Node")', async () => {
    const { fetchFn } = makeFetch(() => ({ body: { did: null, handle: null } }));
    await expect(bootWebThinNode({ baseUrl: '/api/v1', fetch: fetchFn })).rejects.toThrow(
      /no identity/,
    );
  });

  it('propagates a network failure (server down → caller shows No Home Node)', async () => {
    const fetchFn = (async () => {
      throw new Error('Failed to fetch');
    }) as unknown as typeof globalThis.fetch;
    await expect(bootWebThinNode({ baseUrl: '/api/v1', fetch: fetchFn })).rejects.toThrow(
      /Failed to fetch/,
    );
  });

  it('honours a role override', async () => {
    const { fetchFn } = makeFetch(() => ({ body: { did: 'did:plc:x', handle: null } }));
    const { node } = await bootWebThinNode({ fetch: fetchFn, role: 'requester' });
    expect(node.role).toBe('requester');
  });

  // P1 regression: the SPA reads the approval inbox + service listings through
  // module-level CoreClient singletons. Native installs them in
  // `bootstrap.installChatGlobals`; the web boot composes no node, so it must
  // wire them itself. Without this, My Services + the approval inbox hit their
  // not-configured error state even though the proxy routes exist.
  it('wires the inbox + service-config singletons through the proxy, and dispose clears them', async () => {
    resetInboxCoreClient();
    resetServiceConfigCoreClient();
    const { fetchFn, calls } = makeFetch((url) =>
      url.includes('/identity') ? { body: { did: 'did:plc:x', handle: null } } : { body: {} },
    );

    const { node } = await bootWebThinNode({ baseUrl: '/api/v1', fetch: fetchFn });

    // The inbox now routes through the proxy (no InboxNotConfiguredError) —
    // proves the singleton was wired to the same-origin client.
    await expect(listPendingApprovals()).resolves.toEqual([]);
    expect(calls.some((c) => c.url.includes('/api/v1/workflow/tasks'))).toBe(true);
    // Same for the service-listing layer.
    await expect(listServiceListings()).resolves.toEqual([]);
    expect(calls.some((c) => c.url.includes('/api/v1/service/configs'))).toBe(true);

    // Teardown clears the singletons → reads fail closed again.
    await node.dispose();
    await expect(listPendingApprovals()).rejects.toBeInstanceOf(InboxNotConfiguredError);
    await expect(listServiceListings()).rejects.toBeInstanceOf(ServiceConfigNotConfiguredError);
  });

  // DoD #5: "the web bundle no longer instantiates createCoreRouter() or the
  // in-memory repos (asserted in test)." We can't assert a negative call
  // directly, but `coreClient` being a BrowserCoreProxyClient (NOT an
  // InProcessTransport, which is the ONLY thing createCoreRouter feeds) plus an
  // empty degradation list is conclusive: the in-process node was never built.
  it('DoD #5 — runs NO in-process core (coreClient is the same-origin proxy, no degradations)', async () => {
    const { fetchFn } = makeFetch(() => ({ body: { did: 'did:plc:x', handle: null } }));
    const { node, degradations } = await bootWebThinNode({ fetch: fetchFn });
    expect(node.coreClient).toBeInstanceOf(BrowserCoreProxyClient);
    expect(degradations).toEqual([]);
    // Specifically: the "persistence.in_memory" degradation (the limited-mode
    // banner's cause) is impossible because no in-memory repo was composed.
    expect(JSON.stringify(degradations)).not.toContain('persistence.in_memory');
  });
});

describe('makeWebThinNode — shell shape', () => {
  const stubClient = { vaultQuery: async () => ({ items: [], count: 0 }) } as never;

  it('lifecycle methods are no-ops that resolve', async () => {
    const node = makeWebThinNode({ did: 'did:plc:x', role: 'both', coreClient: stubClient });
    await expect(node.start()).resolves.toBeUndefined();
    await expect(node.stop()).resolves.toBeUndefined();
    await expect(node.drainOnce()).resolves.toBeUndefined();
    await expect(node.dispose()).resolves.toBeUndefined();
  });

  it('runners.stagingDrain + localRunner are null (nothing polls in-browser)', () => {
    const node = makeWebThinNode({ did: 'did:plc:x', role: 'both', coreClient: stubClient });
    expect(node.runners.stagingDrain).toBeNull();
    expect(node.runners.localRunner).toBeNull();
  });

  it('Brain subsystems throw if a web path wrongly invokes them', () => {
    const node = makeWebThinNode({ did: 'did:plc:x', role: 'both', coreClient: stubClient });
    expect(() => node.orchestrator.issueQueryToDID({} as never)).toThrow(
      /not available in the web thin-client/,
    );
    expect(() => node.workflowService.createTask({} as never)).toThrow(/web thin-client/);
  });
});
