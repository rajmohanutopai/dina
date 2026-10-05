/**
 * The public-document cache (UCP plan §3.6 steps 1 and 4a): Cache-Control
 * with a 60 s floor, If-None-Match revalidation, stale while revalidating for
 * profiles, one fetch per URL at a time.
 */
import {
  CACHE_CEILING_SECONDS,
  DocumentCache,
  STALE_WINDOW_SECONDS,
  freshFor,
  parseCacheControl,
} from '../../../src/commerce/ucp/http_cache';

import type { UcpFetchResult } from '../../../src/commerce/ucp/fetch';
import type { PolicySocketRequest } from '@dina/net-policy';

const URL_A = 'https://shop.example/.well-known/ucp';

function server(answers: (Partial<UcpFetchResult & { ok: true }> | 'down')[]) {
  const seen: PolicySocketRequest[] = [];
  const fetch = async (r: PolicySocketRequest): Promise<UcpFetchResult> => {
    seen.push(r);
    const a = answers.shift() ?? {};
    if (a === 'down') return { ok: false, error: 'connect_failed', sent: false };
    return {
      ok: true,
      status: 200,
      bodyBytes: new TextEncoder().encode('{"v":1}'),
      headers: {},
      connectedAddress: '203.0.114.7',
      ...a,
    } as UcpFetchResult;
  };
  return { seen, fetch };
}

describe('Cache-Control', () => {
  it('reads max-age, no-store and no-cache; ignores the rest and malformed values', () => {
    expect(parseCacheControl('public, max-age=300')).toEqual({
      maxAge: 300,
      noStore: false,
      noCache: false,
    });
    expect(parseCacheControl('max-age="120", no-cache')).toEqual({
      maxAge: 120,
      noStore: false,
      noCache: true,
    });
    expect(parseCacheControl('max-age=-5, NO-STORE')).toEqual({
      maxAge: null,
      noStore: true,
      noCache: false,
    });
    expect(parseCacheControl(undefined)).toEqual({ maxAge: null, noStore: false, noCache: false });
  });

  it('a 60 s floor, a day ceiling; no-store and no-cache still get the floor', () => {
    expect(freshFor(parseCacheControl('max-age=5'))).toBe(60);
    expect(freshFor(parseCacheControl('max-age=600'))).toBe(600);
    expect(freshFor(parseCacheControl('max-age=99999999'))).toBe(CACHE_CEILING_SECONDS);
    expect(freshFor(parseCacheControl('no-store, max-age=600'))).toBe(60);
    expect(freshFor(parseCacheControl(undefined))).toBe(60);
  });
});

