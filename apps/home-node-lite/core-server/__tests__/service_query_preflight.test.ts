/**
 * Task 6.24 — service-query pre-flight orchestrator tests.
 */

import {
  DEFAULT_PREFLIGHT_LIMIT,
  createServiceQueryPreflight,
  type PreflightCandidate,
  type PreflightEvent,
  type PreflightOutcome,
  type PreflightRequest,
  type SearchFn,
  type TrustFn,
  type TrustSnapshot,
} from '../src/appview/service_query_preflight';

const DID_A = 'did:plc:abcdefghijklmnopqrstuvwx';
const DID_B = 'did:plc:bcdefghijklmnopqrstuvwxy';
const DID_C = 'did:plc:cdefghijklmnopqrstuvwxyz';

function candidate(overrides: Partial<PreflightCandidate> = {}): PreflightCandidate {
  return {
    operatorDid: DID_A,
    name: 'Alice Service',
    capability: 'eta_query',
    schemaHash: 'a'.repeat(64),
    distanceKm: 2.3,
    ...overrides,
  };
}

function okSearch(candidates: PreflightCandidate[]): SearchFn {
  return async () => ({ ok: true, candidates });
}

function okTrust(perDid: Record<string, TrustSnapshot>): TrustFn {
  return async (did) => {
    if (did in perDid) return { ok: true, snapshot: perDid[did]! };
    return { ok: false, error: `unknown did ${did}` };
  };
}

