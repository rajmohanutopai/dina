/**
 * Task 6.11 — trust resolve xRPC client tests.
 */

import {
  createTrustResolveClient,
  type TrustResolveFetchFn,
  type TrustResolveOutcome,
  type XrpcFetchResult,
} from '../src/appview/trust_resolve_client';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';

function okBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    did: DID,
    scores: {
      weightedScore: 0.85,
      confidence: 0.9,
      totalAttestations: 10,
      positive: 8,
      negative: 2,
      verifiedAttestationCount: 5,
    },
    didProfile: {
      overallTrustScore: 0.8,
      vouchCount: 3,
      activeFlagCount: 0,
      tombstoneCount: 0,
    },
    flags: [{ flagType: 'spam', severity: 'warning' }],
    graphContext: {
      shortestPath: 2,
      trustedAttestors: ['did:plc:friend', 'did:plc:trusted'],
    },
    authenticity: { predominantAssessment: 'human', confidence: 0.95 },
    context: 'read',
    ...overrides,
  };
}

function stubFetch(body: Record<string, unknown> | null, status = 200): TrustResolveFetchFn {
  return async () => ({ body, status });
}

describe('createTrustResolveClient (task 6.11)', () => {
  describe('construction', () => {
    it('throws without fetchFn', () => {
      expect(() =>
        createTrustResolveClient({
          fetchFn: undefined as unknown as TrustResolveFetchFn,
        }),
      ).toThrow(/fetchFn/);
    });
  });

  describe('happy path', () => {
    it('parses a full response', async () => {
      const resolve = createTrustResolveClient({ fetchFn: stubFetch(okBody()) });
      const out = (await resolve({ did: DID, context: 'read' })) as Extract<
        TrustResolveOutcome,
        { ok: true }
      >;
      expect(out.ok).toBe(true);
      expect(out.response.did).toBe(DID);
      expect(out.response.scores?.weightedScore).toBe(0.85);
      expect(out.response.flags).toHaveLength(1);
      expect(out.response.graphContext?.shortestPath).toBe(2);
      expect(out.response.authenticity?.predominantAssessment).toBe('human');
    });

    it('supports did:web', async () => {
      const webDid = 'did:web:example.com';
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({ ...okBody(), did: webDid }),
      });
      const out = await resolve({ did: webDid });
      expect(out.ok).toBe(true);
    });

    it('null scores / graphContext gracefully become null', async () => {
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({
          did: DID,
          scores: null,
          graphContext: null,
          flags: [],
          authenticity: null,
          didProfile: null,
        }),
      });
      const out = (await resolve({ did: DID })) as Extract<TrustResolveOutcome, { ok: true }>;
      expect(out.ok).toBe(true);
      expect(out.response.scores).toBeNull();
      expect(out.response.graphContext).toBeNull();
      expect(out.response.authenticity).toBeNull();
      expect(out.response.didProfile).toBeNull();
    });

    it('partial score fields: non-numeric → null', async () => {
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({
          ...okBody(),
          scores: {
            weightedScore: 0.5,
            confidence: 'wrong' as unknown as number,
            totalAttestations: 'huh' as unknown as number,
          },
        }),
      });
      const out = (await resolve({ did: DID })) as Extract<TrustResolveOutcome, { ok: true }>;
      expect(out.response.scores?.weightedScore).toBe(0.5);
      expect(out.response.scores?.confidence).toBeNull();
      expect(out.response.scores?.totalAttestations).toBeNull();
    });

    it('flags with invalid severity are skipped', async () => {
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({
          ...okBody(),
          flags: [
            { flagType: 'spam', severity: 'warning' },
            { flagType: 'weird', severity: 'unknown-severity' },
            null,
            { flagType: 'real', severity: 'critical' },
          ],
        }),
      });
      const out = (await resolve({ did: DID })) as Extract<TrustResolveOutcome, { ok: true }>;
      expect(out.response.flags).toHaveLength(2);
      expect(out.response.flags[0]!.severity).toBe('warning');
      expect(out.response.flags[1]!.flagType).toBe('real');
    });

    it('fires resolved event', async () => {
      type Ev = { kind: 'resolved'; did: string; hasScores: boolean };
      const events: Ev[] = [];
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch(okBody()),
        onEvent: (e) => {
          if (e.kind === 'resolved') events.push(e);
        },
      });
      await resolve({ did: DID });
      expect(events[0]!.did).toBe(DID);
      expect(events[0]!.hasScores).toBe(true);
    });
  });

  describe('rejections', () => {
    it('invalid did → ok:false, no fetch', async () => {
      let calls = 0;
      const resolve = createTrustResolveClient({
        fetchFn: async () => {
          calls++;
          return { body: okBody(), status: 200 };
        },
      });
      const out = await resolve({ did: 'did:bad:x' });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid_did');
      expect(calls).toBe(0);
    });

    it('404 → not_found', async () => {
      const resolve = createTrustResolveClient({ fetchFn: stubFetch(null, 404) });
      const out = await resolve({ did: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('not_found');
    });

    it('null body on 200 → not_found', async () => {
      const resolve = createTrustResolveClient({ fetchFn: stubFetch(null, 200) });
      const out = await resolve({ did: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('not_found');
    });

    it('5xx → rejected_by_appview', async () => {
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({ error: 'database down' }, 503),
      });
      const out = await resolve({ did: DID });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'rejected_by_appview') {
        expect(out.status).toBe(503);
        expect(out.error).toMatch(/database down/);
      }
    });

    it('fetch throw → network_error', async () => {
      const resolve = createTrustResolveClient({
        fetchFn: async () => {
          throw new Error('ENETDOWN');
        },
      });
      const out = await resolve({ did: DID });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'network_error') {
        expect(out.error).toMatch(/ENETDOWN/);
      }
    });

    it('body did mismatch → malformed_response', async () => {
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({ ...okBody(), did: 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz' }),
      });
      const out = await resolve({ did: DID });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'malformed_response') {
        expect(out.detail).toMatch(/does not match requested/);
      }
    });

    it('missing did in body → malformed_response', async () => {
      const resolve = createTrustResolveClient({
        fetchFn: stubFetch({ scores: null }),
      });
      const out = await resolve({ did: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });
  });
});
