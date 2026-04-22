/**
 * T9.1 — Trust score query client: fetch from AppView xRPC.
 *
 * Tests use mock fetch — no real AppView calls.
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

const SAMPLE_PROFILE = {
  did: 'did:plc:alice123',
  score: 78,
  attestationCount: 12,
  categories: { product_review: 5, identity_verification: 7 },
  lastUpdated: Date.now(),
  registeredSince: Date.now() - 90 * 86_400_000,
};

describe('TrustQueryClient (9.1)', () => {
  describe('queryProfile', () => {
    it('fetches trust profile from AppView xRPC', async () => {
      const { mockFetch, calls } = createMockFetch(SAMPLE_PROFILE);
      const client = new TrustQueryClient({ fetch: mockFetch });

      const result = await client.queryProfile('did:plc:alice123');

      expect(result.success).toBe(true);
      expect(result.profile!.did).toBe('did:plc:alice123');
      expect(result.profile!.score).toBe(78);
      expect(result.profile!.attestationCount).toBe(12);
      expect(result.profile!.categories.product_review).toBe(5);
      expect(calls[0].url).toContain('app.dina.trust.getProfile');
      expect(calls[0].url).toContain('did=did%3Aplc%3Aalice123');
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

    it('clamps score to [0, 100]', async () => {
      const { mockFetch } = createMockFetch({ ...SAMPLE_PROFILE, score: 150 });
      const client = new TrustQueryClient({ fetch: mockFetch });

      const result = await client.queryProfile('did:plc:test');
      expect(result.profile!.score).toBe(100);
    });

    it('handles NaN score gracefully', async () => {
      const { mockFetch } = createMockFetch({ ...SAMPLE_PROFILE, score: 'not-a-number' });
      const client = new TrustQueryClient({ fetch: mockFetch });

      const result = await client.queryProfile('did:plc:test');
      expect(result.profile!.score).toBe(0);
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
        { ...SAMPLE_PROFILE, did: 'did:plc:a', score: 80 },
        { ...SAMPLE_PROFILE, did: 'did:plc:b', score: 60 },
      ];
      const { mockFetch } = createMockFetch({ profiles });
      const client = new TrustQueryClient({ fetch: mockFetch });

      const results = await client.queryBatch(['did:plc:a', 'did:plc:b']);

      expect(results.size).toBe(2);
      expect(results.get('did:plc:a')!.success).toBe(true);
      expect(results.get('did:plc:a')!.profile!.score).toBe(80);
      expect(results.get('did:plc:b')!.profile!.score).toBe(60);
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
    it('converts TrustProfile to TrustScore for cache', () => {
      const client = new TrustQueryClient();
      const profile: TrustProfile = {
        did: 'did:plc:test',
        score: 85,
        attestationCount: 20,
        categories: { identity_verification: 15 },
        lastUpdated: 1000,
      };

      const score = client.toTrustScore(profile);

      expect(score.did).toBe('did:plc:test');
      expect(score.score).toBe(85);
      expect(score.attestationCount).toBe(20);
      expect(score.lastUpdated).toBe(1000);
    });
  });
});
