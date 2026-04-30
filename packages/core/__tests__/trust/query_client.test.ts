/**
 * T9.1 — Trust score query client: fetch from AppView xRPC.
 *
 * Tests use mock fetch — no real AppView calls. The mock body matches
 * AppView's `GetProfileResponse` shape from
 * `appview/src/shared/types/api-types.ts`. Drift between this fixture
 * and the real AppView contract is the regression class this file
 * guards.
 *
 * Source: ARCHITECTURE.md Task 9.1
 */

import {
  TrustQueryClient,
  type TrustProfile,
  type QueryResult,
} from '../../src/trust/query_client';

function createMockFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; method: string }> = [];
  const mockFetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, method: init?.method ?? 'GET' });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  return { mockFetch, calls };
}

const SAMPLE_LAST_ACTIVE_ISO = '2026-01-15T12:00:00.000Z';
const SAMPLE_LAST_ACTIVE_MS = Date.parse(SAMPLE_LAST_ACTIVE_ISO);

const SAMPLE_PROFILE = {
  did: 'did:plc:alice123',
  overallTrustScore: 0.78,
  attestationSummary: { total: 12, positive: 9, neutral: 2, negative: 1 },
  vouchCount: 3,
  endorsementCount: 5,
  reviewerStats: {
    totalAttestationsBy: 22,
    corroborationRate: 0.81,
    evidenceRate: 0.66,
    helpfulRatio: 0.74,
  },
  activeDomains: ['example.com', 'review.org'],
  lastActive: SAMPLE_LAST_ACTIVE_ISO,
};

