/**
 * Mobile catalog source — bundled fallback + live-wins resolution + picker
 * selectors (SERVICE_CAPABILITY_CATALOG_DESIGN.md §2 / §9.1 / §36).
 */

import {
  BUNDLED_CATALOG,
  CATALOG_XRPC_PATH,
  capabilitiesInCategory,
  defaultDiscoverabilityForCapabilities,
  fetchLiveCatalog,
  findCapability,
  loadCatalog,
  resolveCatalog,
  sortedCategories,
  type CatalogData,
  type CatalogFetch,
} from '../../src/services/catalog_source';

/** Mock CatalogFetch: configurable ok/status/json or a thrown network error. */
function mockFetch(opts: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  jsonThrows?: boolean;
  networkError?: boolean;
}): { fetch: CatalogFetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: CatalogFetch = async (url) => {
    calls.push(url);
    if (opts.networkError) throw new Error('network down');
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => {
        if (opts.jsonThrows) throw new Error('bad json');
        return opts.body ?? {};
      },
    };
  };
  return { fetch, calls };
}

const LIVE_BODY = {
  catalog_version: '2026-07-01',
  categories: [{ id: 'live_cat' }],
  // Policy-complete (intent_routable + requires_subject_authorization) — a
  // live catalog missing these is treated as a stale snapshot and degraded.
  capabilities: [
    { id: 'live_cap', intent_routable: true, requires_subject_authorization: false },
  ],
};

describe('resolveCatalog — live wins, else bundled (spec §2)', () => {
  it('uses the bundled fallback when nothing is fetched', () => {
    expect(resolveCatalog(null).source).toBe('bundled');
    expect(resolveCatalog(undefined).source).toBe('bundled');
    expect(resolveCatalog(null).capabilities).toBe(BUNDLED_CATALOG.capabilities);
  });

  it('degrades to bundled on an empty/malformed live response (never empty)', () => {
    expect(resolveCatalog({ categories: [], capabilities: [] }).source).toBe('bundled');
    expect(resolveCatalog({ categories: [{ id: 'x' }], capabilities: [] }).source).toBe('bundled');
    expect(resolveCatalog({ capabilities: 'nope' } as never).source).toBe('bundled');
  });

  it('uses the live catalog when it is valid + non-empty + policy-complete', () => {
    const live = resolveCatalog({
      categories: [{ id: 'live_cat' }],
      capabilities: [
        { id: 'live_cap', intent_routable: true, requires_subject_authorization: false },
      ],
    });
    expect(live.source).toBe('live');
    expect(live.categories).toHaveLength(1);
    expect(live.capabilities).toHaveLength(1);
  });

  it('degrades a STALE live catalog (missing routing-policy fields) to bundled — taxonomy §3', () => {
    // A pre-2026-06-09 AppView snapshot lacks intent_routable /
    // requires_subject_authorization and still carries old defaults (school →
    // unlisted). "Live wins" must not silently revert the shipped safety
    // defaults or feed `undefined` into policy reads.
    const stale = resolveCatalog({
      categories: [{ id: 'school' }],
      capabilities: [
        {
          id: 'school_homework_status',
          default_discoverability: 'unlisted', // the old, reverted default
        },
      ],
    });
    expect(stale.source).toBe('bundled');
    // And via the bundled catalog the school cap still seeds known_only.
    expect(defaultDiscoverabilityForCapabilities(['school_homework_status'], stale)).toBe(
      'known_only',
    );
  });

  it('degrades when only SOME capabilities are policy-complete (all-or-nothing)', () => {
    const partial = resolveCatalog({
      categories: [{ id: 'c' }],
      capabilities: [
        { id: 'ok_cap', intent_routable: true, requires_subject_authorization: false },
        { id: 'stale_cap' },
      ],
    });
    expect(partial.source).toBe('bundled');
  });
});

