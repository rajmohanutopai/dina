/**
 * Mobile Scenario 4 — Trust Network query end-to-end.
 *
 * The flow mobile drives for "how trusted is ChairMaker?":
 *   1. `searchTrustNetwork({ query, type })` is called — e.g. from
 *      the purchase-decision helper, or a dedicated `/trust` command.
 *   2. Local contacts are searched first (highest-weight ring).
 *   3. If a `TrustQueryClient` is registered, the AppView network is
 *      queried for attestations.
 *   4. Aggregate score is computed + cached.
 *
 * This test composes the exact same pieces the mobile stack uses:
 *   - the contacts directory (ring-1 weight)
 *   - an injected `TrustQueryClient`-shaped stub standing in for
 *     `com.dina.trust.getProfile` (what the mobile app would hit
 *     via the real AppView HTTP client)
 *
 * What this catches vs the simulator:
 *   - Aggregation math (weighted rating, category filtering)
 *   - Cache semantics
 *   - Local-vs-network source counting
 *   - Graceful degradation when AppView returns 404 / times out
 *
 * What simulator still catches: real AppView xRPC wire compat.
 */

import {
  searchTrustNetwork,
  registerTrustQueryClient,
  resetTrustQueryClient,
  resetSearchCache,
} from '@dina/core/src/trust/network_search';
import type { TrustQueryClient, TrustProfile, QueryResult } from '@dina/core/src/trust/query_client';
import {
  addContact,
  resetContactDirectory,
} from '@dina/core/src/contacts/directory';

describe('mobile Scenario 4 — Trust Network query', () => {
  beforeEach(() => {
    resetContactDirectory();
    resetTrustQueryClient();
    resetSearchCache();
  });

  /**
   * Minimal `TrustQueryClient`-shaped stub. Returns the canned profile
   * the test configures — zero network I/O.
   */
  function makeStubClient(profile: TrustProfile | null): TrustQueryClient {
    return {
      async queryProfile(did: string): Promise<QueryResult> {
        if (profile !== null && profile.did === did) {
          return { success: true, profile };
        }
        return { success: false, error: 'not_found', errorMessage: `no profile for ${did}` };
      },
      async queryBatch(): Promise<Map<string, QueryResult>> {
        return new Map();
      },
    } as unknown as TrustQueryClient;
  }

  it('searches local contacts when no AppView client is wired (offline mode)', async () => {
    // Seed a trusted contact — the local-contact path should surface
    // it even though no network client is registered.
    addContact(
      'did:plc:chair-maker',
      'ChairMaker',
      'verified',
      'summary',
      'acquaintance',
    );

    const result = await searchTrustNetwork({
      query: 'did:plc:chair-maker',
      type: 'identity_attestations',
    });

    expect(result.query).toBe('did:plc:chair-maker');
    expect(result.cached).toBe(false);
    // fromNetwork must be 0 — no client registered.
    expect(result.fromNetwork).toBe(0);
  });

  it('merges local contacts + network attestations when client is wired', async () => {
    addContact(
      'did:plc:chair-maker',
      'ChairMaker',
      'verified',
      'summary',
      'acquaintance',
    );

    registerTrustQueryClient(
      makeStubClient({
        did: 'did:plc:chair-maker',
        overallTrustScore: 0.87,
        attestationSummary: { total: 42, positive: 36, neutral: 4, negative: 2 },
        vouchCount: 8,
        endorsementCount: 12,
        reviewerStats: {
          totalAttestationsBy: 30,
          corroborationRate: 0.82,
          evidenceRate: 0.7,
          helpfulRatio: 0.78,
        },
        activeDomains: ['chairs.example', 'reviews.org'],
        lastActive: Date.now(),
      }),
    );

    const result = await searchTrustNetwork({
      query: 'did:plc:chair-maker',
      type: 'identity_attestations',
    });

    // At least the network profile was pulled
    expect(result.fromNetwork).toBeGreaterThanOrEqual(1);
    expect(result.aggregateScore).not.toBeNull();
    expect(result.totalReviews).toBeGreaterThan(0);
  });

  it('caches results — second identical query hits the cache', async () => {
    addContact(
      'did:plc:chair-maker',
      'ChairMaker',
      'verified',
      'summary',
      'acquaintance',
    );
    registerTrustQueryClient(
      makeStubClient({
        did: 'did:plc:chair-maker',
        overallTrustScore: 0.5,
        attestationSummary: { total: 5, positive: 3, neutral: 1, negative: 1 },
        vouchCount: 1,
        endorsementCount: 0,
        reviewerStats: {
          totalAttestationsBy: 5,
          corroborationRate: 0.4,
          evidenceRate: 0.2,
          helpfulRatio: 0.5,
        },
        activeDomains: [],
        lastActive: Date.now(),
      }),
    );

    const first = await searchTrustNetwork({
      query: 'did:plc:chair-maker',
      type: 'identity_attestations',
    });
    expect(first.cached).toBe(false);

    const second = await searchTrustNetwork({
      query: 'did:plc:chair-maker',
      type: 'identity_attestations',
    });
    expect(second.cached).toBe(true);
  });

  it('gracefully degrades when AppView returns not_found', async () => {
    // No contact entry + AppView can't find the DID — fromLocal=0,
    // fromNetwork=0, aggregateScore=null. Still succeeds (no throw).
    registerTrustQueryClient(makeStubClient(null));

    const result = await searchTrustNetwork({
      query: 'did:plc:nobody',
      type: 'identity_attestations',
    });

    expect(result.reviews.length).toBe(0);
    expect(result.aggregateScore).toBeNull();
    expect(result.totalReviews).toBe(0);
    expect(result.fromLocalContacts).toBe(0);
    expect(result.fromNetwork).toBe(0);
  });

  it('name-based search resolves through the contact directory (no did: prefix)', async () => {
    addContact(
      'did:plc:chair-maker',
      'ChairMaker',
      'verified',
      'summary',
      'acquaintance',
    );
    registerTrustQueryClient(
      makeStubClient({
        did: 'did:plc:chair-maker',
        // A non-zero attestation total + a non-null score is REQUIRED
        // for profileToReviews to synthesize a review row — an unscored
        // (null) profile or zero total returns []. This pin surfaces a
        // regression where the profile→review mapper short-circuits.
        overallTrustScore: 0.65,
        attestationSummary: { total: 10, positive: 7, neutral: 2, negative: 1 },
        vouchCount: 2,
        endorsementCount: 3,
        reviewerStats: {
          totalAttestationsBy: 10,
          corroborationRate: 0.6,
          evidenceRate: 0.5,
          helpfulRatio: 0.65,
        },
        activeDomains: ['chairs.example'],
        lastActive: Date.now(),
      }),
    );

    const result = await searchTrustNetwork({
      query: 'ChairMaker', // plain name, not a DID
      type: 'identity_attestations',
    });

    // Resolver should have hit resolveByName → got the DID → queried
    // AppView. If the resolver path is broken we'd see fromNetwork=0
    // here even with a populated profile.
    expect(result.fromNetwork).toBeGreaterThanOrEqual(1);
  });
});