describe('createServiceQueryPreflight (task 6.24)', () => {
  describe('construction', () => {
    it('throws without searchFn', () => {
      expect(() =>
        createServiceQueryPreflight({
          searchFn: undefined as unknown as SearchFn,
          trustFn: async () => ({ ok: false, error: 'x' }),
        }),
      ).toThrow(/searchFn/);
    });

    it('throws without trustFn', () => {
      expect(() =>
        createServiceQueryPreflight({
          searchFn: okSearch([]),
          trustFn: undefined as unknown as TrustFn,
        }),
      ).toThrow(/trustFn/);
    });

    it('DEFAULT_PREFLIGHT_LIMIT is 5', () => {
      expect(DEFAULT_PREFLIGHT_LIMIT).toBe(5);
    });
  });

  describe('happy path', () => {
    it('one candidate passes → proceed', async () => {
      const preflight = createServiceQueryPreflight({
        searchFn: okSearch([candidate()]),
        trustFn: okTrust({
          [DID_A]: { score: 0.9, confidence: 0.8, ring: 1, flagCount: 0 },
        }),
      });
      const out = (await preflight({
        capability: 'eta_query',
        context: 'read',
      })) as Extract<PreflightOutcome, { ok: true }>;
      expect(out.ok).toBe(true);
      expect(out.verdicts).toHaveLength(1);
      expect(out.verdicts[0]!.decision!.action).toBe('proceed');
      expect(out.hasProceed).toBe(true);
    });

    it('sorts by action, then score, then distance', async () => {
      const preflight = createServiceQueryPreflight({
        searchFn: okSearch([
          candidate({ operatorDid: DID_A, distanceKm: 10 }), // low trust, far
          candidate({ operatorDid: DID_B, distanceKm: 5 }), // high trust, far
          candidate({ operatorDid: DID_C, distanceKm: 1 }), // high trust, close
        ]),
        trustFn: okTrust({
          [DID_A]: { score: 0.4, confidence: 0.5, ring: 3, flagCount: 0 }, // caution
          [DID_B]: { score: 0.85, confidence: 0.9, ring: 1, flagCount: 0 }, // proceed
          [DID_C]: { score: 0.95, confidence: 0.9, ring: 1, flagCount: 0 }, // proceed — higher score
        }),
      });
      const out = (await preflight({
        capability: 'eta_query',
        context: 'read',
      })) as Extract<PreflightOutcome, { ok: true }>;
      // Proceed dids come first, sorted by score desc.
      expect(out.verdicts[0]!.candidate.operatorDid).toBe(DID_C);
      expect(out.verdicts[1]!.candidate.operatorDid).toBe(DID_B);
      expect(out.verdicts[2]!.candidate.operatorDid).toBe(DID_A);
    });

    it('minAction=proceed filters out cautions', async () => {
      const preflight = createServiceQueryPreflight({
        searchFn: okSearch([
          candidate({ operatorDid: DID_A }),
          candidate({ operatorDid: DID_B }),
        ]),
        trustFn: okTrust({
          [DID_A]: { score: 0.9, confidence: 0.8, ring: 1, flagCount: 0 }, // proceed
          [DID_B]: { score: 0.5, confidence: 0.5, ring: 2, flagCount: 0 }, // caution
        }),
      });
      const out = (await preflight({
        capability: 'eta_query',
        context: 'read',
        minAction: 'proceed',
      })) as Extract<PreflightOutcome, { ok: true }>;
      // Only DID_A remains in the filtered-passed set; DID_B drops out.
      const passing = out.verdicts.filter((v) => v.decision?.action === 'proceed');
      expect(passing).toHaveLength(1);
      expect(passing[0]!.candidate.operatorDid).toBe(DID_A);
    });

    it('empty search result → empty verdicts, hasProceed=false', async () => {
      const preflight = createServiceQueryPreflight({
        searchFn: okSearch([]),
        trustFn: okTrust({}),
      });
      const out = (await preflight({
        capability: 'eta_query',
        context: 'read',
      })) as Extract<PreflightOutcome, { ok: true }>;
      expect(out.verdicts).toEqual([]);
      expect(out.hasProceed).toBe(false);
    });

    it('respects limit', async () => {
      let seenLimit: number | undefined;
      const searchFn: SearchFn = async (q) => {
        seenLimit = q.limit;
        return { ok: true, candidates: [candidate(), candidate({ operatorDid: DID_B })] };
      };
      const preflight = createServiceQueryPreflight({
        searchFn,
        trustFn: okTrust({
          [DID_A]: { score: 0.9, confidence: 0.8, flagCount: 0 },
          [DID_B]: { score: 0.9, confidence: 0.8, flagCount: 0 },
        }),
      });
      await preflight({
        capability: 'eta_query',
        context: 'read',
        limit: 1,
      });
      expect(seenLimit).toBe(1);
    });

    it('passes location hint to search', async () => {
      let seenLocation: unknown = null;
      const searchFn: SearchFn = async (q) => {
        seenLocation = q.location ?? null;
        return { ok: true, candidates: [] };
      };
      const preflight = createServiceQueryPreflight({
        searchFn,
        trustFn: okTrust({}),
      });
      await preflight({
        capability: 'eta_query',
        context: 'read',
        location: { lat: 37.77, lng: -122.41 },
      });
      expect(seenLocation).toEqual({ lat: 37.77, lng: -122.41 });
    });

    it('context=transaction tightens threshold (proceed → caution)', async () => {
      // score=0.7 × transaction(0.9) = 0.63 → caution (below 0.7 proceed threshold).
      const preflight = createServiceQueryPreflight({
        searchFn: okSearch([candidate()]),
        trustFn: okTrust({
          [DID_A]: { score: 0.7, confidence: 0.8, flagCount: 0 },
        }),
      });
      const out = (await preflight({
        capability: 'eta_query',
        context: 'transaction',
      })) as Extract<PreflightOutcome, { ok: true }>;
      expect(out.verdicts[0]!.decision!.action).toBe('caution');
    });
  });

  describe('failures', () => {
    it('search_failed propagates + no trust calls', async () => {
      let trustCalls = 0;
      const searchFn: SearchFn = async () => ({ ok: false, error: 'appview down' });
      const trustFn: TrustFn = async () => {
        trustCalls++;
        return { ok: true, snapshot: { score: 1, confidence: 1, flagCount: 0 } };
      };
      const preflight = createServiceQueryPreflight({ searchFn, trustFn });
      const out = await preflight({ capability: 'eta_query', context: 'read' });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'search_failed') {
        expect(out.error).toMatch(/appview down/);
      }
      expect(trustCalls).toBe(0);
    });

    it('per-candidate trust_failed does NOT kill the outcome', async () => {
      const trustFn: TrustFn = async (did) => {
        if (did === DID_A) return { ok: false, error: 'trust offline' };
        return {
          ok: true,
          snapshot: { score: 0.9, confidence: 0.9, flagCount: 0 },
        };
      };
      const preflight = createServiceQueryPreflight({
        searchFn: okSearch([candidate({ operatorDid: DID_A }), candidate({ operatorDid: DID_B })]),
        trustFn,
      });
      const out = (await preflight({
        capability: 'eta_query',
        context: 'read',
      })) as Extract<PreflightOutcome, { ok: true }>;
      expect(out.verdicts).toHaveLength(2);
      // DID_B (success) comes first, DID_A (failed) at the back.
      expect(out.verdicts[0]!.candidate.operatorDid).toBe(DID_B);
      expect(out.verdicts[0]!.decision!.action).toBe('proceed');
      expect(out.verdicts[1]!.candidate.operatorDid).toBe(DID_A);
      expect(out.verdicts[1]!.decision).toBeNull();
      expect(out.verdicts[1]!.error).toMatch(/trust offline/);
    });
  });

  describe('input validation', () => {
    it.each([
      ['invalid capability', { capability: 'BAD-CAP', context: 'read' }],
      ['uppercase capability', { capability: 'ETA', context: 'read' }],
      ['invalid context', {
        capability: 'eta_query',
        context: 'nonsense' as unknown as 'read',
      }],
      ['limit too big', { capability: 'eta_query', context: 'read', limit: 100 }],
      ['limit < 1', { capability: 'eta_query', context: 'read', limit: 0 }],
      ['non-integer limit', { capability: 'eta_query', context: 'read', limit: 1.5 }],
      ['bad minAction', {
        capability: 'eta_query',
        context: 'read',
        minAction: 'bogus' as unknown as 'proceed',
      }],
    ])('rejects %s', async (_label, input) => {
      const preflight = createServiceQueryPreflight({
        searchFn: okSearch([]),
        trustFn: okTrust({}),
      });
      const out = await preflight(input as PreflightRequest);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid_input');
    });
  });

  describe('parallelism', () => {
    it('trust calls run in parallel', async () => {
      const startTimes: number[] = [];
      const trustFn: TrustFn = async () => {
        startTimes.push(Date.now());
        await new Promise((r) => setTimeout(r, 20));
        return {
          ok: true,
          snapshot: { score: 0.9, confidence: 0.8, flagCount: 0 },
        };
      };
      const preflight = createServiceQueryPreflight({
        searchFn: okSearch([
          candidate({ operatorDid: DID_A }),
          candidate({ operatorDid: DID_B }),
          candidate({ operatorDid: DID_C }),
        ]),
        trustFn,
      });
      await preflight({ capability: 'eta_query', context: 'read' });
      // All three calls should start within ~5ms (parallel), not serial.
      expect(startTimes).toHaveLength(3);
      expect(startTimes[2]! - startTimes[0]!).toBeLessThan(10);
    });
  });

  describe('events', () => {
    it('fires candidate_evaluated + completed', async () => {
      const events: PreflightEvent[] = [];
      const preflight = createServiceQueryPreflight({
        searchFn: okSearch([candidate()]),
        trustFn: okTrust({
          [DID_A]: { score: 0.9, confidence: 0.8, flagCount: 0 },
        }),
        onEvent: (e) => events.push(e),
      });
      await preflight({ capability: 'eta_query', context: 'read' });
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain('candidate_evaluated');
      expect(kinds).toContain('completed');
    });

    it('fires search_failed on search error', async () => {
      const events: PreflightEvent[] = [];
      const preflight = createServiceQueryPreflight({
        searchFn: async () => ({ ok: false, error: 'down' }),
        trustFn: okTrust({}),
        onEvent: (e) => events.push(e),
      });
      await preflight({ capability: 'eta_query', context: 'read' });
      expect(events.some((e) => e.kind === 'search_failed')).toBe(true);
    });

    it('fires trust_failed per-candidate', async () => {
      const events: PreflightEvent[] = [];
      const preflight = createServiceQueryPreflight({
        searchFn: okSearch([candidate()]),
        trustFn: async () => ({ ok: false, error: 'trust down' }),
        onEvent: (e) => events.push(e),
      });
      await preflight({ capability: 'eta_query', context: 'read' });
      expect(events.some((e) => e.kind === 'trust_failed')).toBe(true);
    });
  });

  describe('realistic scenario: SF-transit pre-flight', () => {
    it('picks the nearest high-trust provider', async () => {
      const preflight = createServiceQueryPreflight({
        searchFn: okSearch([
          candidate({
            operatorDid: DID_A,
            name: 'SF Transit Authority',
            distanceKm: 2.3,
          }),
          candidate({
            operatorDid: DID_B,
            name: 'Alternative Muni',
            distanceKm: 5.1,
          }),
        ]),
        trustFn: okTrust({
          [DID_A]: { score: 0.92, confidence: 0.88, ring: 2, flagCount: 0 },
          [DID_B]: { score: 0.75, confidence: 0.7, ring: 3, flagCount: 0 },
        }),
      });
      const out = (await preflight({
        capability: 'eta_query',
        context: 'read',
        location: { lat: 37.77, lng: -122.41 },
      })) as Extract<PreflightOutcome, { ok: true }>;
      expect(out.hasProceed).toBe(true);
      expect(out.verdicts[0]!.candidate.operatorDid).toBe(DID_A);
    });
  });
});
