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
import {
  type TrustQueryClient,
  type TrustProfile,
  type QueryResult,
  type AttestationSearchHit,
  type AttestationSearchParams,
} from './query_client';
import { listContacts, getContact, resolveByName, type Contact } from '../contacts/directory';
import { TRUST_CACHE_TTL_MS } from '../constants';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export type SearchType = 'entity_reviews' | 'identity_attestations' | 'topic_trust';

/**
 * Filter overlay matching AppView's `com.dina.trust.search`. Pass
 * any combination — they're AND-ed at the AppView side.
 *
 * Plan §6.1 also calls for `language` and `location` filters; those
 * land alongside TN-API-001 server-side and the field set here will
 * grow to match.
 */
export interface TrustSearchFilters {
  /**
   * `subject.type` filter (did / content / product / dataset /
   * organization / claim / place). Restricts results to attestations
   * whose subject matches.
   */
  subjectType?: AttestationSearchParams['subjectType'];
  /** Free-text category match (e.g. 'product', 'service'). */
  category?: string;
  /** Domain filter (e.g. 'amazon.com'). Lower-case, no scheme. */
  domain?: string;
  /** Sentiment bucket (positive / neutral / negative). */
  sentiment?: AttestationSearchParams['sentiment'];
  /** Author DID restriction — useful for "show me only X's reviews". */
  authorDid?: string;
  /** Comma-separated tag list, AND-matched against the row's tags. */
  tags?: string;
  /** Minimum confidence (closed enum, ordered). */
  minConfidence?: AttestationSearchParams['minConfidence'];
  /** ISO-8601 lower bound on `recordCreatedAt`. */
  since?: string;
  /** ISO-8601 upper bound on `recordCreatedAt`. */
  until?: string;
  /** Result ordering — 'recent' or 'relevant' (default 'relevant'). */
  sort?: 'recent' | 'relevant';
}

