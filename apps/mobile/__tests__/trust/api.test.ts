/**
 * Mobile trust API facade tests (TN-MOB-001).
 *
 * Covers the pub/sub semantics that screens depend on:
 *
 *   - subscribe → initial async load fires once with cached value
 *   - invalidate → drops cache + refetches + notifies all subscribers
 *   - unsubscribe is idempotent and prevents stale notifications
 *   - listener removed mid-flight (between subscribe and the async
 *     cache lookup resolving) is NOT called when the lookup completes
 *   - searchKey canonicalisation: identical queries with different
 *     property orders coalesce into one subscriber set
 *   - invalidateAll re-runs every active search AND trust-score
 *     subscription (this is the regression for the original
 *     "invalidateAll silently no-ops searches" smell)
 *
 * The underlying cache + network search machinery lives in
 * `@dina/core/trust/{cache,network_search}` and is independently
 * tested there. We only assert the bridging contract here.
 */

import { resetKVStore } from '../../../../packages/core/src/kv/store';
import {
  cacheTrustScore,
  registerTrustFetcher,
  resetTrustCache,
  type TrustScore,
} from '../../../../packages/core/src/trust/cache';
import {
  registerTrustQueryClient,
  resetTrustQueryClient,
  resetSearchCache,
} from '../../../../packages/core/src/trust/network_search';
import {
  TrustQueryClient,
  type TrustProfile,
} from '../../../../packages/core/src/trust/query_client';
import {
  subscribeTrust,
  subscribeTrustSearch,
  invalidateTrust,
  invalidateTrustSearch,
  invalidateAll,
  resetTrustApiSubscribers,
  _trustApiSubscriberCounts,
  type TrustSearchQuery,
  type TrustSearchResult,
} from '../../src/trust/api';

// ─── Test fixtures ────────────────────────────────────────────────────────

function score(did: string, value: number | null = 0.5): TrustScore {
  return { did, score: value, attestationCount: 3, lastUpdated: Date.now() };
}

function profile(did: string, score: number | null = 0.5): TrustProfile {
  return {
    did,
    overallTrustScore: score,
    attestationSummary: {
      total: 3,
      bySentiment: { positive: 2, neutral: 1, negative: 0 },
      byConfidence: { certain: 1, high: 1, moderate: 1, speculative: 0 },
    },
    activeDomains: [],
    flagCount: 0,
    lastActive: Date.now(),
  };
}

/**
 * Drain the microtask queue. Promises chained inside the API
 * (`.then(...)`) need at least one tick to deliver; some flows
 * touch async KV reads + the registered fetcher, so we tick a few.
 */
