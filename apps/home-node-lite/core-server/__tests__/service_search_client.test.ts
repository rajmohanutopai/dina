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
});
