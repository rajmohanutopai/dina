/**
 * WEB_OWNER_SURFACE_PLAN §3.6 — the browser's owner dispatcher.
 *
 *   - Not connected: every owner request answers
 *     `401 owner_device_not_connected` and nothing leaves the page.
 *   - Connected: the request goes to Core's own origin, signed by the owner
 *     device, and verifies with the same canonical payload Core checks.
 *   - Boot's in-process dispatcher (the tab's limited node) is not installed.
 *   - A device Core no longer knows (revoked elsewhere) is forgotten and read
 *     as not connected, once the owner-setup status confirms it; any other
 *     refusal is passed through and costs the owner nothing.
 *   - Nothing touches sessionStorage: the kept /owner console on the same
 *     origin keeps its session.
 */

import { getPublicKey, sign, verifyRequest, type RequestSigner } from '@dina/core';

let mockSigner: RequestSigner | null = null;
const mockForget = jest.fn(async () => undefined);
jest.mock('../../src/services/owner_device', () => ({
  loadOwnerSigner: async () => mockSigner,
  forgetOwnerDeviceCoreDropped: (did: string) => mockForget(did),
}));

const seed = new Uint8Array(32).fill(9);
const pub = getPublicKey(seed);

describe('owner_dispatcher.web', () => {
  let store: Map<string, string>;
  let calls: { url: string; init: RequestInit }[];
  /** Core's answer per path; the default is a 200. */
  let answers: Record<string, { status: number; body: unknown }>;

  beforeEach(() => {
    store = new Map([['dina.owner_capability', 'the /owner console session']]);
    (globalThis as { window?: unknown }).window = {
      sessionStorage: { removeItem: (k: string) => void store.delete(k) },
    };
    calls = [];
    answers = {};
    globalThis.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const path = String(url).split('?')[0] ?? '';
      const a = answers[path] ?? { status: 200, body: { runs: [] } };
      return new Response(JSON.stringify(a.body), { status: a.status });
    }) as typeof fetch;
    mockSigner = null;
    mockForget.mockClear();
    jest.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('leaves sessionStorage alone (the /owner console shares the origin)', async () => {
    await import('../../src/services/owner_dispatcher.web');
    expect(store.get('dina.owner_capability')).toBe('the /owner console session');
  });

  it('a device Core no longer knows is forgotten and reads as not connected', async () => {
    mockSigner = { did: 'did:key:z6MkRevoked', sign: async (m) => sign(seed, m) };
    const unknown = {
      status: 403,
      body: { error: 'Cannot determine authorization role', rejected_at: 'authorization' },
    };
    answers['/v1/workflow/tasks/t1/approve'] = unknown;
    answers['/v1/owner/setup/status'] = unknown;
    const mod = await import('../../src/services/owner_dispatcher.web');
    const res = await mod
      .getOwnerDispatcher()
      .dispatch({ method: 'POST', path: '/v1/workflow/tasks/t1/approve', body: {} });
    expect(res).toEqual({ status: 401, body: { error: 'owner_device_not_connected' } });
    expect(mockForget).toHaveBeenCalledWith('did:key:z6MkRevoked');
    expect(calls.map((c) => c.url)).toEqual([
      '/v1/workflow/tasks/t1/approve',
      '/v1/owner/setup/status',
    ]);
  });

  it('a refusal of one path while Core still knows the device is passed through', async () => {
    mockSigner = { did: 'did:key:z6MkLive', sign: async (m) => sign(seed, m) };
    const refused = { status: 403, body: { error: 'forbidden', rejected_at: 'authorization' } };
    answers['/v1/some/other/path'] = refused;
    const mod = await import('../../src/services/owner_dispatcher.web');
    const res = await mod
      .getOwnerDispatcher()
      .dispatch({ method: 'GET', path: '/v1/some/other/path' });
    expect(res).toEqual(refused);
    expect(mockForget).not.toHaveBeenCalled();
  });

  it.each(['timestamp', 'nonce', 'rate_limit'])(
    'a %s refusal says nothing about the device: no probe, nothing forgotten',
    async (at) => {
      mockSigner = { did: 'did:key:z6MkLive', sign: async (m) => sign(seed, m) };
      answers['/v1/run/list'] = { status: 401, body: { error: 'x', rejected_at: at } };
      const mod = await import('../../src/services/owner_dispatcher.web');
      const res = await mod.getOwnerDispatcher().dispatch({ method: 'GET', path: '/v1/run/list' });
      expect(res.status).toBe(401);
      expect(calls).toHaveLength(1);
      expect(mockForget).not.toHaveBeenCalled();
    },
  );

  it('not connected: answers owner_device_not_connected without a request', async () => {
    const mod = await import('../../src/services/owner_dispatcher.web');
    const res = await mod.getOwnerDispatcher().dispatch({ method: 'GET', path: '/v1/run/list' });
    expect(res).toEqual({ status: 401, body: { error: 'owner_device_not_connected' } });
    expect(calls).toEqual([]);
  });

  it('connected: a signed same-origin request that Core verifies', async () => {
    mockSigner = { did: 'did:key:z6MkTest', sign: async (m) => sign(seed, m) };
    const mod = await import('../../src/services/owner_dispatcher.web');
    const res = await mod.getOwnerDispatcher().dispatch({
      method: 'POST',
      path: '/v1/commerce/trade/tender/award',
      query: { note: 'a b/ç' },
      body: { tender_id: 'tnd_1' },
    });
    expect(res.status).toBe(200);
    const [{ url, init }] = calls;
    expect(url).toBe('/v1/commerce/trade/tender/award?note=a%20b%2F%C3%A7');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-DID']).toBe('did:key:z6MkTest');
    expect(init.credentials).toBe('omit');
    const body = new TextEncoder().encode(String(init.body));
    expect(
      verifyRequest(
        'POST',
        '/v1/commerce/trade/tender/award',
        'note=a%20b%2F%C3%A7',
        headers['X-Timestamp'],
        headers['X-Nonce'],
        body,
        headers['X-Signature'],
        pub,
      ),
    ).toBe(true);
  });

  it('does not install boot’s in-process dispatcher', async () => {
    const mod = await import('../../src/services/owner_dispatcher.web');
    const before = mod.getOwnerDispatcher();
    mod.setOwnerDispatcher({ dispatch: async () => ({ status: 200, body: 'tab node' }) });
    expect(mod.getOwnerDispatcher()).toBe(before);
  });
});