describe('TrustQueryClient (9.1)', () => {
  describe('queryProfile', () => {
    it('fetches trust profile from AppView xRPC', async () => {
      const { mockFetch, calls } = createMockFetch(SAMPLE_PROFILE);
      const client = new TrustQueryClient({ fetch: mockFetch });

      const result = await client.queryProfile('did:plc:alice123');

      expect(result.success).toBe(true);
      expect(result.profile!.did).toBe('did:plc:alice123');
      expect(result.profile!.overallTrustScore).toBeCloseTo(0.78);
      expect(result.profile!.attestationSummary.total).toBe(12);
      expect(result.profile!.attestationSummary.positive).toBe(9);
      expect(result.profile!.vouchCount).toBe(3);
      expect(result.profile!.endorsementCount).toBe(5);
      expect(result.profile!.activeDomains).toEqual(['example.com', 'review.org']);
      expect(result.profile!.lastActive).toBe(SAMPLE_LAST_ACTIVE_MS);
      expect(calls[0].url).toContain('com.dina.trust.getProfile');
      expect(calls[0].url).toContain('did=did%3Aplc%3Aalice123');
    });

    it('preserves null overallTrustScore (unscored DID)', async () => {
      const { mockFetch } = createMockFetch({ ...SAMPLE_PROFILE, overallTrustScore: null });
      const client = new TrustQueryClient({ fetch: mockFetch });

      const result = await client.queryProfile('did:plc:test');
      expect(result.profile!.overallTrustScore).toBeNull();
    });

    it('returns not_found for 404', async () => {
      const { mockFetch } = createMockFetch({}, 404);
      const client = new TrustQueryClient({ fetch: mockFetch });

      const result = await client.queryProfile('did:plc:unknown');

      expect(result.success).toBe(false);
      expect(result.error).toBe('not_found');
    });

    it('returns server_error for 500', async () => {
      const { mockFetch } = createMockFetch({}, 500);
      const client = new TrustQueryClient({ fetch: mockFetch });

      const result = await client.queryProfile('did:plc:test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('server_error');
      expect(result.errorMessage).toContain('500');
    });

    it('returns network error on fetch failure', async () => {
      const failFetch = jest.fn(async () => {
        throw new Error('connection refused');
      }) as unknown as typeof globalThis.fetch;
      const client = new TrustQueryClient({ fetch: failFetch });

      const result = await client.queryProfile('did:plc:test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('network');
    });

    it('returns timeout error on abort', async () => {
      const timeoutFetch = jest.fn(async () => {
        throw new Error('The operation was aborted due to timeout');
      }) as unknown as typeof globalThis.fetch;
      const client = new TrustQueryClient({ fetch: timeoutFetch });

      const result = await client.queryProfile('did:plc:slow');

      expect(result.success).toBe(false);
      expect(result.error).toBe('timeout');
    });

    it('returns error for empty DID', async () => {
      const client = new TrustQueryClient({ fetch: createMockFetch({}).mockFetch });
      const result = await client.queryProfile('');
      expect(result.success).toBe(false);
    });

    it('clamps overallTrustScore to [0, 1]', async () => {
      const { mockFetch: highMock } = createMockFetch({ ...SAMPLE_PROFILE, overallTrustScore: 1.5 });
      const high = await new TrustQueryClient({ fetch: highMock }).queryProfile('did:plc:test');
      expect(high.profile!.overallTrustScore).toBe(1);

      const { mockFetch: lowMock } = createMockFetch({ ...SAMPLE_PROFILE, overallTrustScore: -0.4 });
      const low = await new TrustQueryClient({ fetch: lowMock }).queryProfile('did:plc:test');
      expect(low.profile!.overallTrustScore).toBe(0);
    });

    it('treats non-numeric overallTrustScore as null (renders as "unrated")', async () => {
      const { mockFetch } = createMockFetch({ ...SAMPLE_PROFILE, overallTrustScore: 'not-a-number' });
      const client = new TrustQueryClient({ fetch: mockFetch });

      const result = await client.queryProfile('did:plc:test');
      expect(result.profile!.overallTrustScore).toBeNull();
    });

    it('handles a missing lastActive as null', async () => {
      const { mockFetch } = createMockFetch({ ...SAMPLE_PROFILE, lastActive: null });
      const client = new TrustQueryClient({ fetch: mockFetch });

      const result = await client.queryProfile('did:plc:test');
      expect(result.profile!.lastActive).toBeNull();
    });

    it('parses lastActive ISO strings into ms', async () => {
      const { mockFetch } = createMockFetch(SAMPLE_PROFILE);
      const client = new TrustQueryClient({ fetch: mockFetch });

      const result = await client.queryProfile('did:plc:test');
      expect(result.profile!.lastActive).toBe(SAMPLE_LAST_ACTIVE_MS);
    });

    it('clamps reviewer ratio fields to [0, 1] and floors counts at 0', async () => {
      const { mockFetch } = createMockFetch({
        ...SAMPLE_PROFILE,
        vouchCount: -3,
        reviewerStats: {
          totalAttestationsBy: -5,
          corroborationRate: 1.4,
          evidenceRate: -0.2,
          helpfulRatio: 0.5,
        },
      });
      const client = new TrustQueryClient({ fetch: mockFetch });

      const result = await client.queryProfile('did:plc:test');
      expect(result.profile!.vouchCount).toBe(0);
      expect(result.profile!.reviewerStats.totalAttestationsBy).toBe(0);
      expect(result.profile!.reviewerStats.corroborationRate).toBe(1);
      expect(result.profile!.reviewerStats.evidenceRate).toBe(0);
      expect(result.profile!.reviewerStats.helpfulRatio).toBe(0.5);
    });

    it('uses custom AppView URL', async () => {
      const { mockFetch, calls } = createMockFetch(SAMPLE_PROFILE);
      const client = new TrustQueryClient({
        appviewURL: 'https://custom.appview.com',
        fetch: mockFetch,
      });

      await client.queryProfile('did:plc:test');
      expect(calls[0].url).toContain('custom.appview.com');
    });
  });

  describe('queryBatch', () => {
    it('queries multiple DIDs via batch endpoint', async () => {
      const profiles = [
        { ...SAMPLE_PROFILE, did: 'did:plc:a', overallTrustScore: 0.8 },
        { ...SAMPLE_PROFILE, did: 'did:plc:b', overallTrustScore: 0.6 },
      ];
      const { mockFetch, calls } = createMockFetch({ profiles });
      const client = new TrustQueryClient({ fetch: mockFetch });

      const results = await client.queryBatch(['did:plc:a', 'did:plc:b']);

      expect(results.size).toBe(2);
      expect(results.get('did:plc:a')!.success).toBe(true);
      expect(results.get('did:plc:a')!.profile!.overallTrustScore).toBeCloseTo(0.8);
      expect(results.get('did:plc:b')!.profile!.overallTrustScore).toBeCloseTo(0.6);
      // Wire-format regression guard: the batch endpoint must use the
      // canonical NSID. AppView does not yet register `getProfiles`
      // (see comment in `query_client.ts.queryBatch`), but if/when it
      // does, the path must already be on the wire.
      expect(calls[0].url).toContain('com.dina.trust.getProfiles');
      expect(calls[0].method).toBe('POST');
    });

    it('marks missing DIDs as not_found', async () => {
      const profiles = [{ ...SAMPLE_PROFILE, did: 'did:plc:a' }];
      const { mockFetch } = createMockFetch({ profiles });
      const client = new TrustQueryClient({ fetch: mockFetch });

      const results = await client.queryBatch(['did:plc:a', 'did:plc:missing']);

      expect(results.get('did:plc:a')!.success).toBe(true);
      expect(results.get('did:plc:missing')!.success).toBe(false);
      expect(results.get('did:plc:missing')!.error).toBe('not_found');
    });

    it('falls back to individual queries on batch failure', async () => {
      let callCount = 0;
      const mockFetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
        callCount++;
        if (init?.method === 'POST') throw new Error('batch not supported');
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...SAMPLE_PROFILE, did: 'did:plc:a' }),
        } as unknown as Response;
      });

      const client = new TrustQueryClient({ fetch: mockFetch });
      const results = await client.queryBatch(['did:plc:a']);

      expect(results.get('did:plc:a')!.success).toBe(true);
      expect(callCount).toBe(2); // 1 batch (failed) + 1 individual
    });

    it('returns empty map for empty input', async () => {
      const client = new TrustQueryClient({ fetch: createMockFetch({}).mockFetch });
      const results = await client.queryBatch([]);
      expect(results.size).toBe(0);
    });
  });

  describe('toTrustScore', () => {
    it('projects TrustProfile to slim cache shape', () => {
      const client = new TrustQueryClient();
      const profile: TrustProfile = {
        did: 'did:plc:test',
        overallTrustScore: 0.85,
        attestationSummary: { total: 20, positive: 18, neutral: 1, negative: 1 },
        vouchCount: 2,
        endorsementCount: 4,
        reviewerStats: {
          totalAttestationsBy: 30,
          corroborationRate: 0.8,
          evidenceRate: 0.6,
          helpfulRatio: 0.7,
        },
        activeDomains: ['example.com'],
        lastActive: 1000,
      };

      const score = client.toTrustScore(profile);

      expect(score.did).toBe('did:plc:test');
      expect(score.score).toBe(0.85);
      expect(score.attestationCount).toBe(20);
      expect(score.lastUpdated).toBe(1000);
    });

    it('preserves null score for an unscored profile', () => {
      const client = new TrustQueryClient();
      const profile: TrustProfile = {
        did: 'did:plc:test',
        overallTrustScore: null,
        attestationSummary: { total: 0, positive: 0, neutral: 0, negative: 0 },
        vouchCount: 0,
        endorsementCount: 0,
        reviewerStats: {
          totalAttestationsBy: 0,
          corroborationRate: 0,
          evidenceRate: 0,
          helpfulRatio: 0,
        },
        activeDomains: [],
        lastActive: null,
      };

      const score = client.toTrustScore(profile);
      expect(score.score).toBeNull();
      expect(score.attestationCount).toBe(0);
      // Falls back to Date.now() — just assert it's a number.
      expect(typeof score.lastUpdated).toBe('number');
    });
  });

  describe('searchAttestations (TN-LITE-005)', () => {
    const SAMPLE_HIT = {
      uri: 'at://did:plc:author/com.dina.trust.attestation/3k8',
      cid: 'bafy...',
      authorDid: 'did:plc:author',
      subjectId: 'subj-1',
      category: 'product',
      domain: 'amazon.com',
      sentiment: 'positive',
      confidence: 'high',
      tags: ['evidence'],
      recordCreatedAt: '2026-01-15T12:00:00.000Z',
    };

    it('hits the search xRPC and parses result rows', async () => {
      const { mockFetch, calls } = createMockFetch({
        results: [SAMPLE_HIT],
        cursor: '2026-01-15T12:00:00.000Z::at://x/y',
        totalEstimate: 1,
      });
      const client = new TrustQueryClient({ fetch: mockFetch });
      const r = await client.searchAttestations({
        q: 'aeron',
        category: 'product',
        sentiment: 'positive',
      });
      expect(r.success).toBe(true);
      expect(r.results).toHaveLength(1);
      expect(r.results[0]?.uri).toBe(SAMPLE_HIT.uri);
      expect(r.cursor).toBe('2026-01-15T12:00:00.000Z::at://x/y');
      expect(r.totalEstimate).toBe(1);
      expect(calls[0]?.url).toContain('com.dina.trust.search');
    });

    it('serialises params alphabetically for cache stability', async () => {
      const { mockFetch, calls } = createMockFetch({ results: [], totalEstimate: 0 });
      const client = new TrustQueryClient({ fetch: mockFetch });
      await client.searchAttestations({
        q: 'chair',
        category: 'product',
        sort: 'recent',
        limit: 10,
      });
      const url = calls[0]?.url ?? '';
      const qs = url.slice(url.indexOf('?') + 1);
      // Keys must appear in sorted order.
      const keys = qs.split('&').map((kv) => kv.split('=')[0]);
      const sorted = [...keys].sort();
      expect(keys).toEqual(sorted);
    });

    it('omits undefined and empty-string params from the URL', async () => {
      const { mockFetch, calls } = createMockFetch({ results: [], totalEstimate: 0 });
      const client = new TrustQueryClient({ fetch: mockFetch });
      await client.searchAttestations({
        q: 'aeron',
        category: '',
        domain: undefined,
      });
      const url = calls[0]?.url ?? '';
      expect(url).toContain('q=aeron');
      expect(url).not.toContain('category=');
      expect(url).not.toContain('domain=');
    });

    it('classifies HTTP 404 as not_found', async () => {
      const { mockFetch } = createMockFetch({}, 404);
      const client = new TrustQueryClient({ fetch: mockFetch });
      const r = await client.searchAttestations({ q: 'nope' });
      expect(r.success).toBe(false);
      expect(r.error).toBe('not_found');
    });

    it('classifies HTTP 500 as server_error', async () => {
      const { mockFetch } = createMockFetch({}, 500);
      const client = new TrustQueryClient({ fetch: mockFetch });
      const r = await client.searchAttestations({ q: 'broken' });
      expect(r.success).toBe(false);
      expect(r.error).toBe('server_error');
    });

    it('classifies abort errors as timeout', async () => {
      const failFetch = jest.fn(async () => {
        throw new Error('The operation was aborted due to timeout');
      }) as unknown as typeof globalThis.fetch;
      const client = new TrustQueryClient({ fetch: failFetch });
      const r = await client.searchAttestations({ q: 'slow' });
      expect(r.success).toBe(false);
      expect(r.error).toBe('timeout');
    });

    it('preserves unknown row fields via index signature', async () => {
      const { mockFetch } = createMockFetch({
        results: [{ uri: 'at://x', futureField: 'forward-compat' }],
        totalEstimate: 1,
      });
      const client = new TrustQueryClient({ fetch: mockFetch });
      const r = await client.searchAttestations({ q: 'x' });
      expect((r.results[0] as Record<string, unknown>).futureField).toBe('forward-compat');
    });
  });
});