async function flushAsync(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

class FakeQueryClient extends TrustQueryClient {
  public profileCalls = 0;
  public searchCalls = 0;
  private profileHandler: (did: string) => TrustProfile | null;

  constructor(profileHandler: (did: string) => TrustProfile | null) {
    super({ baseURL: 'https://appview.test' });
    this.profileHandler = profileHandler;
  }

  override async queryProfile(did: string) {
    this.profileCalls += 1;
    const p = this.profileHandler(did);
    if (p) return { success: true as const, profile: p };
    return { success: false as const, error: 'not_found' as const };
  }

  override async searchAttestations() {
    this.searchCalls += 1;
    return { success: true as const, results: [], total: 0, cached: false };
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetTrustApiSubscribers();
  resetTrustCache();
  resetSearchCache();
  resetTrustQueryClient();
  resetKVStore();
});

// ─── Trust score subscriptions ────────────────────────────────────────────

describe('subscribeTrust', () => {
  it('rejects empty / non-string DID arguments', () => {
    expect(() => subscribeTrust('', () => undefined)).toThrow();
    // @ts-expect-error — runtime guard against caller bugs
    expect(() => subscribeTrust(undefined, () => undefined)).toThrow();
  });

  it('fires once with null on cache miss', async () => {
    const seen: (TrustScore | null)[] = [];
    subscribeTrust('did:plc:miss', (s) => seen.push(s));
    await flushAsync();
    expect(seen).toEqual([null]);
  });

  it('fires once with cached value when present', async () => {
    await cacheTrustScore(score('did:plc:hit', 0.42));
    const seen: (TrustScore | null)[] = [];
    subscribeTrust('did:plc:hit', (s) => seen.push(s));
    await flushAsync();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.score).toBe(0.42);
  });

  it('returns an idempotent unsubscribe that prevents later notifications', async () => {
    const seen: (TrustScore | null)[] = [];
    const unsub = subscribeTrust('did:plc:x', (s) => seen.push(s));
    await flushAsync();
    expect(seen).toHaveLength(1); // initial null

    unsub();
    unsub(); // idempotent — no throw
    expect(_trustApiSubscriberCounts().trustDids).toBe(0);

    // A subsequent invalidate should not call the listener.
    registerTrustFetcher(async () => score('did:plc:x', 0.9));
    await invalidateTrust('did:plc:x');
    expect(seen).toHaveLength(1);
  });

  it('skips the initial-load notification if the listener unsubscribed before the lookup resolved', async () => {
    const seen: (TrustScore | null)[] = [];
    const unsub = subscribeTrust('did:plc:race', (s) => seen.push(s));
    unsub(); // unsubscribe BEFORE the async cache read settles
    await flushAsync();
    expect(seen).toEqual([]);
  });

  it('notifies multiple listeners on the same DID on invalidate', async () => {
    const a: (TrustScore | null)[] = [];
    const b: (TrustScore | null)[] = [];
    subscribeTrust('did:plc:multi', (s) => a.push(s));
    subscribeTrust('did:plc:multi', (s) => b.push(s));
    await flushAsync();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    registerTrustFetcher(async () => score('did:plc:multi', 0.77));
    await invalidateTrust('did:plc:multi');
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(a[1]?.score).toBe(0.77);
    expect(b[1]?.score).toBe(0.77);
  });

  it('a listener that unsubscribes itself mid-iteration does not skip later listeners', async () => {
    const a: (TrustScore | null)[] = [];
    const b: (TrustScore | null)[] = [];
    let primed = false; // wait until after the initial-load fire
    let unsubA: (() => void) | null = null;
    unsubA = subscribeTrust('did:plc:walk', (s) => {
      a.push(s);
      if (primed) unsubA?.(); // remove self mid-walk on the invalidate fire
    });
    subscribeTrust('did:plc:walk', (s) => b.push(s));
    await flushAsync();
    primed = true;
    a.length = 0;
    b.length = 0;

    registerTrustFetcher(async () => score('did:plc:walk', 0.5));
    await invalidateTrust('did:plc:walk');
    expect(a).toHaveLength(1); // got the notification before removing itself
    expect(b).toHaveLength(1); // wasn't skipped by the mid-walk mutation
  });
});

describe('invalidateTrust', () => {
  it('drops the cache, refetches, and delivers fresh value to subscribers', async () => {
    await cacheTrustScore(score('did:plc:fresh', 0.1));
    const seen: (TrustScore | null)[] = [];
    subscribeTrust('did:plc:fresh', (s) => seen.push(s));
    await flushAsync();
    expect(seen[0]?.score).toBe(0.1);

    registerTrustFetcher(async () => score('did:plc:fresh', 0.9));
    await invalidateTrust('did:plc:fresh');
    expect(seen).toHaveLength(2);
    expect(seen[1]?.score).toBe(0.9);
  });

  it('delivers null when the registered fetcher fails', async () => {
    const seen: (TrustScore | null)[] = [];
    subscribeTrust('did:plc:fail', (s) => seen.push(s));
    await flushAsync();
    seen.length = 0;

    registerTrustFetcher(async () => {
      throw new Error('boom');
    });
    await invalidateTrust('did:plc:fail');
    expect(seen).toEqual([null]);
  });

  it('is a safe no-op when no subscribers exist', async () => {
    registerTrustFetcher(async () => score('did:plc:none', 0.5));
    await expect(invalidateTrust('did:plc:none')).resolves.toBeUndefined();
  });
});

// ─── Search subscriptions ─────────────────────────────────────────────────

describe('subscribeTrustSearch', () => {
  it('canonicalises queries — different property orders share one subscriber set', async () => {
    registerTrustQueryClient(new FakeQueryClient(() => null));

    const q1: TrustSearchQuery = { type: 'entity_reviews', query: 'acme', limit: 5 };
    const q2: TrustSearchQuery = { limit: 5, query: 'acme', type: 'entity_reviews' };

    const a: (TrustSearchResult | null)[] = [];
    const b: (TrustSearchResult | null)[] = [];
    subscribeTrustSearch(q1, (r) => a.push(r));
    subscribeTrustSearch(q2, (r) => b.push(r));
    await flushAsync();

    expect(_trustApiSubscriberCounts().searchKeys).toBe(1);
    expect(_trustApiSubscriberCounts().searchListeners).toBe(2);
  });

  it('different filter values produce distinct keys', async () => {
    registerTrustQueryClient(new FakeQueryClient(() => null));
    subscribeTrustSearch(
      { type: 'entity_reviews', query: 'acme', sentiment: 'positive' },
      () => undefined,
    );
    subscribeTrustSearch(
      { type: 'entity_reviews', query: 'acme', sentiment: 'negative' },
      () => undefined,
    );
    await flushAsync();
    expect(_trustApiSubscriberCounts().searchKeys).toBe(2);
  });

  it('initial fire delivers the search result to the listener', async () => {
    registerTrustQueryClient(new FakeQueryClient((d) => profile(d, 0.7)));

    const seen: (TrustSearchResult | null)[] = [];
    subscribeTrustSearch(
      { type: 'identity_attestations', query: 'did:plc:abc' },
      (r) => seen.push(r),
    );
    await flushAsync();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('identity_attestations');
  });

  it('returns idempotent unsubscribe', async () => {
    registerTrustQueryClient(new FakeQueryClient(() => null));
    const unsub = subscribeTrustSearch(
      { type: 'entity_reviews', query: 'acme' },
      () => undefined,
    );
    await flushAsync();
    expect(_trustApiSubscriberCounts().searchKeys).toBe(1);
    unsub();
    unsub();
    expect(_trustApiSubscriberCounts().searchKeys).toBe(0);
  });
});