export interface TrustSearchQuery extends TrustSearchFilters {
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

/**
 * Drop one query's cached search result.
 *
 * Called by callers that need to force a re-issue of the network
 * call rather than waiting for the TTL to expire — e.g. the mobile
 * trust-API facade's `invalidateTrustSearch`. Without this primitive,
 * the only way to bust a single entry is `resetSearchCache()` which
 * over-invalidates by clearing every search.
 *
 * Idempotent: dropping a key that isn't cached is a no-op.
 *
 * The key is derived from the same canonical key builder
 * `searchTrustNetwork` uses, so the two stay in sync as the key
 * format evolves.
 */
export function dropSearchCache(query: TrustSearchQuery): void {
  searchCache.delete(buildCacheKey(query));
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
  const cacheKey = buildCacheKey(query);

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
      // Two routing modes:
      //   (a) the query resolves to a single DID and there are no
      //       per-attestation filters → use `getProfile` for the
      //       aggregated view (cheap, one row).
      //   (b) any filter is set, or the query is free-text →
      //       use `searchAttestations` so AppView's filter machinery
      //       applies. Free-text queries with no DID would silently
      //       no-op under the old getProfile-only path.
      const filters = extractFilters(query);
      const targetDID = resolveQueryToDid(query.query);

      if (targetDID && !hasAnyFilter(filters)) {
        const profileResult = await queryClient.queryProfile(targetDID);
        if (profileResult.success && profileResult.profile) {
          const networkReviews = profileToReviews(profileResult.profile);
          reviews.push(...networkReviews);
          fromNetwork = networkReviews.length;
        }
      } else {
        // Filters present (or free-text query): hit the search xRPC.
        //
        // Important: the query string is always passed as `q` (full-
        // text needle), even when it's a DID. We do NOT auto-promote
        // a DID to `authorDid` — that's a different semantic ("by
        // the DID" vs "about the DID") and gets the wrong rows back
        // for the `identity_attestations` / `entity_reviews` flows
        // most callers want. If the caller really wants "attestations
        // BY this author", they pass `authorDid` explicitly via the
        // filter overlay.
        //
        // AppView doesn't yet expose a `subjectId` filter, so an
        // exact "attestations ABOUT did:plc:X" lookup with extra
        // filters falls back to FTS. That gap is tracked with
        // TN-API-001.
        const searchParams: AttestationSearchParams = {
          ...filters,
          q: query.query,
          limit,
        };
        const searchResult = await queryClient.searchAttestations(searchParams);
        if (searchResult.success) {
          const networkReviews = searchResult.results.map(searchHitToReview);
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
 * Convert a trust profile from AppView into a synthetic review entry
 * for the local aggregator.
 *
 * AppView returns one aggregate score + summary per DID — not a list
 * of individual reviews. We fold that aggregate into a single
 * "network attestation" review so it can flow through the same
 * trust-weighted aggregator that handles local contacts. Domain and
 * sentiment breakdown surface as metadata in the comment for UX.
 *
 * Returns `[]` when the profile is unscored or has no attestations
 * — there's nothing to aggregate.
 */
function profileToReviews(profile: TrustProfile): TrustReview[] {
  const total = profile.attestationSummary.total;
  if (total === 0 || profile.overallTrustScore === null) {
    return [];
  }

  // AppView score is [0, 1]; review rating bucket is 1-5.
  // 0 → 1 star, 1 → 5 stars, linear in between.
  const rating = Math.min(5, Math.max(1, Math.round(1 + profile.overallTrustScore * 4)));

  const domainNote =
    profile.activeDomains.length > 0
      ? ` across ${profile.activeDomains.length} domain(s)`
      : '';

  return [
    {
      reviewerDID: 'network',
      reviewerName: `${total} peer attestation(s)`,
      reviewerTrust: 50, // network attestations get moderate trust
      rating,
      category: 'network_aggregate',
      comment: `${total} attestation(s)${domainNote}`,
      timestamp: profile.lastActive ?? Date.now(),
    },
  ];
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

// ---------------------------------------------------------------
// Internal: filter helpers (TN-LITE-005)
// ---------------------------------------------------------------

/**
 * Pull just the `TrustSearchFilters` keys out of the wider
 * `TrustSearchQuery`. Used so we can fingerprint or AppView-call
 * with the filters without dragging the type/query/limit fields.
 */
function extractFilters(q: TrustSearchQuery): TrustSearchFilters {
  return {
    subjectType: q.subjectType,
    category: q.category,
    domain: q.domain,
    sentiment: q.sentiment,
    authorDid: q.authorDid,
    tags: q.tags,
    minConfidence: q.minConfidence,
    since: q.since,
    until: q.until,
    sort: q.sort,
  };
}

/** True if any filter slot is set to a non-empty value. */
function hasAnyFilter(f: TrustSearchFilters): boolean {
  return (
    f.subjectType !== undefined ||
    (f.category !== undefined && f.category.length > 0) ||
    (f.domain !== undefined && f.domain.length > 0) ||
    f.sentiment !== undefined ||
    (f.authorDid !== undefined && f.authorDid.length > 0) ||
    (f.tags !== undefined && f.tags.length > 0) ||
    f.minConfidence !== undefined ||
    (f.since !== undefined && f.since.length > 0) ||
    (f.until !== undefined && f.until.length > 0) ||
    f.sort !== undefined
  );
}

/**
 * Resolve a query string into a DID. Either it already starts with
 * `did:` (return as-is) or it matches a contact name in the local
 * directory (return that contact's DID). Returns `null` otherwise.
 */
function resolveQueryToDid(query: string): string | null {
  if (query.startsWith('did:')) return query;
  const contact = resolveByName(query);
  return contact ? contact.did : null;
}

/**
 * Convert one AppView search hit into a `TrustReview` for the
 * weighted aggregator. AppView confidence levels collapse onto our
 * 1–5 rating bucket — `certain` → 5, `speculative` → 2 (a little
 * above the unknown baseline). When a row lacks `confidence`, we
 * fall back to the sentiment polarity as a coarse signal.
 *
 * `reviewerTrust` defaults to 50 here (network attestation tier).
 * The aggregator weights ALL search-derived rows equally for now;
 * proper per-author trust scoring would require fetching each
 * author's profile and is deferred to TN-API-001.
 */
function searchHitToReview(hit: AttestationSearchHit): TrustReview {
  const ts = hit.recordCreatedAt ? Date.parse(hit.recordCreatedAt) : NaN;
  const timestamp = Number.isNaN(ts) ? Date.now() : ts;
  return {
    reviewerDID: hit.authorDid ?? 'network',
    reviewerName: hit.authorDid ? `network: ${shortDid(hit.authorDid)}` : 'network',
    reviewerTrust: 50,
    rating: searchHitToRating(hit),
    category: hit.category ?? 'network_aggregate',
    comment: hit.uri ? `Attestation ${hit.uri}` : undefined,
    timestamp,
  };
}

function searchHitToRating(hit: AttestationSearchHit): number {
  // Confidence is the strongest per-row signal AppView gives us.
  switch (hit.confidence) {
    case 'certain':
      return 5;
    case 'high':
      return 4;
    case 'moderate':
      return 3;
    case 'speculative':
      return 2;
    default:
      // Fall back to sentiment polarity when confidence is missing.
      if (hit.sentiment === 'positive') return 4;
      if (hit.sentiment === 'negative') return 1;
      return 3; // neutral / unknown
  }
}

function shortDid(did: string): string {
  // Trim long DIDs for review-row display: `did:plc:abc...xyz`.
  if (did.length <= 24) return did;
  return `${did.slice(0, 12)}…${did.slice(-6)}`;
}

/**
 * Build a stable cache key that fingerprints the full query
 * including filters. The previous implementation hashed only
 * `type:query`, which silently collapsed two queries that differed
 * only by filter into the same cache row — a real bug, surfaced by
 * the TN-LITE-005 extension.
 */
function buildCacheKey(query: TrustSearchQuery): string {
  const filters = extractFilters(query);
  const limit = query.limit ?? 20;
  // Stable JSON: keys sorted via Object.entries → toSorted (Node ≥ 20).
  const filterEntries = Object.entries(filters)
    .filter(([, v]) => v !== undefined && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const filterPart = filterEntries.length > 0 ? JSON.stringify(filterEntries) : '';
  return `${query.type}:${query.query.toLowerCase()}:${limit}:${filterPart}`;
}