describe('the document cache', () => {
  it('serves a fresh copy without fetching, then revalidates with If-None-Match and keeps the bytes on a 304', async () => {
    let now = 0;
    const s = server([
      { headers: { 'cache-control': 'max-age=120', etag: '"v1"' } },
      { status: 304, bodyBytes: new Uint8Array() },
    ]);
    const cache = new DocumentCache({
      fetch: s.fetch,
      now: () => now,
      maxBytes: 1024,
      staleWhileRevalidate: false,
    });
    const first = await cache.get(URL_A);
    now = 119_000;
    expect(await cache.get(URL_A)).toMatchObject({ ok: true, stale: false });
    expect(s.seen).toHaveLength(1);
    now = 121_000;
    const again = await cache.get(URL_A);
    expect(s.seen).toHaveLength(2);
    expect(s.seen[1]?.ifNoneMatch).toBe('"v1"');
    expect(again.ok && new TextDecoder().decode(again.doc.bytes)).toBe('{"v":1}');
    expect(first.ok && again.ok && again.doc.freshUntil).toBe(121_000 + 60_000);
  });

  it('profiles are served stale at once while one revalidation runs behind them', async () => {
    let now = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const s = server([{}]);
    const slow = async (r: PolicySocketRequest) => {
      if (s.seen.length >= 1) await gate;
      return s.fetch(r);
    };
    const cache = new DocumentCache({
      fetch: slow,
      now: () => now,
      maxBytes: 1024,
      staleWhileRevalidate: true,
    });
    await cache.get(URL_A);
    now = 61_000;
    const [a, b] = await Promise.all([cache.get(URL_A), cache.get(URL_A)]);
    expect(a).toMatchObject({ ok: true, stale: true });
    expect(b).toMatchObject({ ok: true, stale: true });
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.seen).toHaveLength(2);
  });

  it('schemas wait for revalidation; a failure is reported, never a stale copy', async () => {
    let now = 0;
    const s = server([{}, 'down', { status: 500 }]);
    const cache = new DocumentCache({
      fetch: s.fetch,
      now: () => now,
      maxBytes: 1024,
      staleWhileRevalidate: false,
    });
    await cache.get(URL_A);
    now = 61_000;
    expect(await cache.get(URL_A)).toEqual({ ok: false, error: 'unreachable' });
    expect(await cache.get(URL_A)).toEqual({ ok: false, error: 'status', status: 500 });
  });

  it('a body over the cap is too_large; the request carries the cap', async () => {
    const fetch = async (r: PolicySocketRequest): Promise<UcpFetchResult> => {
      expect(r.maxResponseBytes).toBe(256 * 1024);
      return { ok: false, error: 'too_large', sent: true };
    };
    const cache = new DocumentCache({ fetch, maxBytes: 256 * 1024, staleWhileRevalidate: false });
    expect(await cache.get(URL_A)).toEqual({ ok: false, error: 'too_large' });
  });

  it('keeps at most maxEntries documents, dropping the oldest', async () => {
    const s = server([]);
    const cache = new DocumentCache({
      fetch: s.fetch,
      maxBytes: 1024,
      staleWhileRevalidate: false,
      maxEntries: 2,
    });
    for (const u of ['https://a.example/x', 'https://b.example/x', 'https://c.example/x'])
      await cache.get(u);
    await cache.get('https://a.example/x');
    expect(s.seen.map((r) => r.url)).toEqual([
      'https://a.example/x',
      'https://b.example/x',
      'https://c.example/x',
      'https://a.example/x',
    ]);
  });

  it('profile mode: a stale copy is revalidated with If-None-Match, and a 304 makes it fresh again', async () => {
    let now = 0;
    const s = server([
      { headers: { 'cache-control': 'max-age=60', etag: '"p1"' } },
      { status: 304, bodyBytes: new Uint8Array() },
    ]);
    const cache = new DocumentCache({
      fetch: s.fetch,
      now: () => now,
      maxBytes: 1024,
      staleWhileRevalidate: true,
    });
    await cache.get(URL_A);
    now = 61_000;
    expect(await cache.get(URL_A)).toMatchObject({ ok: true, stale: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.seen[1]?.ifNoneMatch).toBe('"p1"');
    expect(await cache.get(URL_A)).toMatchObject({ ok: true, stale: false });
    expect(s.seen).toHaveLength(2);
  });

  it('a merchant that withdrew its profile (404 or 410 on revalidation) is never served the old copy again', async () => {
    for (const status of [404, 410]) {
      let now = 0;
      const s = server([{}, { status }, { status }]);
      const cache = new DocumentCache({
        fetch: s.fetch,
        now: () => now,
        maxBytes: 1024,
        staleWhileRevalidate: true,
      });
      await cache.get(URL_A);
      now = 61_000;
      await cache.get(URL_A); // stale, while the revalidation finds it gone
      await new Promise((r) => setTimeout(r, 0));
      expect(await cache.get(URL_A)).toEqual({ ok: false, error: 'status', status });
    }
  });

  it('a failed revalidation waits a minute before the next; past the stale window a read waits for the merchant', async () => {
    let now = 0;
    const s = server([{}, 'down', 'down', 'down']);
    const cache = new DocumentCache({
      fetch: s.fetch,
      now: () => now,
      maxBytes: 1024,
      staleWhileRevalidate: true,
    });
    await cache.get(URL_A);
    now = 61_000;
    await cache.get(URL_A);
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 5; i++) await cache.get(URL_A);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.seen).toHaveLength(2); // the first fetch and one failed revalidation, nothing more within the minute
    now = 61_000 + 60_000;
    await cache.get(URL_A);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.seen).toHaveLength(3);
    now = 60_000 + STALE_WINDOW_SECONDS * 1000 + 1;
    expect(await cache.get(URL_A)).toEqual({ ok: false, error: 'unreachable' });
  });
});
