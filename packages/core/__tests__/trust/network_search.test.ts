/**
 * Trust Network Search — decentralized peer review queries.
 *
 * Source: ARCHITECTURE.md Task 9.3
 */

import {
  searchTrustNetwork,
  registerTrustQueryClient,
  resetTrustQueryClient,
  resetSearchCache,
  type TrustSearchResult,
} from '../../src/trust/network_search';
import { addContact, resetContactDirectory } from '../../src/contacts/directory';
import {
  TrustQueryClient,
  type TrustProfile,
  type QueryResult,
} from '../../src/trust/query_client';

describe('Trust Network Search', () => {
  beforeEach(() => {
    resetContactDirectory();
    resetTrustQueryClient();
    resetSearchCache();
  });

  describe('local contact search', () => {
    it('finds trust data for known contact by name', async () => {
      addContact('did:plc:alice', 'Alice', 'trusted', 'full', 'friend');

      const result = await searchTrustNetwork({
        query: 'Alice',
        type: 'entity_reviews',
      });

      expect(result.totalReviews).toBeGreaterThanOrEqual(1);
      expect(result.fromLocalContacts).toBeGreaterThanOrEqual(1);
      expect(result.reviews[0].reviewerDID).toBe('self');
      expect(result.reviews[0].rating).toBe(5); // trusted → 5 stars
    });

    it('finds contact by DID', async () => {
      addContact('did:plc:bob', 'Bob', 'verified');

      const result = await searchTrustNetwork({
        query: 'did:plc:bob',
        type: 'identity_attestations',
      });

      expect(result.totalReviews).toBeGreaterThanOrEqual(1);
      expect(result.reviews[0].rating).toBe(4); // verified → 4 stars
    });

    it('returns empty for unknown entity', async () => {
      const result = await searchTrustNetwork({
        query: 'Unknown Company',
        type: 'entity_reviews',
      });

      expect(result.totalReviews).toBe(0);
      expect(result.aggregateScore).toBeNull();
    });

    it('includes contact notes as review comment', async () => {
      addContact('did:plc:doctor', 'Dr Smith', 'trusted');
      // The notes field is empty by default, but the review still includes it
      const result = await searchTrustNetwork({
        query: 'Dr Smith',
        type: 'entity_reviews',
      });

      expect(result.reviews.length).toBeGreaterThanOrEqual(1);
    });

    it('blocked contact → low rating', async () => {
      addContact('did:plc:scammer', 'Scammer Inc', 'blocked');

      const result = await searchTrustNetwork({
        query: 'Scammer',
        type: 'entity_reviews',
      });

      expect(result.reviews[0].rating).toBe(1); // blocked → 1 star
    });
  });

  describe('aggregate scoring', () => {
    it('computes weighted average from multiple contacts', async () => {
      addContact('did:plc:c1', 'ProductCo', 'trusted');
      // Searching for "ProductCo" finds the contact
      const result = await searchTrustNetwork({
        query: 'ProductCo',
        type: 'entity_reviews',
      });

      if (result.totalReviews > 0) {
        expect(result.aggregateScore).not.toBeNull();
        expect(result.aggregateScore!).toBeGreaterThanOrEqual(1);
        expect(result.aggregateScore!).toBeLessThanOrEqual(5);
      }
    });

    it('returns null aggregate when no reviews', async () => {
      const result = await searchTrustNetwork({
        query: 'Nonexistent',
        type: 'entity_reviews',
      });
      expect(result.aggregateScore).toBeNull();
    });
  });

  describe('caching', () => {
    it('caches results for subsequent queries', async () => {
      addContact('did:plc:cached', 'CachedEntity', 'verified');

      const result1 = await searchTrustNetwork({
        query: 'CachedEntity',
        type: 'entity_reviews',
      });
      expect(result1.cached).toBe(false);

      const result2 = await searchTrustNetwork({
        query: 'CachedEntity',
        type: 'entity_reviews',
      });
      expect(result2.cached).toBe(true);
      expect(result2.totalReviews).toBe(result1.totalReviews);
    });

    it('cache is case-insensitive', async () => {
      addContact('did:plc:case', 'CaseTest', 'trusted');

      await searchTrustNetwork({ query: 'CaseTest', type: 'entity_reviews' });
      const result = await searchTrustNetwork({ query: 'casetest', type: 'entity_reviews' });
      expect(result.cached).toBe(true);
    });
  });

  describe('network integration (with mock client)', () => {
    it('queries AppView for DID-based identity attestations', async () => {
      const mockProfile: TrustProfile = {
        did: 'did:plc:vendor',
        handle: null,
        overallTrustScore: 0.78,
        attestationSummary: { total: 15, positive: 11, neutral: 3, negative: 1 },
        vouchCount: 4,
        endorsementCount: 6,
        reviewerStats: {
          totalAttestationsBy: 20,
          corroborationRate: 0.8,
          evidenceRate: 0.65,
          helpfulRatio: 0.75,
        },
        activeDomains: ['vendor.example'],
        lastActive: Date.now(),
      };

      const mockClient = {
        queryProfile: jest.fn(
          async (): Promise<QueryResult> => ({
            success: true,
            profile: mockProfile,
          }),
        ),
        queryBatch: jest.fn(),
        toTrustScore: jest.fn(),
      } as unknown as TrustQueryClient;

      registerTrustQueryClient(mockClient);

      const result = await searchTrustNetwork({
        query: 'did:plc:vendor',
        type: 'identity_attestations',
      });

      expect(mockClient.queryProfile).toHaveBeenCalledWith('did:plc:vendor');
      expect(result.fromNetwork).toBeGreaterThan(0);
      expect(result.totalReviews).toBeGreaterThan(0);
    });

    it('handles AppView query failure gracefully', async () => {
      const mockClient = {
        queryProfile: jest.fn(
          async (): Promise<QueryResult> => ({
            success: false,
            error: 'timeout' as const,
          }),
        ),
        queryBatch: jest.fn(),
        toTrustScore: jest.fn(),
      } as unknown as TrustQueryClient;

      registerTrustQueryClient(mockClient);

      const result = await searchTrustNetwork({
        query: 'did:plc:unknown',
        type: 'identity_attestations',
      });

      // Should not throw, returns empty results
      expect(result.fromNetwork).toBe(0);
    });

    it('uses searchAttestations (not getProfile) for free-text queries', async () => {
      const searchSpy = jest.fn(async () => ({
        success: true,
        results: [],
        totalEstimate: 0,
      }));
      const mockClient = {
        queryProfile: jest.fn(),
        queryBatch: jest.fn(),
        searchAttestations: searchSpy,
        toTrustScore: jest.fn(),
      } as unknown as TrustQueryClient;

      registerTrustQueryClient(mockClient);

      // entity_reviews with a name (not DID) should hit search, not getProfile.
      // The previous (TN-LITE-005-pre) behaviour silently skipped AppView
      // entirely for free-text queries; that was a real gap.
      await searchTrustNetwork({ query: 'ProductCo', type: 'entity_reviews' });
      expect(mockClient.queryProfile).not.toHaveBeenCalled();
      expect(searchSpy).toHaveBeenCalledTimes(1);
      expect((searchSpy.mock.calls[0] as unknown[] | undefined)?.[0]).toMatchObject({ q: 'ProductCo' });
    });
  });

  describe('filter overlay (TN-LITE-005)', () => {
    it('routes a filtered DID query through search, not getProfile', async () => {
      const searchSpy = jest.fn(async () => ({
        success: true,
        results: [
          {
            uri: 'at://did:plc:author/com.dina.trust.attestation/1',
            authorDid: 'did:plc:author',
            category: 'product',
            sentiment: 'positive' as const,
            confidence: 'high' as const,
            recordCreatedAt: '2026-01-15T12:00:00.000Z',
          },
        ],
        totalEstimate: 1,
      }));
      const profileSpy = jest.fn();
      const mockClient = {
        queryProfile: profileSpy,
        queryBatch: jest.fn(),
        searchAttestations: searchSpy,
        toTrustScore: jest.fn(),
      } as unknown as TrustQueryClient;

      registerTrustQueryClient(mockClient);

      const result = await searchTrustNetwork({
        query: 'did:plc:vendor',
        type: 'identity_attestations',
        category: 'product',
        sentiment: 'positive',
      });

      expect(profileSpy).not.toHaveBeenCalled();
      expect(searchSpy).toHaveBeenCalledTimes(1);
      const params = (searchSpy.mock.calls[0] as unknown[] | undefined)?.[0] as Record<
        string,
        unknown
      >;
      // The DID is passed as the FTS needle (q), NOT auto-promoted to
      // authorDid. The previous draft routed DID + filters as
      // `authorDid: did` which silently flipped the semantic from
      // "ABOUT this DID" to "BY this DID". Pinning q here guards
      // against that regression.
      expect(params.q).toBe('did:plc:vendor');
      expect(params.authorDid).toBeUndefined();
      expect(params.category).toBe('product');
      expect(params.sentiment).toBe('positive');
      expect(result.fromNetwork).toBe(1);
    });

    it('honours an explicit authorDid filter on a free-text query', async () => {
      const searchSpy = jest.fn(async () => ({
        success: true,
        results: [],
        totalEstimate: 0,
      }));
      const mockClient = {
        queryProfile: jest.fn(),
        queryBatch: jest.fn(),
        searchAttestations: searchSpy,
        toTrustScore: jest.fn(),
      } as unknown as TrustQueryClient;
      registerTrustQueryClient(mockClient);

      await searchTrustNetwork({
        query: 'aeron chair',
        type: 'entity_reviews',
        authorDid: 'did:plc:reviewer',
      });

      const params = (searchSpy.mock.calls[0] as unknown[] | undefined)?.[0] as Record<
        string,
        unknown
      >;
      expect(params.q).toBe('aeron chair');
      expect(params.authorDid).toBe('did:plc:reviewer');
    });

    it('passes through every supported filter field', async () => {
      const searchSpy = jest.fn(async () => ({
        success: true,
        results: [],
        totalEstimate: 0,
      }));
      const mockClient = {
        queryProfile: jest.fn(),
        queryBatch: jest.fn(),
        searchAttestations: searchSpy,
        toTrustScore: jest.fn(),
      } as unknown as TrustQueryClient;
      registerTrustQueryClient(mockClient);

      await searchTrustNetwork({
        query: 'aeron chair',
        type: 'entity_reviews',
        subjectType: 'product',
        category: 'product',
        domain: 'amazon.com',
        sentiment: 'positive',
        authorDid: 'did:plc:reviewer',
        tags: 'verified,evidence',
        minConfidence: 'high',
        since: '2025-01-01T00:00:00.000Z',
        until: '2026-04-29T00:00:00.000Z',
        sort: 'recent',
        limit: 50,
      });

      const params = (searchSpy.mock.calls[0] as unknown[] | undefined)?.[0] as Record<string, unknown>;
      expect(params).toMatchObject({
        q: 'aeron chair',
        subjectType: 'product',
        category: 'product',
        domain: 'amazon.com',
        sentiment: 'positive',
        // authorDid is overridden because the query was free-text and
        // our authorDid filter sticks.
        authorDid: 'did:plc:reviewer',
        tags: 'verified,evidence',
        minConfidence: 'high',
        since: '2025-01-01T00:00:00.000Z',
        until: '2026-04-29T00:00:00.000Z',
        sort: 'recent',
        limit: 50,
      });
    });

    it('cache key fingerprints filters — different filters do not collide', async () => {
      const searchSpy = jest.fn(async () => ({
        success: true,
        results: [],
        totalEstimate: 0,
      }));
      const mockClient = {
        queryProfile: jest.fn(),
        queryBatch: jest.fn(),
        searchAttestations: searchSpy,
        toTrustScore: jest.fn(),
      } as unknown as TrustQueryClient;
      registerTrustQueryClient(mockClient);

      // Same query string + type but different filter set must NOT
      // hit each other's cached row. Pre-TN-LITE-005, the cache key
      // was just `${type}:${query}` and the second call would have
      // been served stale results from the first.
      const r1 = await searchTrustNetwork({
        query: 'chair',
        type: 'entity_reviews',
        sentiment: 'positive',
      });
      const r2 = await searchTrustNetwork({
        query: 'chair',
        type: 'entity_reviews',
        sentiment: 'negative',
      });

      expect(r1.cached).toBe(false);
      expect(r2.cached).toBe(false);
      expect(searchSpy).toHaveBeenCalledTimes(2);
    });

    it('identical filter set hits the cache on the second call', async () => {
      const searchSpy = jest.fn(async () => ({
        success: true,
        results: [],
        totalEstimate: 0,
      }));
      const mockClient = {
        queryProfile: jest.fn(),
        queryBatch: jest.fn(),
        searchAttestations: searchSpy,
        toTrustScore: jest.fn(),
      } as unknown as TrustQueryClient;
      registerTrustQueryClient(mockClient);

      await searchTrustNetwork({
        query: 'chair',
        type: 'entity_reviews',
        sentiment: 'positive',
      });
      const second = await searchTrustNetwork({
        query: 'chair',
        type: 'entity_reviews',
        sentiment: 'positive',
      });
      expect(second.cached).toBe(true);
      expect(searchSpy).toHaveBeenCalledTimes(1);
    });

    it('maps confidence levels onto 1–5 review ratings', async () => {
      const searchSpy = jest.fn(async () => ({
        success: true,
        results: [
          { uri: 'at://x/1', confidence: 'certain' as const },
          { uri: 'at://x/2', confidence: 'high' as const },
          { uri: 'at://x/3', confidence: 'moderate' as const },
          { uri: 'at://x/4', confidence: 'speculative' as const },
        ],
        totalEstimate: 4,
      }));
      const mockClient = {
        queryProfile: jest.fn(),
        queryBatch: jest.fn(),
        searchAttestations: searchSpy,
        toTrustScore: jest.fn(),
      } as unknown as TrustQueryClient;
      registerTrustQueryClient(mockClient);

      const r = await searchTrustNetwork({
        query: 'sample',
        type: 'entity_reviews',
        category: 'product',
      });
      // Reviews come back sorted by reviewerTrust desc — all 50 here,
      // then by recency. Pull them by URI to match input order.
      const byUri = new Map(r.reviews.map((rv) => [rv.comment, rv]));
      expect(byUri.get('Attestation at://x/1')?.rating).toBe(5);
      expect(byUri.get('Attestation at://x/2')?.rating).toBe(4);
      expect(byUri.get('Attestation at://x/3')?.rating).toBe(3);
      expect(byUri.get('Attestation at://x/4')?.rating).toBe(2);
    });
  });

  describe('result structure', () => {
    it('returns all expected fields', async () => {
      const result = await searchTrustNetwork({
        query: 'test',
        type: 'entity_reviews',
      });

      expect(typeof result.query).toBe('string');
      expect(typeof result.type).toBe('string');
      expect(Array.isArray(result.reviews)).toBe(true);
      expect(typeof result.totalReviews).toBe('number');
      expect(typeof result.fromLocalContacts).toBe('number');
      expect(typeof result.fromNetwork).toBe('number');
      expect(typeof result.cached).toBe('boolean');
    });

    it('respects limit parameter', async () => {
      // Add many contacts matching the query
      for (let i = 0; i < 10; i++) {
        addContact(`did:plc:test${i}`, `TestVendor${i}`, 'verified');
      }

      const result = await searchTrustNetwork({
        query: 'TestVendor',
        type: 'entity_reviews',
        limit: 3,
      });

      expect(result.reviews.length).toBeLessThanOrEqual(3);
    });
  });
});
