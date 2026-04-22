/**
 * Task 6.16 — SwrCache tests.
 */

import {
  SwrCache,
  type SwrEvent,
  type SwrResult,
} from '../src/appview/stale_while_revalidate';

interface FakeClock {
  now: number;
  nowMsFn: () => number;
  advance: (d: number) => void;
}

function fakeClock(start = 0): FakeClock {
  const c = { now: start } as { now: number };
  return {
    get now() {
      return c.now;
    },
    nowMsFn: () => c.now,
    advance: (d: number) => {
      c.now += d;
    },
  };
}


describe('SwrCache (task 6.16)', () => {
  describe('construction validation', () => {
    it('rejects missing fetchFn', () => {
      expect(
        () =>
          new SwrCache({
            fetchFn: undefined as unknown as (k: string) => Promise<string>,
            ttlMsFn: () => 1000,
          }),
      ).toThrow(/fetchFn/);
    });

    it('rejects missing ttlMsFn', () => {
      expect(
        () =>
          new SwrCache({
            fetchFn: async () => 'x',
            ttlMsFn: undefined as unknown as () => number,
          }),
      ).toThrow(/ttlMsFn/);
    });
  });

  describe('miss', () => {
    it('miss → fetch + return value + emit miss', async () => {
      const events: SwrEvent[] = [];
      let calls = 0;
      const clock = fakeClock(1000);
      const cache = new SwrCache<string, string>({
        fetchFn: async () => {
          calls++;
          return 'value-1';
        },
        ttlMsFn: () => 60_000,
        nowMsFn: clock.nowMsFn,
        onEvent: (e) => events.push(e),
      });
      const res = (await cache.get('k')) as SwrResult<string>;
      expect(res.value).toBe('value-1');
      expect(res.source).toBe('miss');
      expect(res.ageMs).toBe(0);
      expect(calls).toBe(1);
      expect(events.some((e) => e.kind === 'miss')).toBe(true);
      expect(events.some((e) => e.kind === 'revalidate_succeeded')).toBe(true);
    });

    it('miss that throws → rejects + no entry stored', async () => {
      const cache = new SwrCache<string, string>({
        fetchFn: async () => {
          throw new Error('network');
        },
        ttlMsFn: () => 60_000,
      });
      await expect(cache.get('k')).rejects.toThrow(/network/);
      expect(cache.size()).toBe(0);
    });
  });

  describe('fresh hit', () => {
    it('within TTL → serve cached + no refetch', async () => {
      const events: SwrEvent[] = [];
      let calls = 0;
      const clock = fakeClock(1000);
      const cache = new SwrCache<string, string>({
        fetchFn: async () => {
          calls++;
          return 'v';
        },
        ttlMsFn: () => 60_000,
        nowMsFn: clock.nowMsFn,
        onEvent: (e) => events.push(e),
      });
      await cache.get('k');
      expect(calls).toBe(1);

      clock.advance(30_000);
      const res = await cache.get('k');
      expect(res.source).toBe('fresh-hit');
      expect(res.ageMs).toBe(30_000);
      expect(calls).toBe(1); // still 1 — no refetch
      expect(events.some((e) => e.kind === 'fresh_hit')).toBe(true);
    });
  });

  describe('stale-while-revalidate', () => {
    it('past TTL but within stale window → serve stale + background refresh', async () => {
      const events: SwrEvent[] = [];
      let calls = 0;
      const returns = ['first', 'second'];
      const clock = fakeClock(1000);
      const cache = new SwrCache<string, string>({
        fetchFn: async () => {
          const v = returns[calls]!;
          calls++;
          return v;
        },
        ttlMsFn: () => 60_000, // 1 min fresh
        staleTtlMs: 300_000,   // 5 min stale window
        nowMsFn: clock.nowMsFn,
        onEvent: (e) => events.push(e),
      });
      const first = await cache.get('k');
      expect(first.value).toBe('first');
      expect(calls).toBe(1);

      // Past TTL, within stale window.
      clock.advance(120_000);
      const stale = await cache.get('k');
      expect(stale.value).toBe('first'); // served the stale value
      expect(stale.source).toBe('stale-while-revalidate');
      expect(stale.ageMs).toBe(120_000);

      // Background refresh is in flight — await it by awaiting a microtask loop.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(2);

      // Next get sees the fresh value.
      const fresh = await cache.get('k');
      expect(fresh.value).toBe('second');
      expect(fresh.source).toBe('fresh-hit');

      // Events fired.
      expect(events.map((e) => e.kind)).toEqual(
        expect.arrayContaining([
          'miss',
          'revalidate_succeeded',
          'stale_served',
          'fresh_hit',
        ]),
      );
    });

    it('past stale window → blocking fetch (not SWR)', async () => {
      let calls = 0;
      const clock = fakeClock(1000);
      const cache = new SwrCache<string, string>({
        fetchFn: async () => {
          calls++;
          return `v${calls}`;
        },
        ttlMsFn: () => 60_000,
        staleTtlMs: 60_000, // 1 min stale
        nowMsFn: clock.nowMsFn,
      });
      await cache.get('k'); // calls=1
      clock.advance(200_000); // past TTL + staleTtl
      const blocked = await cache.get('k');
      expect(blocked.source).toBe('revalidate-blocking');
      expect(blocked.value).toBe('v2');
      expect(calls).toBe(2);
    });

    it('default staleTtlMs = 5 * ttlMs when not provided', async () => {
      let calls = 0;
      const clock = fakeClock(1000);
      const cache = new SwrCache<string, string>({
        fetchFn: async () => {
          calls++;
          return `v${calls}`;
        },
        ttlMsFn: () => 10_000, // 10s fresh → 50s stale window
        nowMsFn: clock.nowMsFn,
      });
      await cache.get('k');
      clock.advance(45_000); // past TTL (10s) + within 5 * TTL (50s)
      const stale = await cache.get('k');
      expect(stale.source).toBe('stale-while-revalidate');
    });
  });

  describe('mustRevalidate', () => {
    it('blocks on fresh fetch even within TTL', async () => {
      let calls = 0;
      const clock = fakeClock(1000);
      const cache = new SwrCache<string, string>({
        fetchFn: async () => {
          calls++;
          return `v${calls}`;
        },
        ttlMsFn: () => 60_000,
        nowMsFn: clock.nowMsFn,
      });
      await cache.get('k'); // calls=1
      const forced = await cache.get('k', { mustRevalidate: true });
      expect(forced.source).toBe('revalidate-blocking');
      expect(forced.value).toBe('v2');
      expect(calls).toBe(2);
    });

    it('blocks even when a stale entry exists', async () => {
      let calls = 0;
      const clock = fakeClock(1000);
      const cache = new SwrCache<string, string>({
        fetchFn: async () => {
          calls++;
          return `v${calls}`;
        },
        ttlMsFn: () => 60_000,
        nowMsFn: clock.nowMsFn,
      });
      await cache.get('k');
      clock.advance(180_000);
      const forced = await cache.get('k', { mustRevalidate: true });
      expect(forced.source).toBe('revalidate-blocking');
      expect(forced.value).toBe('v2');
    });
  });

  describe('error fallback', () => {
    it('blocking refetch that fails with a stale entry → serve stale', async () => {
      const events: SwrEvent[] = [];
      const sequence: Array<() => string> = [
        () => 'first',
        () => {
          throw new Error('network');
        },
      ];
      let i = 0;
      const clock = fakeClock(1000);
      const cache = new SwrCache<string, string>({
        fetchFn: async () => {
          return sequence[i++]!();
        },
        ttlMsFn: () => 60_000,
        staleTtlMs: 60_000,
        nowMsFn: clock.nowMsFn,
        onEvent: (e) => events.push(e),
      });
      await cache.get('k');
      clock.advance(200_000); // past stale window → blocking fetch
      const recovered = await cache.get('k');
      expect(recovered.source).toBe('error-fallback');
      expect(recovered.value).toBe('first'); // stale value rescues us
      expect(events.some((e) => e.kind === 'error_fallback')).toBe(true);
    });

    it('SWR background refresh that fails does NOT become an unhandled rejection', async () => {
      const events: SwrEvent[] = [];
      const sequence: Array<() => string> = [
        () => 'first',
        () => {
          throw new Error('transient-network-error');
        },
      ];
      let i = 0;
      const clock = fakeClock(1000);
      const cache = new SwrCache<string, string>({
        fetchFn: async () => sequence[i++]!(),
        ttlMsFn: () => 60_000,
        staleTtlMs: 600_000,
        nowMsFn: clock.nowMsFn,
        onEvent: (e) => events.push(e),
      });
      await cache.get('k');
      clock.advance(120_000);

      const rejections: unknown[] = [];
      const handler = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on('unhandledRejection', handler);
      try {
        const stale = await cache.get('k');
        expect(stale.source).toBe('stale-while-revalidate');
        expect(stale.value).toBe('first');
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
      } finally {
        process.off('unhandledRejection', handler);
      }

      expect(rejections).toEqual([]);
      expect(events.some((e) => e.kind === 'revalidate_failed')).toBe(true);
    });

    it('miss that throws has NO fallback → propagates error', async () => {
      const cache = new SwrCache<string, string>({
        fetchFn: async () => {
          throw new Error('boom');
        },
        ttlMsFn: () => 60_000,
      });
      await expect(cache.get('k')).rejects.toThrow(/boom/);
    });
  });

  describe('coalescing', () => {
    it('two concurrent gets for the same key share one fetch', async () => {
      let calls = 0;
      const settleable = {
        release: () => {},
      };
      const cache = new SwrCache<string, string>({
        fetchFn: async () =>
          new Promise<string>((resolve) => {
            calls++;
            settleable.release = () => resolve('value');
          }),
        ttlMsFn: () => 60_000,
      });
      const p1 = cache.get('k');
      const p2 = cache.get('k');
      settleable.release();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(calls).toBe(1);
      expect(r1.value).toBe('value');
      expect(r2.value).toBe('value');
    });

    it('different keys do NOT coalesce', async () => {
      let calls = 0;
      const cache = new SwrCache<string, string>({
        fetchFn: async (k) => {
          calls++;
          return `v-${k}`;
        },
        ttlMsFn: () => 60_000,
      });
      await Promise.all([cache.get('a'), cache.get('b')]);
      expect(calls).toBe(2);
    });
  });

  describe('ttlMsFn contract', () => {
    it('ttlMsFn receives value + key + its return drives freshness', async () => {
      const seen: Array<{ v: string; k: string }> = [];
      const cache = new SwrCache<string, string>({
        fetchFn: async () => 'hello',
        ttlMsFn: (v, k) => {
          seen.push({ v, k });
          return 1234;
        },
      });
      await cache.get('key-1');
      expect(seen).toEqual([{ v: 'hello', k: 'key-1' }]);
      const peek = cache.peek('key-1');
      expect(peek?.ttlMs).toBe(1234);
    });

    it('NaN TTL rejects + throws', async () => {
      const cache = new SwrCache<string, string>({
        fetchFn: async () => 'x',
        ttlMsFn: () => NaN,
      });
      await expect(cache.get('k')).rejects.toThrow(/ttlMsFn/);
    });

    it('negative TTL rejects + throws', async () => {
      const cache = new SwrCache<string, string>({
        fetchFn: async () => 'x',
        ttlMsFn: () => -1,
      });
      await expect(cache.get('k')).rejects.toThrow(/ttlMsFn/);
    });

    it('ttlMsFn = 0 → entry stored but immediately stale', async () => {
      const clock = fakeClock(1000);
      let calls = 0;
      const cache = new SwrCache<string, string>({
        fetchFn: async () => {
          calls++;
          return `v${calls}`;
        },
        ttlMsFn: () => 0,
        staleTtlMs: 60_000,
        nowMsFn: clock.nowMsFn,
      });
      await cache.get('k'); // calls=1
      // Same tick → age=0 but TTL=0 → already stale → SWR branch
      // (since staleTtl=60_000 > 0, we're inside the stale window).
      const res = await cache.get('k');
      expect(res.source).toBe('stale-while-revalidate');
    });
  });

  describe('admin helpers', () => {
    it('peek returns the stored entry without touching TTL', async () => {
      const clock = fakeClock(5000);
      const cache = new SwrCache<string, string>({
        fetchFn: async () => 'v',
        ttlMsFn: () => 1000,
        nowMsFn: clock.nowMsFn,
      });
      await cache.get('k');
      const peek = cache.peek('k');
      expect(peek).toEqual({ value: 'v', writtenAtMs: 5000, ttlMs: 1000 });
    });

    it('peek returns null for unknown key', () => {
      const cache = new SwrCache<string, string>({
        fetchFn: async () => 'v',
        ttlMsFn: () => 1000,
      });
      expect(cache.peek('nope')).toBeNull();
    });

    it('invalidate removes an entry', async () => {
      const cache = new SwrCache<string, string>({
        fetchFn: async () => 'v',
        ttlMsFn: () => 1000,
      });
      await cache.get('k');
      expect(cache.invalidate('k')).toBe(true);
      expect(cache.size()).toBe(0);
      expect(cache.invalidate('k')).toBe(false);
    });

    it('clear empties the cache', async () => {
      const cache = new SwrCache<string, string>({
        fetchFn: async (k) => `v-${k}`,
        ttlMsFn: () => 1000,
      });
      await cache.get('a');
      await cache.get('b');
      expect(cache.size()).toBe(2);
      cache.clear();
      expect(cache.size()).toBe(0);
    });

    it('keyFn customises the cache index', async () => {
      let calls = 0;
      const cache = new SwrCache<{ id: string; meta: string }, string>({
        fetchFn: async () => {
          calls++;
          return `v${calls}`;
        },
        ttlMsFn: () => 60_000,
        keyFn: (k) => k.id, // collapse by id
      });
      await cache.get({ id: '1', meta: 'a' });
      await cache.get({ id: '1', meta: 'b' }); // same id → cache hit
      expect(calls).toBe(1);
      const peeked = cache.peek({ id: '1', meta: 'c' });
      expect(peeked?.value).toBe('v1');
    });
  });
});
