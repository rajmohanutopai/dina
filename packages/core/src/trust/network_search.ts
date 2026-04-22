/**
 * Trust Network Search — query decentralized peer reviews about entities.
 *
 * Searches the AT Protocol trust network for peer reviews, attestations,
 * and reputation data about a specific entity (person, product, vendor).
 *
 * Search types:
 *   - entity_reviews: peer reviews about a product/service/vendor
 *   - identity_attestations: identity verification attestations for a DID
 *   - topic_trust: aggregate trust signal for a topic/category
 *
 * Results are aggregated from:
 *   1. Local contact trust levels (immediate ring)
 *   2. AppView xRPC queries (extended network, cached)
 *   3. PDS attestation records (cryptographic proofs)
 *
 * Source: ARCHITECTURE.md Task 9.3
 */

import { getCachedTrust, cacheTrustScore, type TrustScore } from './cache';
import { type TrustQueryClient, type TrustProfile, type QueryResult } from './query_client';
import { listContacts, getContact, resolveByName, type Contact } from '../contacts/directory';
import { TRUST_CACHE_TTL_MS } from '../constants';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export type SearchType = 'entity_reviews' | 'identity_attestations' | 'topic_trust';

export interface TrustSearchQuery {
  /** What to search for: entity name, DID, or topic. */
  query: string;
  /** Type of trust data to search for. */
  type: SearchType;
  /** Maximum results to return. */
  limit?: number;
}

export interface TrustReview {
  reviewerDID: string;
  reviewerName?: string;
  reviewerTrust: number; // 0-100, how trusted the reviewer is
  rating: number; // 1-5 stars
  category: string; // product_review, identity_verification, etc.
  comment?: string;
  timestamp: number;
}

export interface TrustSearchResult {
  query: string;
  type: SearchType;
  reviews: TrustReview[];
  aggregateScore: number | null; // weighted average (null if no data)
  totalReviews: number;
  fromLocalContacts: number;
  fromNetwork: number;
  cached: boolean;
}

// ---------------------------------------------------------------
// Injectable AppView client
// ---------------------------------------------------------------

let queryClient: TrustQueryClient | null = null;

/** Register the AppView trust query client. */
export function registerTrustQueryClient(client: TrustQueryClient): void {
  queryClient = client;
}

/** Reset the client (for testing). */
export function resetTrustQueryClient(): void {
  queryClient = null;
}

// ---------------------------------------------------------------
// Search result cache
// ---------------------------------------------------------------

const searchCache = new Map<string, { result: TrustSearchResult; cachedAt: number }>();

function getCachedSearch(key: string, now?: number): TrustSearchResult | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  const currentTime = now ?? Date.now();
  if (currentTime - entry.cachedAt > TRUST_CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return entry.result;
}

function cacheSearch(key: string, result: TrustSearchResult): void {
  searchCache.set(key, { result, cachedAt: Date.now() });
}

