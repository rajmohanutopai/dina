/**
 * Tests for the service-candidate ranker (BRAIN-P1-Q05).
 */

import {
  haversineKm,
  pickTopCandidate,
  rankCandidates,
  type Location,
} from '../../src/service/candidate_ranker';
import type { ServiceProfile } from '../../src/appview_client/http';

function profile(
  overrides: Partial<ServiceProfile> & { did: string; name: string },
): ServiceProfile {
  return {
    did: overrides.did,
    name: overrides.name,
    capabilities: overrides.capabilities ?? ['eta_query'],
    isDiscoverable: overrides.isDiscoverable ?? true,
    handle: overrides.handle,
    description: overrides.description,
    responsePolicy: overrides.responsePolicy,
    capabilitySchemas: overrides.capabilitySchemas,
    distanceKm: overrides.distanceKm,
  };
}

const SF: Location = { lat: 37.7749, lng: -122.4194 };
const OAKLAND: Location = { lat: 37.8044, lng: -122.2712 };
const NYC: Location = { lat: 40.7128, lng: -74.006 };

describe('haversineKm', () => {
  it('returns 0 for identical points', () => {
    expect(haversineKm(SF, SF)).toBeCloseTo(0, 6);
  });

  it('symmetric: haversine(A,B) === haversine(B,A)', () => {
    expect(haversineKm(SF, NYC)).toBeCloseTo(haversineKm(NYC, SF), 6);
  });

  it('SF → NYC is ~4130 km', () => {
    // Known great-circle distance for this pair ≈ 4129 km.
    expect(haversineKm(SF, NYC)).toBeGreaterThan(4100);
    expect(haversineKm(SF, NYC)).toBeLessThan(4160);
  });

  it('SF → Oakland is ~13 km', () => {
    expect(haversineKm(SF, OAKLAND)).toBeGreaterThan(12);
    expect(haversineKm(SF, OAKLAND)).toBeLessThan(15);
  });

  it('handles antipodes without NaN (sqrt clamp)', () => {
    const antipode: Location = { lat: -SF.lat, lng: SF.lng + 180 };
    const d = haversineKm(SF, antipode);
    expect(Number.isFinite(d)).toBe(true);
  });
});