describe('picker selectors over the bundled catalog', () => {
  const catalog = BUNDLED_CATALOG;

  it('sortedCategories orders by sort_order + drops hidden', () => {
    const cats = sortedCategories(catalog);
    expect(cats.length).toBeGreaterThan(0);
    const orders = cats.map((c) => c.sort_order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(cats.every((c) => c.lifecycle !== 'hidden')).toBe(true);
  });

  it('capabilitiesInCategory is cross-category aware (spec §9.1)', () => {
    // appointment_availability is in appointments/healthcare/professional/home_local.
    const inHealthcare = capabilitiesInCategory(catalog, 'healthcare').map((c) => c.id);
    const inAppointments = capabilitiesInCategory(catalog, 'appointments').map((c) => c.id);
    expect(inHealthcare).toContain('appointment_availability');
    expect(inAppointments).toContain('appointment_availability');
    // transit's eta_query is NOT in healthcare.
    expect(inHealthcare).not.toContain('eta_query');
  });

  it('findCapability resolves canonical ids', () => {
    expect(findCapability(catalog, 'eta_query')?.display_name).toBe('ETA / arrival time');
    expect(findCapability(catalog, 'not_a_cap')).toBeNull();
  });

  it('developer/ops capabilities default to known_only even though official (spec §19)', () => {
    const devCaps = capabilitiesInCategory(catalog, 'developer_ops');
    expect(devCaps.length).toBeGreaterThan(0);
    expect(devCaps.every((c) => c.default_discoverability === 'known_only')).toBe(true);
  });
});

describe('defaultDiscoverabilityForCapabilities — safest catalog default (spec mobile #12/#13)', () => {
  const catalog = BUNDLED_CATALOG;

  it('empty selection → public baseline', () => {
    expect(defaultDiscoverabilityForCapabilities([], catalog)).toBe('public');
  });

  it('a public official capability stays public', () => {
    expect(defaultDiscoverabilityForCapabilities(['eta_query'], catalog)).toBe('public');
  });

  it('a developer/ops capability defaults to known_only (#12)', () => {
    expect(defaultDiscoverabilityForCapabilities(['deploy_status'], catalog)).toBe('known_only');
  });

  it('an unlisted-default capability defaults to unlisted', () => {
    expect(defaultDiscoverabilityForCapabilities(['appointment_status'], catalog)).toBe('unlisted');
  });

  it('school_homework_status seeds known_only (taxonomy §3 target default — subject-scoped child data)', () => {
    expect(defaultDiscoverabilityForCapabilities(['school_homework_status'], catalog)).toBe(
      'known_only',
    );
  });

  it('a custom (unknown-to-catalog) capability defaults to unlisted (#13)', () => {
    expect(defaultDiscoverabilityForCapabilities(['com.acme.widget_price'], catalog)).toBe('unlisted');
  });

  it('the MOST restrictive default wins across a mixed selection', () => {
    // public + known_only → known_only
    expect(defaultDiscoverabilityForCapabilities(['eta_query', 'deploy_status'], catalog)).toBe('known_only');
    // public + unlisted → unlisted
    expect(defaultDiscoverabilityForCapabilities(['eta_query', 'appointment_status'], catalog)).toBe('unlisted');
    // public + known_only (school, post-taxonomy flip) → known_only
    expect(defaultDiscoverabilityForCapabilities(['eta_query', 'school_homework_status'], catalog)).toBe('known_only');
    // public official + custom → unlisted (custom contributes unlisted)
    expect(defaultDiscoverabilityForCapabilities(['eta_query', 'com.acme.thing'], catalog)).toBe('unlisted');
  });
});

describe('BUNDLED_CATALOG shape', () => {
  it('is a non-empty bundled catalog', () => {
    const c: CatalogData = BUNDLED_CATALOG;
    expect(c.source).toBe('bundled');
    expect(c.categories.length).toBeGreaterThan(0);
    expect(c.capabilities.length).toBeGreaterThan(0);
  });
});

describe('fetchLiveCatalog — fail-soft (spec §2)', () => {
  it('returns null on an empty AppView URL (no fetch attempted)', async () => {
    const m = mockFetch({ body: LIVE_BODY });
    expect(await fetchLiveCatalog('', m.fetch)).toBeNull();
    expect(await fetchLiveCatalog('   ', m.fetch)).toBeNull();
    expect(m.calls).toHaveLength(0);
  });

  it('returns the payload on 2xx + builds the right URL (trailing slash stripped)', async () => {
    const m = mockFetch({ body: LIVE_BODY });
    const got = await fetchLiveCatalog('https://appview.example.com/', m.fetch);
    expect(got).toEqual(LIVE_BODY);
    expect(m.calls[0]).toBe(`https://appview.example.com${CATALOG_XRPC_PATH}`);
  });

  it('returns null on non-2xx, network error, and bad JSON', async () => {
    expect(await fetchLiveCatalog('https://a', mockFetch({ ok: false, status: 503 }).fetch)).toBeNull();
    expect(await fetchLiveCatalog('https://a', mockFetch({ networkError: true }).fetch)).toBeNull();
    expect(await fetchLiveCatalog('https://a', mockFetch({ jsonThrows: true }).fetch)).toBeNull();
  });
});

describe('loadCatalog — live when valid, else bundled (never empty, never rejects)', () => {
  it('returns the live catalog on a valid response', async () => {
    const c = await loadCatalog('https://a', mockFetch({ body: LIVE_BODY }).fetch);
    expect(c.source).toBe('live');
    expect(c.capabilities).toHaveLength(1);
  });

  it('returns bundled on failure (non-2xx / network / empty URL)', async () => {
    expect((await loadCatalog('https://a', mockFetch({ ok: false }).fetch)).source).toBe('bundled');
    expect((await loadCatalog('https://a', mockFetch({ networkError: true }).fetch)).source).toBe('bundled');
    expect((await loadCatalog('', mockFetch({ body: LIVE_BODY }).fetch)).source).toBe('bundled');
  });

  it('returns bundled on a structurally-empty live response', async () => {
    const c = await loadCatalog('https://a', mockFetch({ body: { categories: [], capabilities: [] } }).fetch);
    expect(c.source).toBe('bundled');
  });
});
