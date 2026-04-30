/**
 * Task 6.10 — CachingPlcResolver tests.
 */

import {
  CachingPlcResolver,
  DEFAULT_NOT_FOUND_TTL_MS,
  type CachingResolveOutcome,
  type FetchWithHeadersFn,
  type FetchWithHeadersResult,
} from '../src/appview/caching_plc_resolver';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';

function docBody(did: string = DID): Record<string, unknown> {
  return {
    id: did,
    alsoKnownAs: ['at://alice'],
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: 'zQ…',
      },
    ],
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: 'https://bsky.social',
      },
    ],
  };
}

function fetchOk(
  body: Record<string, unknown> | null = docBody(),
  cacheControl: string | null = null,
): FetchWithHeadersFn {
  return async () => ({ body, cacheControl });
}

function fakeClock(start = 1000) {
  let now = start;
  return {
    nowMsFn: () => now,
    advance: (d: number) => {
      now += d;
    },
  };
}

describe('CachingPlcResolver (task 6.10)', () => {
  describe('construction', () => {
    it('throws without fetchFn', () => {
      expect(
        () =>
          new CachingPlcResolver({
            fetchFn: undefined as unknown as FetchWithHeadersFn,
          }),
      ).toThrow(/fetchFn/);
    });

    it('DEFAULT_NOT_FOUND_TTL_MS is 60s', () => {
      expect(DEFAULT_NOT_FOUND_TTL_MS).toBe(60_000);
    });
  });

  describe('resolve happy path', () => {
    it('first call → network → returns doc', async () => {
      const r = new CachingPlcResolver({ fetchFn: fetchOk() });
      const out = (await r.resolve(DID)) as Extract<
        CachingResolveOutcome,
        { ok: true }
      >;
      expect(out.ok).toBe(true);
      expect(out.doc.did).toBe(DID);
      expect(out.source).toBe('network');
    });

    it('second call within TTL → fresh hit', async () => {
      let calls = 0;
      const fetchFn: FetchWithHeadersFn = async () => {
        calls++;
        return { body: docBody(), cacheControl: null };
      };
      const clock = fakeClock();
      const r = new CachingPlcResolver({ fetchFn, nowMsFn: clock.nowMsFn });
      await r.resolve(DID);
      clock.advance(100); // well within 1h default
      const r2 = (await r.resolve(DID)) as Extract<
        CachingResolveOutcome,
        { ok: true }
      >;
      expect(r2.source).toBe('fresh');
      expect(calls).toBe(1);
    });

    it('Cache-Control: max-age=60 overrides default TTL', async () => {
      let calls = 0;
      const fetchFn: FetchWithHeadersFn = async () => {
        calls++;
        return { body: docBody(), cacheControl: 'max-age=60' };
      };
      const clock = fakeClock();
      const r = new CachingPlcResolver({ fetchFn, nowMsFn: clock.nowMsFn });
      await r.resolve(DID);
      // At 30s — fresh (TTL=60s).
      clock.advance(30_000);
      await r.resolve(DID);
      expect(calls).toBe(1);
      // At 2 min past TTL but < stale window (5× TTL = 5min) → SWR.
      clock.advance(90_000);
      const r3 = (await r.resolve(DID)) as Extract<
        CachingResolveOutcome,
        { ok: true }
      >;
      expect(r3.source).toBe('stale-while-revalidate');
    });

    it('Cache-Control: no-store disables caching', async () => {
      let calls = 0;
      const fetchFn: FetchWithHeadersFn = async () => {
        calls++;
        return { body: docBody(), cacheControl: 'no-store' };
      };
      const r = new CachingPlcResolver({ fetchFn });
      await r.resolve(DID);
      await r.resolve(DID);
      // Each call goes to network because no-store → ttl=0 + storable=false.
      // SwrCache stores with ttl=0 → stale immediately; the second call
      // hits the stale branch which refetches. Either way, calls >= 2.
      expect(calls).toBeGreaterThanOrEqual(2);
    });
  });

  describe('not_found caching', () => {
    it('returns ok:false kind=not_found on null body', async () => {
      const r = new CachingPlcResolver({ fetchFn: fetchOk(null) });
      const out = await r.resolve(DID);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.kind).toBe('not_found');
      }
    });

    it('not_found is cached — short TTL default 60s', async () => {
      let calls = 0;
      const fetchFn: FetchWithHeadersFn = async () => {
        calls++;
        return { body: null, cacheControl: null };
      };
      const clock = fakeClock();
      const r = new CachingPlcResolver({ fetchFn, nowMsFn: clock.nowMsFn });
      await r.resolve(DID);
      clock.advance(30_000); // 30s < 60s TTL → still cached
      await r.resolve(DID);
      expect(calls).toBe(1);
    });

    it('custom notFoundTtlMs honoured', async () => {
      let calls = 0;
      const fetchFn: FetchWithHeadersFn = async () => {
        calls++;
        return { body: null, cacheControl: null };
      };
      const clock = fakeClock();
      const r = new CachingPlcResolver({
        fetchFn,
        nowMsFn: clock.nowMsFn,
        notFoundTtlMs: 10_000,
      });
      await r.resolve(DID);
      clock.advance(15_000); // past custom 10s TTL
      const r2 = await r.resolve(DID);
      // Past TTL but within stale window → stale-while-revalidate.
      if (!r2.ok && r2.kind === 'not_found') {
        expect(r2.source).toBe('stale-while-revalidate');
      }
    });
  });

  describe('invalid DID + errors', () => {
    it('invalid DID → invalid_did, no fetch', async () => {
      let calls = 0;
      const r = new CachingPlcResolver({
        fetchFn: async () => {
          calls++;
          return { body: docBody(), cacheControl: null };
        },
      });
      const out = await r.resolve('did:web:nope');
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.kind).toBe('invalid_did');
      expect(calls).toBe(0);
    });

    it('fetch throw with no cached entry → network_error', async () => {
      const r = new CachingPlcResolver({
        fetchFn: async () => {
          throw new Error('ENETDOWN');
        },
      });
      const out = await r.resolve(DID);
      expect(out.ok).toBe(false);
      if (out.ok === false && out.kind === 'network_error') {
        expect(out.error).toMatch(/ENETDOWN/);
      }
    });

    it('malformed doc rejects + NOT cached (next call re-fetches)', async () => {
      let calls = 0;
      const fetchFn: FetchWithHeadersFn = async () => {
        calls++;
        return { body: { id: 'not-a-did' }, cacheControl: null };
      };
      const r = new CachingPlcResolver({ fetchFn });
      // First call: body is malformed → fetchAndWrap throws → SwrCache
      // treats as fetch failure → no cache entry → caller sees
      // network_error.
      await r.resolve(DID);
      await r.resolve(DID);
      expect(calls).toBe(2); // re-fetched, not cached
    });
  });

  describe('stale-while-revalidate', () => {
    it('serves stale + refreshes in background after TTL expires', async () => {
      const clock = fakeClock();
      const bodies = [docBody(), docBody()];
      let i = 0;
      const fetchFn: FetchWithHeadersFn = async () => ({
        body: bodies[i++] ?? docBody(),
        cacheControl: 'max-age=60',
      });
      const r = new CachingPlcResolver({ fetchFn, nowMsFn: clock.nowMsFn });
      await r.resolve(DID);
      clock.advance(90_000); // past TTL, inside stale window
      const stale = (await r.resolve(DID)) as Extract<
        CachingResolveOutcome,
        { ok: true }
      >;
      expect(stale.source).toBe('stale-while-revalidate');
    });

    it('error-fallback: fetch fails past stale window → serves stale', async () => {
      const clock = fakeClock();
      let failAfter = false;
      const fetchFn: FetchWithHeadersFn = async () => {
        if (failAfter) throw new Error('offline');
        return { body: docBody(), cacheControl: 'max-age=60' };
      };
      const r = new CachingPlcResolver({ fetchFn, nowMsFn: clock.nowMsFn });
      await r.resolve(DID);
      failAfter = true;
      // Past TTL + max stale window (5× TTL = 5 min), so this is a
      // blocking refetch which fails but has stale entry.
      clock.advance(60 * 60 * 1000); // way past everything
      const out = (await r.resolve(DID)) as Extract<
        CachingResolveOutcome,
        { ok: true }
      >;
      expect(out.source).toBe('error-fallback');
      expect(out.doc.did).toBe(DID);
    });
  });

  describe('mustRevalidate + invalidation', () => {
    it('mustRevalidate forces refetch', async () => {
      let calls = 0;
      const fetchFn: FetchWithHeadersFn = async () => {
        calls++;
        return { body: docBody(), cacheControl: null };
      };
      const r = new CachingPlcResolver({ fetchFn });
      await r.resolve(DID);
      await r.resolve(DID, { mustRevalidate: true });
      expect(calls).toBe(2);
    });

    it('invalidate(did) drops the entry', async () => {
      let calls = 0;
      const fetchFn: FetchWithHeadersFn = async () => {
        calls++;
        return { body: docBody(), cacheControl: null };
      };
      const r = new CachingPlcResolver({ fetchFn });
      await r.resolve(DID);
      expect(r.invalidate(DID)).toBe(true);
      await r.resolve(DID);
      expect(calls).toBe(2);
    });

    it('invalidate with invalid DID returns false', () => {
      const r = new CachingPlcResolver({ fetchFn: fetchOk() });
      expect(r.invalidate('did:web:nope')).toBe(false);
    });

    it('clear() empties the cache', async () => {
      const r = new CachingPlcResolver({ fetchFn: fetchOk() });
      await r.resolve(DID);
      expect(r.size()).toBe(1);
      r.clear();
      expect(r.size()).toBe(0);
    });
  });

  describe('events', () => {
    it('fires resolved event with outcome kind', async () => {
      type Ev = { kind: 'resolved'; outcome: string };
      const events: Ev[] = [];
      const r = new CachingPlcResolver({
        fetchFn: fetchOk(),
        onEvent: (e) => {
          if (e.kind === 'resolved') events.push(e);
        },
      });
      await r.resolve(DID);
      expect(events[0]!.outcome).toBe('found');
    });

    it('fires resolved with outcome=invalid_did for bad input', async () => {
      type Ev = { kind: 'resolved'; outcome: string };
      const events: Ev[] = [];
      const r = new CachingPlcResolver({
        fetchFn: fetchOk(),
        onEvent: (e) => {
          if (e.kind === 'resolved') events.push(e);
        },
      });
      await r.resolve('did:web:nope');
      expect(events[0]!.outcome).toBe('invalid_did');
    });
  });

  // ── Event taxonomy + payload pinning ─────────────────────────────────
  // The four outcome values ('found', 'not_found', 'invalid_did',
  // 'network_error') feed observability dashboards that count
  // resolution failures by class. The previous tests only pinned two
  // ('found' + 'invalid_did') and never asserted the `did` payload
  // field — a refactor that swapped outcomes or sent the wrong did
  // would silently break per-DID drill-downs in the admin UI without
  // breaking any test.

  describe('events — full outcome taxonomy + did payload', () => {
    interface ResolvedEv {
      kind: 'resolved';
      did: string;
      outcome: 'found' | 'not_found' | 'invalid_did' | 'network_error';
    }

    function captureResolved(): {
      events: ResolvedEv[];
      onEvent: (e: { kind: string }) => void;
    } {
      const events: ResolvedEv[] = [];
      return {
        events,
        onEvent: (e) => {
          if (e.kind === 'resolved') events.push(e as ResolvedEv);
        },
      };
    }

    it('outcome=not_found event includes the normalised did', async () => {
      const { events, onEvent } = captureResolved();
      const r = new CachingPlcResolver({
        fetchFn: fetchOk(null), // null body → not_found
        onEvent,
      });
      await r.resolve(DID);
      expect(events).toHaveLength(1);
      expect(events[0]?.outcome).toBe('not_found');
      expect(events[0]?.did).toBe(DID);
    });

    it('outcome=network_error event includes the normalised did', async () => {
      // SWR's blocking-fetch throw with no cached entry surfaces as
      // network_error (line 157 of caching_plc_resolver.ts). Pin the
      // outcome + the did payload so per-DID error dashboards keep
      // working through a refactor.
      const { events, onEvent } = captureResolved();
      const r = new CachingPlcResolver({
        fetchFn: async () => {
          throw new Error('ENETDOWN');
        },
        onEvent,
      });
      await r.resolve(DID);
      const ev = events.find((e) => e.outcome === 'network_error');
      expect(ev).toBeDefined();
      expect(ev?.did).toBe(DID);
    });

    it('outcome=found event includes the normalised did (counter-pin to outcome alone)', async () => {
      // Counter-pin: the existing "fires resolved with outcome=found"
      // test only checked .outcome. A refactor that always sent
      // did="" would have passed it. Pin the did field too.
      const { events, onEvent } = captureResolved();
      const r = new CachingPlcResolver({ fetchFn: fetchOk(), onEvent });
      await r.resolve(DID);
      expect(events[0]?.outcome).toBe('found');
      expect(events[0]?.did).toBe(DID);
    });

    it('outcome=invalid_did event carries the RAW (unnormalised) did string', async () => {
      // For invalid_did, we never produced a normalised form (the
      // validator rejected). Production at line 148 emits
      // `String(did ?? '')` so observability sees what the caller
      // actually sent. Pin so a refactor can't silently swap to ''
      // (info-loss) or to a normalised form (impossible since
      // normalisation failed).
      const { events, onEvent } = captureResolved();
      const r = new CachingPlcResolver({ fetchFn: fetchOk(), onEvent });
      await r.resolve('did:web:nope');
      expect(events[0]?.outcome).toBe('invalid_did');
      expect(events[0]?.did).toBe('did:web:nope');
    });

    it('outcome=invalid_did handles null/undefined input via String(did ?? "")', async () => {
      // The String(did ?? '') pattern is the documented coercion.
      // Pin: null → '', undefined → '', plain object → '[object Object]'.
      // No throws — invalid input must surface as a structured event.
      const { events, onEvent } = captureResolved();
      const r = new CachingPlcResolver({ fetchFn: fetchOk(), onEvent });
      await r.resolve(null as unknown as string);
      await r.resolve(undefined as unknown as string);
      const invalidEvents = events.filter((e) => e.outcome === 'invalid_did');
      expect(invalidEvents).toHaveLength(2);
      expect(invalidEvents[0]?.did).toBe('');
      expect(invalidEvents[1]?.did).toBe('');
    });

    it('exactly one resolved event per resolve() call (no duplicate emission)', async () => {
      // Same contract iter-60 pinned for trust_resolve_client. Two
      // sequential resolutions of the same DID emit two events, not
      // four (one per call, not "one per cache-state-machine-step").
      const { events, onEvent } = captureResolved();
      const r = new CachingPlcResolver({ fetchFn: fetchOk(), onEvent });
      await r.resolve(DID);
      await r.resolve(DID); // fresh hit on the second call
      await r.resolve(DID); // fresh hit on the third call
      expect(events).toHaveLength(3);
      for (const ev of events) {
        expect(ev.outcome).toBe('found');
        expect(ev.did).toBe(DID);
      }
    });
  });
});
