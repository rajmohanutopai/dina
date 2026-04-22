/**
 * Tests for AppViewServiceResolver.
 *
 * Source parity: core/internal/adapter/appview/service_resolver.go +
 *                core/test/appview/service_resolver_test.go (implicit — there
 *                is no standalone Go test file, but the `IsDiscoverableService`
 *                contract is exercised by d2d/send tests).
 */

import { AppViewServiceResolver } from '../../src/appview/service_resolver';

type FetchFn = typeof globalThis.fetch;

function makeFetch(responses: (Response | Error | (() => Response | Error))[]): {
  fetchFn: FetchFn;
  calls: { url: string }[];
} {
  const calls: { url: string }[] = [];
  let i = 0;
  const fetchFn: FetchFn = async (input) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString();
    calls.push({ url });
    const entry = responses[i];
    i = Math.min(i + 1, responses.length - 1);
    const resolved = typeof entry === 'function' ? entry() : entry;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  };
  return { fetchFn, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AppViewServiceResolver', () => {
  const APPVIEW = 'https://appview.test';
  const DID = 'did:plc:busdriver';

  const noSleep = () => Promise.resolve();

  describe('construction', () => {
    it('requires appViewURL', () => {
      expect(() => new AppViewServiceResolver({ appViewURL: '' })).toThrow(/appViewURL/);
    });

    it('rejects negative / non-integer maxRetries', () => {
      expect(() => new AppViewServiceResolver({ appViewURL: APPVIEW, maxRetries: -1 })).toThrow(
        /maxRetries/,
      );
      expect(() => new AppViewServiceResolver({ appViewURL: APPVIEW, maxRetries: 1.5 })).toThrow(
        /maxRetries/,
      );
    });

    it('strips trailing slash from appViewURL', async () => {
      const { fetchFn, calls } = makeFetch([
        jsonResponse(200, { isDiscoverable: true, capabilities: ['eta_query'] }),
      ]);
      const r = new AppViewServiceResolver({
        appViewURL: 'https://appview.test/',
        fetch: fetchFn,
      });
      await r.isDiscoverableService(DID, 'eta_query');
      expect(calls[0].url.startsWith('https://appview.test/xrpc/')).toBe(true);
      expect(calls[0].url.startsWith('https://appview.test//xrpc/')).toBe(false);
    });

    it('rejects non-positive cacheTtlMs', () => {
      expect(() => new AppViewServiceResolver({ appViewURL: APPVIEW, cacheTtlMs: 0 })).toThrow(
        /cacheTtlMs/,
      );
    });

    it('rejects non-positive timeoutMs', () => {
      expect(() => new AppViewServiceResolver({ appViewURL: APPVIEW, timeoutMs: 0 })).toThrow(
        /timeoutMs/,
      );
    });
  });

  describe('isDiscoverableService', () => {
    it('returns true for matching capability', async () => {
      const { fetchFn } = makeFetch([
        jsonResponse(200, { isDiscoverable: true, capabilities: ['eta_query', 'route_info'] }),
      ]);
      const r = new AppViewServiceResolver({ appViewURL: APPVIEW, fetch: fetchFn });

      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(true);
      expect(await r.isDiscoverableService(DID, 'route_info')).toBe(true);
    });

    it('returns false when DID is not public', async () => {
      const { fetchFn } = makeFetch([
        jsonResponse(200, { isDiscoverable: false, capabilities: ['eta_query'] }),
      ]);
      const r = new AppViewServiceResolver({ appViewURL: APPVIEW, fetch: fetchFn });

      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(false);
    });

    it('returns false when capability not advertised', async () => {
      const { fetchFn } = makeFetch([
        jsonResponse(200, { isDiscoverable: true, capabilities: ['eta_query'] }),
      ]);
      const r = new AppViewServiceResolver({ appViewURL: APPVIEW, fetch: fetchFn });

      expect(await r.isDiscoverableService(DID, 'route_info')).toBe(false);
    });

    it('returns false on empty DID or capability without network call', async () => {
      const { fetchFn, calls } = makeFetch([]);
      const r = new AppViewServiceResolver({ appViewURL: APPVIEW, fetch: fetchFn });

      expect(await r.isDiscoverableService('', 'eta_query')).toBe(false);
      expect(await r.isDiscoverableService(DID, '')).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it('URL-encodes the DID (prevents injection)', async () => {
      const { fetchFn, calls } = makeFetch([
        jsonResponse(200, { isDiscoverable: true, capabilities: ['eta_query'] }),
      ]);
      const r = new AppViewServiceResolver({ appViewURL: APPVIEW, fetch: fetchFn });

      await r.isDiscoverableService('did:web:ex/ample?x=1', 'eta_query');
      // Percent-encoded slash, question mark, equals.
      expect(calls[0].url).toContain('did=did%3Aweb%3Aex%2Fample%3Fx%3D1');
    });
  });

  describe('fail-closed', () => {
    it('returns false on persistent network error', async () => {
      const { fetchFn } = makeFetch([
        new Error('ECONNREFUSED'),
        new Error('ECONNREFUSED'),
        new Error('ECONNREFUSED'),
      ]);
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
      });
      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(false);
    });

    it('returns false on persistent 5xx', async () => {
      const { fetchFn } = makeFetch([
        jsonResponse(500, {}),
        jsonResponse(500, {}),
        jsonResponse(500, {}),
      ]);
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
      });
      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(false);
    });

    it('returns false on 404 (terminal — no retry)', async () => {
      const { fetchFn, calls } = makeFetch([jsonResponse(404, {})]);
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
      });
      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(false);
      expect(calls).toHaveLength(1);
    });

    it('returns false on malformed body (terminal — no retry)', async () => {
      let hits = 0;
      const fetchFn: FetchFn = async () => {
        hits += 1;
        return new Response('not-json', { status: 200 });
      };
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
      });
      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(false);
      expect(hits).toBe(1);
    });

    it('does NOT cache failures (retries on next call)', async () => {
      const { fetchFn, calls } = makeFetch([
        jsonResponse(500, {}),
        jsonResponse(500, {}),
        jsonResponse(500, {}),
        jsonResponse(200, { isDiscoverable: true, capabilities: ['eta_query'] }),
      ]);
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
      });

      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(false);
      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(true);
      // 3 attempts for the failed call (retries exhausted) + 1 for the success.
      expect(calls).toHaveLength(4);
    });

    it('tolerates non-boolean/non-array top-level fields (terminal — no retry)', async () => {
      const { fetchFn, calls } = makeFetch([
        jsonResponse(200, { isDiscoverable: 'yes', capabilities: 'eta_query' }),
      ]);
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
      });

      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(false);
      expect(calls).toHaveLength(1);
    });
  });

  describe('retry on transient failures', () => {
    it('retries on 5xx and returns the first success', async () => {
      const attemptsSlept: number[] = [];
      const { fetchFn, calls } = makeFetch([
        jsonResponse(503, {}),
        jsonResponse(502, {}),
        jsonResponse(200, { isDiscoverable: true, capabilities: ['eta_query'] }),
      ]);
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: async (attempt) => {
          attemptsSlept.push(attempt);
        },
        maxRetries: 3,
      });
      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(true);
      expect(calls).toHaveLength(3);
      expect(attemptsSlept).toEqual([0, 1]); // slept between attempts
    });

    it('retries on 408 and 429', async () => {
      const { fetchFn, calls } = makeFetch([
        jsonResponse(408, {}),
        jsonResponse(429, {}),
        jsonResponse(200, { isDiscoverable: true, capabilities: ['eta_query'] }),
      ]);
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
        maxRetries: 3,
      });
      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(true);
      expect(calls).toHaveLength(3);
    });

    it('retries on network error then succeeds', async () => {
      const { fetchFn, calls } = makeFetch([
        new Error('ECONNRESET'),
        jsonResponse(200, { isDiscoverable: true, capabilities: ['eta_query'] }),
      ]);
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
      });
      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(true);
      expect(calls).toHaveLength(2);
    });

    it('does NOT retry on 4xx other than 408/429', async () => {
      const { fetchFn, calls } = makeFetch([jsonResponse(400, {})]);
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
        maxRetries: 5,
      });
      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(false);
      expect(calls).toHaveLength(1);
    });

    it('does NOT retry on 401/403', async () => {
      const { fetchFn, calls } = makeFetch([jsonResponse(401, {})]);
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
        maxRetries: 5,
      });
      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(false);
      expect(calls).toHaveLength(1);
    });

    it('maxRetries=0 disables retries entirely', async () => {
      const { fetchFn, calls } = makeFetch([jsonResponse(503, {})]);
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
        maxRetries: 0,
      });
      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(false);
      expect(calls).toHaveLength(1);
    });

    it('caches ONLY after the first successful attempt, not the retries', async () => {
      const { fetchFn, calls } = makeFetch([
        jsonResponse(503, {}),
        jsonResponse(503, {}),
        jsonResponse(200, { isDiscoverable: true, capabilities: ['eta_query'] }),
      ]);
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
        maxRetries: 3,
      });
      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(true);
      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(true);
      expect(calls).toHaveLength(3); // second call hit the cache, no new fetch
    });
  });

  describe('caching', () => {
    it('second call within TTL hits cache (no extra fetch)', async () => {
      const { fetchFn, calls } = makeFetch([
        jsonResponse(200, { isDiscoverable: true, capabilities: ['eta_query'] }),
      ]);
      const r = new AppViewServiceResolver({ appViewURL: APPVIEW, fetch: fetchFn });

      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(true);
      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(true);
      expect(calls).toHaveLength(1);
    });

    it('refetches after cacheTtlMs', async () => {
      let now = 1_700_000_000_000;
      const { fetchFn, calls } = makeFetch([
        jsonResponse(200, { isDiscoverable: true, capabilities: ['eta_query'] }),
        jsonResponse(200, { isDiscoverable: true, capabilities: ['eta_query'] }),
      ]);
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        nowFn: () => now,
        cacheTtlMs: 1_000,
      });

      await r.isDiscoverableService(DID, 'eta_query');
      now += 1_001;
      await r.isDiscoverableService(DID, 'eta_query');
      expect(calls).toHaveLength(2);
    });

    it('invalidate() forces a refetch', async () => {
      const { fetchFn, calls } = makeFetch([
        jsonResponse(200, { isDiscoverable: true, capabilities: ['eta_query'] }),
        jsonResponse(200, { isDiscoverable: false, capabilities: [] }),
      ]);
      const r = new AppViewServiceResolver({ appViewURL: APPVIEW, fetch: fetchFn });

      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(true);
      r.invalidate(DID);
      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(false);
      expect(calls).toHaveLength(2);
    });

    it('evicts oldest entries when exceeding maxCacheEntries', async () => {
      const calls: string[] = [];
      const fetchFn: FetchFn = async (input) => {
        const url = String(input);
        const did = new URL(url).searchParams.get('did') ?? '';
        calls.push(did);
        return jsonResponse(200, { isDiscoverable: true, capabilities: ['eta_query'] });
      };
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        maxCacheEntries: 2,
      });

      await r.isDiscoverableService('did:plc:a', 'eta_query'); // cache:[a]
      await r.isDiscoverableService('did:plc:b', 'eta_query'); // cache:[a,b]
      await r.isDiscoverableService('did:plc:c', 'eta_query'); // cache:[b,c] — 'a' evicted
      expect(r.cacheSize()).toBe(2);

      // 'a' was evicted, so this is a cache miss and triggers a 4th fetch.
      await r.isDiscoverableService('did:plc:a', 'eta_query'); // cache:[c,a]
      expect(calls).toEqual(['did:plc:a', 'did:plc:b', 'did:plc:c', 'did:plc:a']);
      expect(r.cacheSize()).toBe(2);
    });

    it('re-reading an entry refreshes its LRU position', async () => {
      const calls: string[] = [];
      const fetchFn: FetchFn = async (input) => {
        const url = String(input);
        const did = new URL(url).searchParams.get('did') ?? '';
        calls.push(did);
        return jsonResponse(200, { isDiscoverable: true, capabilities: [did] });
      };
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        maxCacheEntries: 2,
      });

      await r.isDiscoverableService('did:plc:a', 'did:plc:a'); // cache:[a]      fetch #1
      await r.isDiscoverableService('did:plc:b', 'did:plc:b'); // cache:[a,b]    fetch #2
      // Touch 'a' — cache hit, moves 'a' to tail.
      await r.isDiscoverableService('did:plc:a', 'did:plc:a'); // cache:[b,a]    no fetch
      // Inserting 'c' evicts the head ('b'), not 'a'.
      await r.isDiscoverableService('did:plc:c', 'did:plc:c'); // cache:[a,c]    fetch #3

      // 'a' is still cached — re-read must not trigger a new fetch.
      await r.isDiscoverableService('did:plc:a', 'did:plc:a');

      expect(calls).toEqual(['did:plc:a', 'did:plc:b', 'did:plc:c']);
      expect(r.cacheSize()).toBe(2);
    });
  });

  describe('timeouts', () => {
    it('aborts and fails closed when the request exceeds timeoutMs', async () => {
      let abortedReason: unknown = null;
      const fetchFn: FetchFn = (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener('abort', () => {
            abortedReason = signal.reason;
            reject(new Error('aborted'));
          });
        });
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        timeoutMs: 10,
        // Timeouts are treated as retryable; disable retries so the test
        // doesn't have to model the full retry budget.
        maxRetries: 0,
      });

      expect(await r.isDiscoverableService(DID, 'eta_query')).toBe(false);
      expect(abortedReason).not.toBeNull();
    });
  });

  describe('lookup (diagnostics surface)', () => {
    it('returns the full capabilities list', async () => {
      const { fetchFn } = makeFetch([
        jsonResponse(200, { isDiscoverable: true, capabilities: ['eta_query', 'route_info'] }),
      ]);
      const r = new AppViewServiceResolver({ appViewURL: APPVIEW, fetch: fetchFn });

      const result = await r.lookup(DID);
      expect(result).toEqual({ isDiscoverable: true, capabilities: ['eta_query', 'route_info'] });
    });

    it('returns null for empty DID', async () => {
      const { fetchFn } = makeFetch([]);
      const r = new AppViewServiceResolver({ appViewURL: APPVIEW, fetch: fetchFn });
      expect(await r.lookup('')).toBeNull();
    });

    it('returns null on persistent failure (fail-closed parity)', async () => {
      const { fetchFn } = makeFetch([new Error('boom'), new Error('boom'), new Error('boom')]);
      const r = new AppViewServiceResolver({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
      });
      expect(await r.lookup(DID)).toBeNull();
    });
  });
});
