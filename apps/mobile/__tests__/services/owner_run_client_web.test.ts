/**
 * Round-C C-03 — the Brain-served web SPA must NOT carry the owner capability.
 * A page served by Brain runs Brain's JS, so it can never safely hold the
 * reusable bearer. The web owner client therefore defaults to NONE (owner
 * control lives on Core's `/owner` console), and it purges any capability a
 * prior build left in Brain-origin sessionStorage.
 */

describe('owner_run_client.web (C-03)', () => {
  let store = new Map<string, string>();
  beforeEach(() => {
    store = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    };
    jest.resetModules();
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('getOwnerRunClient defaults to null — no Brain-origin fallback that prompts/sends the capability', async () => {
    const mod = await import('../../src/services/owner_run_client.web');
    expect(mod.getOwnerRunClient()).toBeNull();
  });

  it('purges a legacy capability left in Brain-origin sessionStorage on import', async () => {
    store.set('dina.owner_capability', 'leftover-bearer-from-old-build');
    await import('../../src/services/owner_run_client.web');
    expect(store.has('dina.owner_capability')).toBe(false);
  });

  it('a trusted edge may still install a client explicitly', async () => {
    const mod = await import('../../src/services/owner_run_client.web');
    const fake = { runList: async () => ({ runs: [] }) } as never;
    mod.setOwnerRunClient(fake);
    expect(mod.getOwnerRunClient()).toBe(fake);
    mod.setOwnerRunClient(null);
  });
});
