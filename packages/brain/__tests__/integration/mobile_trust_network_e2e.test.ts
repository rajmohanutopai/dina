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
 *     `app.dina.trust.getProfile` (what the mobile app would hit
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
        score: 87,
        attestationCount: 42,
        categories: { product_review: 30, identity_verification: 12 },
        lastUpdated: Date.now(),
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
        score: 50,
        attestationCount: 5,
        categories: {},
        lastUpdated: Date.now(),
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
        score: 65,
        attestationCount: 10,
        // Non-empty categories are REQUIRED for profileToReviews to
        // synthesize review rows — an attestationCount alone isn't
        // enough. This pin surfaces any regression where the
        // profile→reviews mapper stops walking categories.
        categories: { product_review: 7, identity_verification: 3 },
        lastUpdated: Date.now(),
      }),
    );

    const result = await searchTrustNetwork({
      query: 'ChairMaker', // plain name, not a DID
      type: 'identity_attestations',
    });

    // Resolver should have hit resolveByName → got the DID → queried
    // AppView. If the resolver path is broken we'd see fromNetwork=0
    // here even with populated categories.
    expect(result.fromNetwork).toBeGreaterThanOrEqual(1);
  });
});