/** Reset search cache (for testing). */
export function resetSearchCache(): void {
  searchCache.clear();
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Search the trust network for reviews/attestations about an entity.
 *
 * Aggregates trust data from:
 * 1. Local contacts (immediate trust ring — highest weight)
 * 2. AppView network (extended peer reviews — lower weight)
 *
 * Results are weighted by reviewer trust level:
 *   - Trusted contacts (ring 1): weight 1.0
 *   - Verified contacts: weight 0.8
 *   - Network attestations: weight 0.5
 *   - Unknown reviewers: weight 0.2
 */
export async function searchTrustNetwork(query: TrustSearchQuery): Promise<TrustSearchResult> {
  const limit = query.limit ?? 20;
  const cacheKey = `${query.type}:${query.query.toLowerCase()}`;

  // Check cache first
  const cached = getCachedSearch(cacheKey);
  if (cached) return { ...cached, cached: true };

  const reviews: TrustReview[] = [];
  let fromLocalContacts = 0;
  let fromNetwork = 0;

  // 1. Search local contacts for trust data
  const localReviews = searchLocalContacts(query);
  reviews.push(...localReviews);
  fromLocalContacts = localReviews.length;

  // 2. Search AppView network (if client registered)
  if (queryClient) {
    try {
      // Resolve query to DID: direct DID or name-based lookup
      let targetDID: string | null = null;
      if (query.query.startsWith('did:')) {
        targetDID = query.query;
      } else {
        const contact = resolveByName(query.query);
        if (contact) targetDID = contact.did;
      }

      if (targetDID) {
        const profileResult = await queryClient.queryProfile(targetDID);
        if (profileResult.success && profileResult.profile) {
          const networkReviews = profileToReviews(profileResult.profile);
          reviews.push(...networkReviews);
          fromNetwork = networkReviews.length;
        }
      }
    } catch {
      // Network query failed — proceed with local data only
    }
  }

  // 3. Sort by reviewer trust (most trusted first), then by recency
  reviews.sort((a, b) => {
    if (b.reviewerTrust !== a.reviewerTrust) return b.reviewerTrust - a.reviewerTrust;
    return b.timestamp - a.timestamp;
  });

  // 4. Limit results
  const limited = reviews.slice(0, limit);

  // 5. Compute weighted aggregate score
  const aggregateScore = computeWeightedAggregate(limited);

  const result: TrustSearchResult = {
    query: query.query,
    type: query.type,
    reviews: limited,
    aggregateScore,
    totalReviews: limited.length,
    fromLocalContacts,
    fromNetwork,
    cached: false,
  };

  cacheSearch(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------
// Internal: local contact trust search
// ---------------------------------------------------------------

/**
 * Search local contacts for trust signals relevant to the query.
 *
 * If the query matches a contact name/alias, returns trust data
 * about that contact from the user's immediate trust ring.
 */
function searchLocalContacts(query: TrustSearchQuery): TrustReview[] {
  const reviews: TrustReview[] = [];
  const contacts = listContacts();
  const queryLower = query.query.toLowerCase();

  for (const contact of contacts) {
    // Check if this contact is relevant to the query
    const nameMatch = contact.displayName.toLowerCase().includes(queryLower);
    const didMatch = contact.did === query.query;

    if (!nameMatch && !didMatch) continue;

    // Convert contact trust level to a review-like structure
    reviews.push({
      reviewerDID: 'self',
      reviewerName: 'You',
      reviewerTrust: 100, // self-assessment is highest trust
      rating: trustLevelToRating(contact.trustLevel),
      category:
        query.type === 'identity_attestations' ? 'identity_verification' : 'personal_knowledge',
      comment: contact.notes || undefined,
      timestamp: contact.updatedAt,
    });
  }

  return reviews;
}

/**
 * Convert a trust profile from AppView to review entries.
 */
function profileToReviews(profile: TrustProfile): TrustReview[] {
  const reviews: TrustReview[] = [];

  for (const [category, count] of Object.entries(profile.categories)) {
    if (count > 0) {
      reviews.push({
        reviewerDID: 'network',
        reviewerName: `${count} peer attestation(s)`,
        reviewerTrust: 50, // network attestations get moderate trust
        rating: Math.min(5, Math.round(profile.score / 20)), // 0-100 → 1-5
        category,
        comment: `${count} attestation(s) in category "${category}"`,
        timestamp: profile.lastUpdated,
      });
    }
  }

  return reviews;
}

/**
 * Compute weighted aggregate rating from reviews.
 *
 * Weights:
 *   - Self/trusted contacts: weight 1.0
 *   - Verified contacts: weight 0.8
 *   - Network attestations: weight 0.5
 */
function computeWeightedAggregate(reviews: TrustReview[]): number | null {
  if (reviews.length === 0) return null;

  let totalWeight = 0;
  let weightedSum = 0;

  for (const review of reviews) {
    // Weight by reviewer trust level (matching ARCHITECTURE):
    //   Trusted (ring 1, 90+): 1.0
    //   Verified (75+): 0.8
    //   Network attestations (50+): 0.5
    //   Unknown (<50): 0.2
    const weight =
      review.reviewerTrust >= 90
        ? 1.0
        : review.reviewerTrust >= 75
          ? 0.8
          : review.reviewerTrust >= 50
            ? 0.5
            : 0.2;
    weightedSum += review.rating * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;
  return Math.round((weightedSum / totalWeight) * 10) / 10; // 1 decimal place
}

function trustLevelToRating(level: string): number {
  switch (level) {
    case 'trusted':
      return 5;
    case 'verified':
      return 4;
    case 'unknown':
      return 3;
    case 'blocked':
      return 1;
    default:
      return 3;
  }
}
