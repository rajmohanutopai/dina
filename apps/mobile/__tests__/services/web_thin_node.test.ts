/**
 * Web thin-client boot — proves `bootWebThinNode` wraps a
 * `BrowserCoreProxyClient` in a `DinaNode`-shaped shell: real coreClient
 * (proxying to /api/v1), no-op lifecycle, NO degradations (so the old
 * limited-mode banner can't reappear), and inert Brain subsystems that
 * throw if a web path wrongly reaches them.
 */

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
