/**
 * Task 6.12 — service search xRPC client tests.
 */

import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  createServiceSearchClient,
  type ServiceMatch,
  type ServiceSearchFetchFn,
  type ServiceSearchOutcome,
  type ServiceSearchRequest,
} from '../src/appview/service_search_client';

function match(overrides: Partial<ServiceMatch> = {}): ServiceMatch {
  return {
    operatorDid: 'did:plc:abcdefghijklmnopqrstuvwx',
    name: 'SF Transit Authority',
    capability: 'eta_query',
    schema: {
      description: 'Query bus ETA',
      params: { type: 'object' },
      result: { type: 'object' },
    },
    schema_hash: 'a1b2c3d4',
    distance_km: 2.3,
    trust_score: 0.92,
    ...overrides,
  };
}

function okBody(services: ServiceMatch[] = [match()], total?: number): Record<string, unknown> {
  return { services, total: total ?? services.length };
}

function stubFetch(body: Record<string, unknown> | null, status = 200): ServiceSearchFetchFn {
  return async () => ({ body, status });
}

describe('createServiceSearchClient (task 6.12)', () => {
  describe('construction', () => {
    it('throws without fetchFn', () => {
      expect(() =>
        createServiceSearchClient({
          fetchFn: undefined as unknown as ServiceSearchFetchFn,
        }),
      ).toThrow(/fetchFn/);
    });

    it('MAX_SEARCH_LIMIT is 50 + default is 10', () => {
      expect(MAX_SEARCH_LIMIT).toBe(50);
      expect(DEFAULT_SEARCH_LIMIT).toBe(10);
    });
  });

  describe('happy path', () => {
    it('parses a response with a single service', async () => {
      const search = createServiceSearchClient({ fetchFn: stubFetch(okBody()) });
      const out = (await search({ capability: 'eta_query' })) as Extract<
        ServiceSearchOutcome,
        { ok: true }
      >;
      expect(out.ok).toBe(true);
      expect(out.response.services).toHaveLength(1);
      expect(out.response.services[0]!.operatorDid).toBe(
        'did:plc:abcdefghijklmnopqrstuvwx',
      );
      expect(out.response.total).toBe(1);
    });

    it('threads limit default into request', async () => {
      let seen: ServiceSearchRequest | null = null;
      const fetchFn: ServiceSearchFetchFn = async (input) => {
        seen = input;
        return { body: okBody([]), status: 200 };
      };
      await createServiceSearchClient({ fetchFn })({ capability: 'eta_query' });
      expect(seen!.limit).toBe(DEFAULT_SEARCH_LIMIT);
    });

    it('honours explicit limit', async () => {
      let seen: ServiceSearchRequest | null = null;
      const fetchFn: ServiceSearchFetchFn = async (input) => {
        seen = input;
        return { body: okBody([]), status: 200 };
      };
      await createServiceSearchClient({ fetchFn })({ limit: 25 });
      expect(seen!.limit).toBe(25);
    });

    it('null body on 2xx → empty services', async () => {
      const out = (await createServiceSearchClient({
        fetchFn: stubFetch(null, 200),
      })({})) as Extract<ServiceSearchOutcome, { ok: true }>;
      expect(out.response.services).toEqual([]);
      expect(out.response.total).toBe(0);
    });

    it('distance_km with missing field defaults to -1', async () => {
      const noDist = { ...match(), distance_km: undefined as unknown as number };
      const out = (await createServiceSearchClient({
        fetchFn: stubFetch({ services: [noDist] }),
      })({})) as Extract<ServiceSearchOutcome, { ok: true }>;
      expect(out.response.services[0]!.distance_km).toBe(-1);
    });

    it('null trust_score preserved', async () => {
      const noTrust: ServiceMatch = { ...match(), trust_score: null };
      const out = (await createServiceSearchClient({
        fetchFn: stubFetch({ services: [noTrust] }),
      })({})) as Extract<ServiceSearchOutcome, { ok: true }>;
      expect(out.response.services[0]!.trust_score).toBeNull();
    });

    it('malformed service entries skipped', async () => {
      const bad = [
        match(),
        null, // skip
        { ...match(), operatorDid: 'not-a-did' }, // skip
        { ...match(), capability: 'Bad-Capability' }, // skip (regex rejects uppercase + dash)
        { ...match(), name: '' }, // skip
        match({ name: 'Other Provider' }), // keep
      ];
      const out = (await createServiceSearchClient({
        fetchFn: stubFetch({ services: bad }),
      })({})) as Extract<ServiceSearchOutcome, { ok: true }>;
      expect(out.response.services).toHaveLength(2);
      expect(out.response.services.map((s) => s.name).sort()).toEqual([
        'Other Provider',
        'SF Transit Authority',
      ]);
    });

    it('fires searched event with result count', async () => {
      type Ev = { kind: 'searched'; capability: string | undefined; resultCount: number };
      const events: Ev[] = [];
      const search = createServiceSearchClient({
        fetchFn: stubFetch(okBody([match(), match({ name: 'X' })])),
        onEvent: (e) => {
          if (e.kind === 'searched') events.push(e);
        },
      });
      await search({ capability: 'eta_query' });
      expect(events[0]!.capability).toBe('eta_query');
      expect(events[0]!.resultCount).toBe(2);
    });
  });

  describe('input validation', () => {
    it.each([
      ['bad capability char', { capability: 'eta-query' }],
      ['uppercase capability', { capability: 'ETA' }],
      ['capability with leading digit', { capability: '1cap' }],
      ['non-string query', { query: 42 as unknown as string }],
      ['query too long', { query: 'x'.repeat(1001) }],
      ['location missing fields', { location: { lat: 1 } as unknown as { lat: number; lng: number } }],
      ['lat out of range', { location: { lat: 100, lng: 0 } }],
      ['lng out of range', { location: { lat: 0, lng: 200 } }],
      ['NaN lat', { location: { lat: NaN, lng: 0 } }],
      ['negative radius', { location: { lat: 0, lng: 0, radiusKm: -1 } }],
      ['limit below min', { limit: 0 }],
      ['limit above max', { limit: 999 }],
      ['non-integer limit', { limit: 1.5 }],
      ['bad minRing', { minRing: 4 as unknown as 1 | 2 | 3 }],
    ])('rejects %s', async (_label, overrides) => {
      const search = createServiceSearchClient({ fetchFn: stubFetch(okBody()) });
      const out = await search(overrides as ServiceSearchRequest);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid_input');
    });

    it('non-object input rejected', async () => {
      const search = createServiceSearchClient({ fetchFn: stubFetch(okBody()) });
      const out = await search(null as unknown as ServiceSearchRequest);
      expect(out.ok).toBe(false);
    });
  });

  describe('HTTP failures', () => {
    it('5xx → rejected_by_appview', async () => {
      const search = createServiceSearchClient({
        fetchFn: stubFetch({ error: 'db error' }, 503),
      });
      const out = await search({});
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'rejected_by_appview') {
        expect(out.status).toBe(503);
        expect(out.error).toMatch(/db error/);
      }
    });

    it('4xx (non-404) → rejected_by_appview', async () => {
      const search = createServiceSearchClient({
        fetchFn: stubFetch({ error: 'bad query' }, 400),
      });
      const out = await search({});
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('rejected_by_appview');
    });

    it('fetch throw → network_error', async () => {
      const search = createServiceSearchClient({
        fetchFn: async () => {
          throw new Error('ECONNRESET');
        },
      });
      const out = await search({});
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'network_error') {
        expect(out.error).toMatch(/ECONNRESET/);
      }
    });
  });

  describe('malformed response', () => {
    it('services not an array → malformed_response', async () => {
      const search = createServiceSearchClient({
        fetchFn: stubFetch({ services: 'not-array' }),
      });
      const out = await search({});
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });
  });

  describe('realistic scenarios', () => {
    it('SF transit search', async () => {
      const search = createServiceSearchClient({
        fetchFn: stubFetch(
          okBody([
            match({
              name: 'SF Transit Authority',
              capability: 'eta_query',
              distance_km: 2.3,
              trust_score: 0.92,
            }),
            match({
              operatorDid: 'did:plc:bcdefghijklmnopqrstuvwxa',
              name: 'Muni Alternate',
              capability: 'eta_query',
              distance_km: 5.1,
              trust_score: 0.75,
            }),
          ]),
        ),
      });
      const out = (await search({
        capability: 'eta_query',
        location: { lat: 37.7749, lng: -122.4194, radiusKm: 10 },
        limit: 5,
      })) as Extract<ServiceSearchOutcome, { ok: true }>;
      expect(out.response.services).toHaveLength(2);
      expect(out.response.services[0]!.distance_km).toBeLessThan(
        out.response.services[1]!.distance_km,
      );
    });
  });

  // ── rejected event payload pinning ───────────────────────────────────
  // Existing tests pin only the `searched` event. Production emits a
  // `rejected` event with `reason` + `detail` payload across 4
  // distinct paths (invalid_input, network_error, rejected_by_appview,
  // malformed_response). Without these pins, a refactor that swapped
  // reasons or dropped `detail` would silently break per-reason
  // observability dashboards. Same bug class iter-65 closed for
  // service_query_preflight + iter-66 closed for SwrCache.

  describe('events — rejected payloads (full reason taxonomy)', () => {
    interface RejectedEv {
      kind: 'rejected';
      reason: string;
      detail?: string;
    }

    function captureRejected(): {
      events: RejectedEv[];
      onEvent: (e: { kind: string; reason?: string; detail?: string }) => void;
    } {
      const events: RejectedEv[] = [];
      return {
        events,
        onEvent: (e) => {
          if (e.kind === 'rejected') events.push(e as RejectedEv);
        },
      };
    }

    it('rejected.reason="invalid_input" carries the validation detail', async () => {
      const { events, onEvent } = captureRejected();
      const search = createServiceSearchClient({
        fetchFn: stubFetch(okBody()),
        onEvent,
      });
      await search({ capability: 'BAD-CAP' });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('invalid_input');
      expect(events[0]?.detail).toContain('capability');
    });

    it('rejected.reason="network_error" carries the upstream error message', async () => {
      const { events, onEvent } = captureRejected();
      const search = createServiceSearchClient({
        fetchFn: async () => {
          throw new Error('ECONNRESET resolving AppView');
        },
        onEvent,
      });
      await search({});
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('network_error');
      expect(events[0]?.detail).toContain('ECONNRESET');
    });

    it('rejected.reason="rejected_by_appview" carries the upstream error string', async () => {
      const { events, onEvent } = captureRejected();
      const search = createServiceSearchClient({
        fetchFn: stubFetch({ error: 'database is down' }, 503),
        onEvent,
      });
      await search({});
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('rejected_by_appview');
      expect(events[0]?.detail).toBe('database is down');
    });

    it('rejected.reason="rejected_by_appview" with non-string error → "status N" detail', async () => {
      // Counter-pin to the previous test: when the body's error field
      // is missing or non-string, the event's detail falls back to
      // `status N`. Pinning so a refactor can't silently swap to ''
      // (info-loss) or dump the entire raw body (PII leak).
      const { events, onEvent } = captureRejected();
      const search = createServiceSearchClient({
        fetchFn: stubFetch({ error: { nested: 'object' } }, 502),
        onEvent,
      });
      await search({});
      expect(events[0]?.reason).toBe('rejected_by_appview');
      expect(events[0]?.detail).toBe('status 502');
    });

    it('rejected.reason="malformed_response" carries the parse-failure detail', async () => {
      const { events, onEvent } = captureRejected();
      const search = createServiceSearchClient({
        fetchFn: stubFetch({ services: 'not-an-array' }),
        onEvent,
      });
      await search({});
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('malformed_response');
      expect(events[0]?.detail).toContain('services');
    });

    it('successful path emits NO rejected events (clean discrimination)', async () => {
      // Counter-pin: the `rejected` channel is mutually exclusive
      // with `searched`. A refactor that emitted both for an
      // accidentally-overlapping branch (e.g. malformed entry inside
      // an otherwise-valid response) would silently double-count
      // rejection metrics.
      const { events, onEvent } = captureRejected();
      const search = createServiceSearchClient({
        fetchFn: stubFetch(okBody([match()])),
        onEvent,
      });
      await search({ capability: 'eta_query' });
      expect(events).toHaveLength(0);
    });
  });

  // ── total field handling ─────────────────────────────────────────────
  // Production guards `total` with `Number.isInteger(body.total) &&
  // body.total >= 0`, falling back to `services.length` otherwise.
  // The previous tests never exercised these guards — a refactor
  // that loosened to `typeof === 'number'` would let NaN/Infinity/
  // floats through, surfacing nonsensical "247.5 results" pagers in
  // the search UI.

  describe('parseResponse — total field guards', () => {
    it('valid integer total preserved when ≥ services.length', async () => {
      const search = createServiceSearchClient({
        fetchFn: stubFetch({ services: [match()], total: 47 }),
      });
      const out = (await search({})) as Extract<ServiceSearchOutcome, { ok: true }>;
      expect(out.response.total).toBe(47);
      expect(out.response.services).toHaveLength(1);
    });

    it('total=0 with empty services preserved (boundary — must NOT confuse with null)', async () => {
      // Defence against a refactor that wrote `if (!body.total)` —
      // would map 0 → fallback. 0 is meaningful ("no matches") and
      // must surface distinctly from "field missing".
      const search = createServiceSearchClient({
        fetchFn: stubFetch({ services: [], total: 0 }),
      });
      const out = (await search({})) as Extract<ServiceSearchOutcome, { ok: true }>;
      expect(out.response.total).toBe(0);
    });

    it('non-integer total falls back to services.length', async () => {
      const search = createServiceSearchClient({
        fetchFn: stubFetch({ services: [match(), match({ name: 'B' })], total: 5.5 }),
      });
      const out = (await search({})) as Extract<ServiceSearchOutcome, { ok: true }>;
      expect(out.response.total).toBe(2); // services.length
    });

    it('negative total falls back to services.length', async () => {
      const search = createServiceSearchClient({
        fetchFn: stubFetch({ services: [match()], total: -1 }),
      });
      const out = (await search({})) as Extract<ServiceSearchOutcome, { ok: true }>;
      expect(out.response.total).toBe(1);
    });

    it.each([
      ['NaN', Number.NaN],
      ['+Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('non-finite total %s falls back to services.length', async (_label, value) => {
      const search = createServiceSearchClient({
        fetchFn: stubFetch({ services: [match()], total: value }),
      });
      const out = (await search({})) as Extract<ServiceSearchOutcome, { ok: true }>;
      expect(out.response.total).toBe(1);
    });

    it('non-number total falls back to services.length', async () => {
      const search = createServiceSearchClient({
        fetchFn: stubFetch({ services: [match()], total: '5' as unknown as number }),
      });
      const out = (await search({})) as Extract<ServiceSearchOutcome, { ok: true }>;
      expect(out.response.total).toBe(1);
    });

    it('missing total field falls back to services.length', async () => {
      const search = createServiceSearchClient({
        fetchFn: stubFetch({ services: [match(), match({ name: 'B' }), match({ name: 'C' })] }),
      });
      const out = (await search({})) as Extract<ServiceSearchOutcome, { ok: true }>;
      expect(out.response.total).toBe(3);
    });
  });
});