describe('invalidateTrustSearch', () => {
  it('drops the underlying cache row, refetches, and notifies subscribers with the fresh result', async () => {
    let invocations = 0;
    registerTrustQueryClient(
      new FakeQueryClient((d) => {
        invocations += 1;
        return profile(d, invocations === 1 ? 0.3 : 0.9);
      }),
    );

    const seen: (TrustSearchResult | null)[] = [];
    const q: TrustSearchQuery = { type: 'identity_attestations', query: 'did:plc:zzz' };
    subscribeTrustSearch(q, (r) => seen.push(r));
    await flushAsync();
    expect(seen).toHaveLength(1);
    expect(invocations).toBe(1);

    // No `resetSearchCache()` here — the facade's `invalidateTrustSearch`
    // must drop the underlying cache row itself. If it doesn't, the
    // second `searchTrustNetwork` call replays the cached result and
    // `invocations` stays at 1.
    await invalidateTrustSearch(q);
    expect(invocations).toBe(2);
    expect(seen).toHaveLength(2);
  });
});

// ─── Bulk invalidate ──────────────────────────────────────────────────────

describe('invalidateAll', () => {
  it('re-runs both trust-score and search subscriptions', async () => {
    registerTrustFetcher(async (d) => score(d, 0.5));

    let searchHits = 0;
    registerTrustQueryClient(
      new FakeQueryClient((d) => {
        searchHits += 1;
        return profile(d, 0.6);
      }),
    );

    const trustSeen: (TrustScore | null)[] = [];
    const searchSeen: (TrustSearchResult | null)[] = [];
    subscribeTrust('did:plc:bulk1', (s) => trustSeen.push(s));
    subscribeTrust('did:plc:bulk2', (s) => trustSeen.push(s));
    subscribeTrustSearch(
      { type: 'identity_attestations', query: 'did:plc:bulk1' },
      (r) => searchSeen.push(r),
    );
    await flushAsync();

    const trustBefore = trustSeen.length;
    const searchBefore = searchSeen.length;
    const searchHitsBefore = searchHits;

    // No `resetSearchCache()` here — `invalidateAll` should bust the
    // underlying search cache via the per-query drop primitive.
    await invalidateAll();

    expect(trustSeen.length).toBeGreaterThan(trustBefore); // both DIDs notified
    expect(searchSeen.length).toBeGreaterThan(searchBefore); // search re-run + delivered
    expect(searchHits).toBeGreaterThan(searchHitsBefore); // network actually re-issued
  });

  it('is a safe no-op when there are no subscribers', async () => {
    await expect(invalidateAll()).resolves.toBeUndefined();
  });
});

// ─── Subscriber accounting ────────────────────────────────────────────────

describe('_trustApiSubscriberCounts', () => {
  it('drops the DID/key entry entirely when the last listener unsubscribes', async () => {
    registerTrustQueryClient(new FakeQueryClient(() => null));
    const u1 = subscribeTrust('did:plc:gc', () => undefined);
    const u2 = subscribeTrustSearch(
      { type: 'entity_reviews', query: 'gc' },
      () => undefined,
    );
    await flushAsync();
    expect(_trustApiSubscriberCounts()).toMatchObject({
      trustDids: 1,
      searchKeys: 1,
      trustListeners: 1,
      searchListeners: 1,
    });

    u1();
    u2();
    expect(_trustApiSubscriberCounts()).toMatchObject({
      trustDids: 0,
      searchKeys: 0,
      trustListeners: 0,
      searchListeners: 0,
    });
  });
});
