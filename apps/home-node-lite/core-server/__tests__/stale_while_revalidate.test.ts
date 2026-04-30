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

    // ── ±Infinity TTL coverage ────────────────────────────────────
    // Production guard `!Number.isFinite(ttlMs) || ttlMs < 0` catches
    // NaN AND ±Infinity. A refactor to `Number.isNaN(n)` would let
    // +Infinity through and the entry would be cached forever
    // ("ageMs < Infinity" is always true) — silently breaking PLC
    // doc rotation, AppView trust refresh, every SWR consumer.
    it.each([
      ['+Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('TTL=%s rejects + throws', async (_label, value) => {
      const cache = new SwrCache<string, string>({
        fetchFn: async () => 'x',
        ttlMsFn: () => value,
      });
      await expect(cache.get('k')).rejects.toThrow(/ttlMsFn/);
    });

    it('non-finite TTL → no entry stored (rejection happens before set)', async () => {
      // Counter-pin: when ttlMsFn returns Infinity, the cache must
      // NOT store the entry. A buggy implementation that wrote first
      // and validated second would leave a phantom entry that a
      // subsequent get() would serve as "fresh".
      const cache = new SwrCache<string, string>({
        fetchFn: async () => 'x',
        ttlMsFn: () => Number.POSITIVE_INFINITY,
      });
      await expect(cache.get('k')).rejects.toThrow();
      expect(cache.size()).toBe(0);
      expect(cache.peek('k')).toBeNull();
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

  // ── Event payload contract pinning ───────────────────────────────────
  // Existing event tests use `events.some((e) => e.kind === '<X>')`
  // — they only verify the event TYPE is emitted, NOT the payload.
  // Observability dashboards downstream (admin UI "N hits, M stale,
  // P errors recovered, latest revalidate took Q ms") read the payload
  // fields. A future refactor that swapped fields, dropped the error
  // string, or sent the wrong key would silently pass those existing
  // assertions. Pin the payload contract.

  describe('events — payload contract', () => {
    function pickEvent<K extends SwrEvent['kind']>(
      events: readonly SwrEvent[],
      kind: K,
    ): Extract<SwrEvent, { kind: K }> | undefined {
      return events.find((e): e is Extract<SwrEvent, { kind: K }> => e.kind === kind);
    }

    it('error_fallback event carries the upstream error string + ageMs of the served stale entry', async () => {
      const events: SwrEvent[] = [];
      const sequence: (() => string)[] = [
        () => 'first',
        () => {
          throw new Error('ENETDOWN');
        },
      ];
      let i = 0;
      const clock = fakeClock(1000);
      const cache = new SwrCache<string, string>({
        fetchFn: async () => {
          const fn = sequence[i++];
          if (fn === undefined) throw new Error('test sequence exhausted');
          return fn();
        },
        ttlMsFn: () => 60_000,
        staleTtlMs: 60_000,
        nowMsFn: clock.nowMsFn,
        onEvent: (e) => events.push(e),
      });
      await cache.get('k');
      clock.advance(200_000); // past TTL + stale window → blocking refetch
      const recovered = await cache.get('k');
      expect(recovered.source).toBe('error-fallback');
      const ev = pickEvent(events, 'error_fallback');
      expect(ev).toBeDefined();
      expect(ev?.key).toBe('k');
      expect(ev?.error).toContain('ENETDOWN');
      // ageMs is the age of the stale entry served (200_000 ms past
      // the original 1000ms write).
      expect(ev?.ageMs).toBe(200_000);
    });

    it('revalidate_failed event carries the upstream error string', async () => {
      const events: SwrEvent[] = [];
      const sequence: (() => string)[] = [
        () => 'first',
        () => {
          throw new Error('transient-DNS-failure');
        },
      ];
      let i = 0;
      const clock = fakeClock(1000);
      const cache = new SwrCache<string, string>({
        fetchFn: async () => {
          const fn = sequence[i++];
          if (fn === undefined) throw new Error('test sequence exhausted');
          return fn();
        },
        ttlMsFn: () => 60_000,
        staleTtlMs: 600_000,
        nowMsFn: clock.nowMsFn,
        onEvent: (e) => events.push(e),
      });
      await cache.get('k');
      clock.advance(120_000); // SWR window
      await cache.get('k'); // stale-while-revalidate kicks off background refresh
      // Drain microtasks so the background refresh's catch-handler runs.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      const ev = pickEvent(events, 'revalidate_failed');
      expect(ev).toBeDefined();
      expect(ev?.key).toBe('k');
      expect(ev?.error).toContain('transient-DNS-failure');
    });

    it('coalesced event carries the shared key (one event per coalesce, not per joiner)', async () => {
      // The coalescing test pinned BEHAVIOUR (one fetch). This pins
      // EVENT EMISSION — every joiner past the first emits a
      // `coalesced` event so the admin UI can count "we saved N
      // round-trips this hour".
      const events: SwrEvent[] = [];
      const settleable = { release: () => undefined };
      const cache = new SwrCache<string, string>({
        fetchFn: async () =>
          new Promise<string>((resolve) => {
            settleable.release = () => {
              resolve('value');
              return undefined;
            };
          }),
        ttlMsFn: () => 60_000,
        onEvent: (e) => events.push(e),
      });
      const p1 = cache.get('k');
      const p2 = cache.get('k');
      const p3 = cache.get('k');
      settleable.release();
      await Promise.all([p1, p2, p3]);
      const coalesced = events.filter((e) => e.kind === 'coalesced');
      // 3 callers, 1 leader → 2 joiners → 2 coalesced events.
      expect(coalesced).toHaveLength(2);
      // Every coalesced event is for key 'k'.
      for (const e of coalesced) {
        expect(e.kind === 'coalesced' && e.key).toBe('k');
      }
    });

    it('revalidate_succeeded event carries durationMs (≥0, finite)', async () => {
      // The duration is computed via `nowMsFn() - startMs` inside
      // startRefresh. With an injected clock + zero-cost fetchFn the
      // duration is 0. Pin the contract: the field is a finite
      // non-negative number, regardless of clock.
      const events: SwrEvent[] = [];
      const clock = fakeClock(1000);
      const cache = new SwrCache<string, string>({
        fetchFn: async () => {
          // Advance the clock during the fetch so the duration is
          // measurably positive — proves `nowMsFn()-startMs` is wired
          // correctly, not always returning 0.
          clock.advance(50);
          return 'v';
        },
        ttlMsFn: () => 60_000,
        nowMsFn: clock.nowMsFn,
        onEvent: (e) => events.push(e),
      });
      await cache.get('k');
      const ev = pickEvent(events, 'revalidate_succeeded');
      expect(ev).toBeDefined();
      expect(ev?.key).toBe('k');
      expect(ev?.durationMs).toBe(50);
      expect(Number.isFinite(ev?.durationMs)).toBe(true);
    });

    it('miss event carries the key', async () => {
      const events: SwrEvent[] = [];
      const cache = new SwrCache<string, string>({
        fetchFn: async () => 'v',
        ttlMsFn: () => 60_000,
        onEvent: (e) => events.push(e),
      });
      await cache.get('subject-42');
      const ev = pickEvent(events, 'miss');
      expect(ev?.key).toBe('subject-42');
    });

    it('fresh_hit event carries the key + ageMs of the served entry', async () => {
      const events: SwrEvent[] = [];
      const clock = fakeClock(1000);
      const cache = new SwrCache<string, string>({
        fetchFn: async () => 'v',
        ttlMsFn: () => 60_000,
        nowMsFn: clock.nowMsFn,
        onEvent: (e) => events.push(e),
      });
      await cache.get('k'); // miss + writes entry at t=1000
      clock.advance(5000); // 5s into the 60s TTL
      events.length = 0;
      await cache.get('k'); // fresh hit
      const ev = pickEvent(events, 'fresh_hit');
      expect(ev?.key).toBe('k');
      expect(ev?.ageMs).toBe(5000);
    });

    it('stale_served event carries the key + ageMs (past TTL)', async () => {
      const events: SwrEvent[] = [];
      const clock = fakeClock(1000);
      const cache = new SwrCache<string, string>({
        fetchFn: async () => 'v',
        ttlMsFn: () => 60_000,
        staleTtlMs: 600_000,
        nowMsFn: clock.nowMsFn,
        onEvent: (e) => events.push(e),
      });
      await cache.get('k');
      clock.advance(120_000); // 60s past TTL, inside stale window
      events.length = 0;
      await cache.get('k');
      const ev = pickEvent(events, 'stale_served');
      expect(ev?.key).toBe('k');
      expect(ev?.ageMs).toBe(120_000);
    });
  });
});