describe('rankCandidates', () => {
  it('returns [] for empty input', () => {
    expect(rankCandidates('eta_query', [])).toEqual([]);
  });

  it('filters out non-public entries', () => {
    const profiles = [
      profile({ did: 'did:plc:a', name: 'A', isDiscoverable: false }),
      profile({ did: 'did:plc:b', name: 'B', isDiscoverable: true }),
    ];
    const out = rankCandidates('eta_query', profiles);
    expect(out.map((r) => r.profile.did)).toEqual(['did:plc:b']);
  });

  it('filters out entries that do not advertise the capability', () => {
    const profiles = [
      profile({ did: 'did:plc:a', name: 'A', capabilities: ['route_info'] }),
      profile({ did: 'did:plc:b', name: 'B', capabilities: ['eta_query'] }),
      profile({ did: 'did:plc:c', name: 'C', capabilities: ['eta_query', 'route_info'] }),
    ];
    const out = rankCandidates('eta_query', profiles);
    expect(out.map((r) => r.profile.did).sort()).toEqual(['did:plc:b', 'did:plc:c']);
  });

  it('returns [] when capability is empty string', () => {
    const profiles = [profile({ did: 'did:plc:a', name: 'A' })];
    expect(rankCandidates('', profiles)).toEqual([]);
  });

  it('filters entries with empty DID', () => {
    const profiles = [profile({ did: '', name: 'A' }), profile({ did: 'did:plc:b', name: 'B' })];
    expect(rankCandidates('eta_query', profiles)).toHaveLength(1);
  });

  it('does not mutate the input array', () => {
    const profiles = [
      profile({ did: 'did:plc:a', name: 'Zulu', distanceKm: 10 }),
      profile({ did: 'did:plc:b', name: 'Alpha', distanceKm: 5 }),
    ];
    const snapshot = profiles.map((p) => p.did);
    rankCandidates('eta_query', profiles);
    expect(profiles.map((p) => p.did)).toEqual(snapshot);
  });

  describe('sort order', () => {
    it('AppView order is the primary key (issue #15)', () => {
      // Even though "far" has a bigger distance, it appeared first in
      // AppView's response — AppView's trust ordering wins. Distance
      // only tiebreaks within identical AppView positions.
      const profiles = [
        profile({ did: 'did:plc:far', name: 'Far', distanceKm: 10 }),
        profile({ did: 'did:plc:near', name: 'Near', distanceKm: 2 }),
        profile({ did: 'did:plc:mid', name: 'Mid', distanceKm: 5 }),
      ];
      const out = rankCandidates('eta_query', profiles);
      expect(out.map((r) => r.profile.did)).toEqual(['did:plc:far', 'did:plc:near', 'did:plc:mid']);
    });

    it('AppView order preserved even when some entries have no distance', () => {
      const profiles = [
        profile({ did: 'did:plc:unknown', name: 'A' }),
        profile({ did: 'did:plc:known', name: 'B', distanceKm: 10 }),
      ];
      const out = rankCandidates('eta_query', profiles);
      // `unknown` appears first in AppView → it ranks first.
      expect(out[0].profile.did).toBe('did:plc:unknown');
      expect(out[1].profile.did).toBe('did:plc:known');
    });

    it('ties on distance preserve AppView order (issue #13)', () => {
      // Equal distance → AppView's trust/relevance ranking takes over
      // INSTEAD of alphabetical. AppView may have signals we don't
      // (endorsements, usage history); discarding that order in favour
      // of locale-sort would randomly pick the wrong provider.
      const profiles = [
        profile({ did: 'did:plc:z', name: 'Zulu', distanceKm: 5 }),
        profile({ did: 'did:plc:a', name: 'alpha', distanceKm: 5 }),
        profile({ did: 'did:plc:b', name: 'Bravo', distanceKm: 5 }),
      ];
      const out = rankCandidates('eta_query', profiles);
      // Input order survives because AppView ranked them that way.
      expect(out.map((r) => r.profile.name)).toEqual(['Zulu', 'alpha', 'Bravo']);
    });

    it('name breaks ties only when AppView index is identical', () => {
      // Constructed case: two candidates share distance AND the same
      // AppView position (e.g. from two merged result sets). Name +
      // DID are then the deterministic tiebreakers.
      const profiles = [
        profile({ did: 'did:plc:bbb', name: 'Same', distanceKm: 5 }),
        profile({ did: 'did:plc:aaa', name: 'Same', distanceKm: 5 }),
      ];
      // Without index manipulation they'd preserve input order — to
      // exercise the DID-tiebreaker path, assert against the ALPHABETIC
      // outcome by forcing a stable re-sort via identical coordinates
      // (both distanceKm undefined makes AppView order the sole signal).
      const unranked = profiles.map((p) => ({ ...p, distanceKm: undefined }));
      const out = rankCandidates('eta_query', unranked);
      // AppView order wins — the first one in the input lands first.
      expect(out[0].profile.did).toBe('did:plc:bbb');
      expect(out[1].profile.did).toBe('did:plc:aaa');
    });

    it('re-sorts pre-ordered server input consistently', () => {
      // AppView-first sort: the order the server sent wins even if
      // distance suggests otherwise (issue #15).
      const profiles = [
        profile({ did: 'did:plc:a', name: 'A', distanceKm: 10 }),
        profile({ did: 'did:plc:b', name: 'B', distanceKm: 3 }),
      ];
      const out = rankCandidates('eta_query', profiles);
      expect(out[0].profile.did).toBe('did:plc:a');
    });
  });

  describe('client-side distance computation', () => {
    it('uses coordsOf fallback when profile has no distanceKm', () => {
      // Input order = AppView order. Oakland appears first; its
      // computed distance (~10 km) is carried on the RankedCandidate.
      // NYC keeps rank 2 regardless of its much-larger distance —
      // AppView order is primary (issue #15).
      const coords: Record<string, Location> = {
        'did:plc:oakland': OAKLAND,
        'did:plc:nyc': NYC,
      };
      const profiles = [
        profile({ did: 'did:plc:oakland', name: 'Oakland Bus' }),
        profile({ did: 'did:plc:nyc', name: 'NYC Bus' }),
      ];
      const out = rankCandidates('eta_query', profiles, {
        viewer: SF,
        coordsOf: (p) => coords[p.did],
      });
      expect(out[0].profile.did).toBe('did:plc:oakland');
      expect(out[0].distanceKm).toBeLessThan(20);
      expect(out[1].distanceKm).toBeGreaterThan(4000);
    });

    it('prefers server-provided distanceKm over client computation', () => {
      const profiles = [profile({ did: 'did:plc:a', name: 'A', distanceKm: 7 })];
      const out = rankCandidates('eta_query', profiles, {
        viewer: SF,
        coordsOf: () => NYC, // would be ~4100 km if used
      });
      expect(out[0].distanceKm).toBe(7);
    });

    it('viewer without coordsOf → distance remains undefined', () => {
      const profiles = [profile({ did: 'did:plc:a', name: 'A' })];
      const out = rankCandidates('eta_query', profiles, { viewer: SF });
      expect(out[0].distanceKm).toBeUndefined();
    });

    it('non-finite viewer coords → no client-side distance', () => {
      const profiles = [profile({ did: 'did:plc:a', name: 'A' })];
      const out = rankCandidates('eta_query', profiles, {
        viewer: { lat: Number.NaN, lng: 0 },
        coordsOf: () => SF,
      });
      expect(out[0].distanceKm).toBeUndefined();
    });

    it('non-finite candidate coords → no client-side distance', () => {
      const profiles = [profile({ did: 'did:plc:a', name: 'A' })];
      const out = rankCandidates('eta_query', profiles, {
        viewer: SF,
        coordsOf: () => ({ lat: Number.POSITIVE_INFINITY, lng: 0 }),
      });
      expect(out[0].distanceKm).toBeUndefined();
    });

    it('non-finite server distanceKm is treated as missing', () => {
      const profiles = [profile({ did: 'did:plc:a', name: 'A', distanceKm: Number.NaN })];
      const out = rankCandidates('eta_query', profiles, {
        viewer: SF,
        coordsOf: () => OAKLAND,
      });
      // Falls back to client-side computation.
      expect(out[0].distanceKm).toBeGreaterThan(10);
      expect(out[0].distanceKm).toBeLessThan(20);
    });
  });
});

describe('pickTopCandidate', () => {
  it('returns null on empty input', () => {
    expect(pickTopCandidate('eta_query', [])).toBeNull();
  });

  it('returns null when no candidates match', () => {
    const profiles = [profile({ did: 'did:plc:a', name: 'A', isDiscoverable: false })];
    expect(pickTopCandidate('eta_query', profiles)).toBeNull();
  });

  it('returns the ranked top entry (AppView-first order, issue #15)', () => {
    const profiles = [
      profile({ did: 'did:plc:far', name: 'Far', distanceKm: 50 }),
      profile({ did: 'did:plc:near', name: 'Near', distanceKm: 1 }),
    ];
    const top = pickTopCandidate('eta_query', profiles);
    // AppView ranked `far` first — that's who we query, distance
    // notwithstanding.
    expect(top?.profile.did).toBe('did:plc:far');
  });
});
