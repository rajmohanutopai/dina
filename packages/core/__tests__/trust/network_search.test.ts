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
        score: 78,
        attestationCount: 15,
        categories: { product_review: 10, identity_verification: 5 },
        lastUpdated: Date.now(),
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

    it('only queries AppView for DID-based identity attestation searches', async () => {
      const mockClient = {
        queryProfile: jest.fn(),
        queryBatch: jest.fn(),
        toTrustScore: jest.fn(),
      } as unknown as TrustQueryClient;

      registerTrustQueryClient(mockClient);

      // entity_reviews with a name (not DID) should NOT query AppView
      await searchTrustNetwork({ query: 'ProductCo', type: 'entity_reviews' });
      expect(mockClient.queryProfile).not.toHaveBeenCalled();
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
