/**
 * Place lat/lng capture data-layer tests (TN-MOB-022).
 *
 * Pins the contract that the compose-flow place input expects:
 *
 *   - Coordinate validation: out-of-bounds / NaN / non-number
 *     rejected; valid coords rounded to 6dp (~11cm civilian GPS).
 *   - Null Island default-rejection (almost always a geocoder
 *     failure sentinel) — opt-in via `allowNullIsland`.
 *   - Maps URI shape matches what AppView's enricher
 *     `parseGoogleMapsCoords` accepts (cross-implementation
 *     parity by design — the URL is the contract).
 *   - SubjectRef builder requires at least one of coordinates OR
 *     Google Place ID (place must be identifiable somehow).
 *   - Capture-mode state machine: valid transitions defined,
 *     invalid transitions are no-ops (not crashes).
 *
 * Pure-function tests — runs under plain Jest, no RN deps.
 */

import {
  COORDINATE_PRECISION_DP,
  LAT_MAX,
  LAT_MIN,
  LNG_MAX,
  LNG_MIN,
  buildMapsUri,
  buildPlaceSubjectRef,
  isCaptureActive,
  isCaptureReady,
  transitionCaptureMode,
  validateCoordinates,
  type CaptureMode,
} from '../../src/trust/place_capture';

// ─── validateCoordinates ─────────────────────────────────────────────────

describe('validateCoordinates — happy path', () => {
  it('accepts a normal coordinate pair', () => {
    expect(validateCoordinates(37.762, -122.435)).toEqual({
      lat: 37.762,
      lng: -122.435,
    });
  });

  it('rounds to 6 decimal places (civilian GPS resolution)', () => {
    expect(validateCoordinates(37.76234567890123, -122.43512345678)).toEqual({
      lat: 37.762346,
      lng: -122.435123,
    });
  });

  it('preserves coordinates already at 6dp (idempotent)', () => {
    const c = validateCoordinates(37.123456, -122.654321);
    expect(c).toEqual({ lat: 37.123456, lng: -122.654321 });
  });

  it('accepts the four corners (boundary inclusivity)', () => {
    expect(validateCoordinates(LAT_MIN, LNG_MIN)).toEqual({ lat: LAT_MIN, lng: LNG_MIN });
    expect(validateCoordinates(LAT_MAX, LNG_MAX)).toEqual({ lat: LAT_MAX, lng: LNG_MAX });
    expect(validateCoordinates(LAT_MIN, LNG_MAX)).toEqual({ lat: LAT_MIN, lng: LNG_MAX });
    expect(validateCoordinates(LAT_MAX, LNG_MIN)).toEqual({ lat: LAT_MAX, lng: LNG_MIN });
  });

  it('returns frozen coordinates (caller cannot mutate the result)', () => {
    const c = validateCoordinates(1, 1);
    expect(Object.isFrozen(c)).toBe(true);
  });
});

describe('validateCoordinates — rejection paths', () => {
  it('returns null for out-of-bounds latitude', () => {
    expect(validateCoordinates(91, 0)).toBeNull();
    expect(validateCoordinates(-91, 0)).toBeNull();
  });

  it('returns null for out-of-bounds longitude', () => {
    expect(validateCoordinates(0, 181)).toBeNull();
    expect(validateCoordinates(0, -181)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(validateCoordinates(NaN, 0)).toBeNull();
    expect(validateCoordinates(0, NaN)).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(validateCoordinates(Infinity, 0)).toBeNull();
    expect(validateCoordinates(0, -Infinity)).toBeNull();
  });

  it('returns null for non-number types', () => {
    // @ts-expect-error — runtime guard
    expect(validateCoordinates('37.7', '-122.4')).toBeNull();
    // @ts-expect-error — runtime guard
    expect(validateCoordinates(null, undefined)).toBeNull();
    // @ts-expect-error — runtime guard
    expect(validateCoordinates({}, [])).toBeNull();
  });

  it('does NOT throw on bad inputs (total function)', () => {
    // The compose form calls this on every keystroke / pin drop;
    // throwing would break the screen.
    // @ts-expect-error — runtime guard
    expect(() => validateCoordinates({}, [])).not.toThrow();
  });
});

describe('validateCoordinates — Null Island defence', () => {
  it('rejects (0, 0) by default (geocoder-failure sentinel)', () => {
    expect(validateCoordinates(0, 0)).toBeNull();
  });

  it('accepts (0, 0) when allowNullIsland: true (explicit opt-in)', () => {
    expect(validateCoordinates(0, 0, { allowNullIsland: true })).toEqual({
      lat: 0,
      lng: 0,
    });
  });

  it('accepts (0, non-zero) without opt-in (only EXACT 0,0 is sentinel)', () => {
    // Off the equator at the prime meridian is a real place; only
    // exactly (0, 0) is the sentinel.
    expect(validateCoordinates(0.0001, 0)).toEqual({ lat: 0.0001, lng: 0 });
    expect(validateCoordinates(0, 0.0001)).toEqual({ lat: 0, lng: 0.0001 });
  });

  it('COORDINATE_PRECISION_DP is 6 (~11cm civilian GPS)', () => {
    expect(COORDINATE_PRECISION_DP).toBe(6);
  });
});

// ─── buildMapsUri ────────────────────────────────────────────────────────

describe('buildMapsUri — AppView enricher parity', () => {
  it('produces the form parseGoogleMapsCoords expects', () => {
    // The enricher in appview/src/util/subject_enrichment.ts parses
    // `?q=lat,lng` — this URL shape is the cross-implementation
    // contract.
    const uri = buildMapsUri({ lat: 37.762, lng: -122.435 });
    expect(uri).toBe('https://www.google.com/maps?q=37.762,-122.435');
  });

  it('handles negative coordinates correctly', () => {
    const uri = buildMapsUri({ lat: -33.865, lng: 151.209 });
    expect(uri).toBe('https://www.google.com/maps?q=-33.865,151.209');
  });

  it('preserves precision of the rounded values', () => {
    const c = validateCoordinates(40.7128123456789, -74.0059876543210)!;
    const uri = buildMapsUri(c);
    expect(uri).toBe('https://www.google.com/maps?q=40.712812,-74.005988');
  });
});

// ─── buildPlaceSubjectRef ────────────────────────────────────────────────

describe('buildPlaceSubjectRef — composition', () => {
  it('builds a coordinates-only place ref', () => {
    const ref = buildPlaceSubjectRef({
      name: 'Twin Peaks',
      coordinates: { lat: 37.7544, lng: -122.4477 },
    });
    expect(ref).toEqual({
      type: 'place',
      name: 'Twin Peaks',
      uri: 'https://www.google.com/maps?q=37.7544,-122.4477',
    });
  });

  it('builds a Place-ID-only place ref', () => {
    const ref = buildPlaceSubjectRef({
      name: 'Twin Peaks',
      coordinates: null,
      googlePlaceId: 'ChIJabc123',
    });
    expect(ref).toEqual({
      type: 'place',
      name: 'Twin Peaks',
      identifier: 'place_id:ChIJabc123',
    });
  });

  it('builds a place ref with BOTH coordinates and Place ID', () => {
    const ref = buildPlaceSubjectRef({
      name: 'Twin Peaks',
      coordinates: { lat: 37.7544, lng: -122.4477 },
      googlePlaceId: 'ChIJabc123',
    });
    expect(ref).toEqual({
      type: 'place',
      name: 'Twin Peaks',
      uri: 'https://www.google.com/maps?q=37.7544,-122.4477',
      identifier: 'place_id:ChIJabc123',
    });
  });

  it('trims the name', () => {
    const ref = buildPlaceSubjectRef({
      name: '   Twin Peaks   ',
      coordinates: { lat: 1, lng: 1 },
    });
    expect(ref.name).toBe('Twin Peaks');
  });

  it('trims the googlePlaceId before prefixing', () => {
    const ref = buildPlaceSubjectRef({
      name: 'X',
      coordinates: null,
      googlePlaceId: '  ChIJabc123  ',
    });
    expect(ref.identifier).toBe('place_id:ChIJabc123');
  });
});

describe('buildPlaceSubjectRef — validation', () => {
  it('throws on empty name', () => {
    expect(() =>
      buildPlaceSubjectRef({ name: '', coordinates: { lat: 1, lng: 1 } }),
    ).toThrow(/non-empty/);
  });

  it('throws on whitespace-only name', () => {
    expect(() =>
      buildPlaceSubjectRef({ name: '   ', coordinates: { lat: 1, lng: 1 } }),
    ).toThrow(/non-empty/);
  });

  it('throws when neither coordinates nor Place ID provided (place is unidentifiable)', () => {
    expect(() =>
      buildPlaceSubjectRef({ name: 'X', coordinates: null }),
    ).toThrow(/unidentifiable/);
  });

  it('throws when coordinates is null AND placeId is empty/whitespace', () => {
    expect(() =>
      buildPlaceSubjectRef({ name: 'X', coordinates: null, googlePlaceId: '   ' }),
    ).toThrow(/unidentifiable/);
  });
});

// ─── transitionCaptureMode ───────────────────────────────────────────────

describe('transitionCaptureMode — valid transitions', () => {
  // Coverage matrix from the state-machine table. A test per declared
  // (from, event) → to entry plus a few cross-cutting invariants.
  const validTransitions: Array<[CaptureMode, Parameters<typeof transitionCaptureMode>[1], CaptureMode]> = [
    ['idle', 'start_locating', 'locating'],
    ['idle', 'start_manual', 'manual'],
    ['locating', 'success', 'ready'],
    ['locating', 'fail', 'error'],
    ['locating', 'cancel', 'idle'],
    ['manual', 'success', 'ready'],
    ['manual', 'fail', 'error'],
    ['manual', 'cancel', 'idle'],
    ['ready', 'start_locating', 'locating'],
    ['ready', 'start_manual', 'manual'],
    ['ready', 'reset', 'idle'],
    ['error', 'reset', 'idle'],
    ['error', 'start_locating', 'locating'],
    ['error', 'start_manual', 'manual'],
  ];

  for (const [from, event, to] of validTransitions) {
    it(`${from} --${event}--> ${to}`, () => {
      expect(transitionCaptureMode(from, event)).toBe(to);
    });
  }
});

describe('transitionCaptureMode — invalid transitions are no-ops', () => {
  it('idle does not respond to "success" (no in-flight capture to succeed)', () => {
    expect(transitionCaptureMode('idle', 'success')).toBe('idle');
  });

  it('locating does not respond to "start_locating" (already running)', () => {
    expect(transitionCaptureMode('locating', 'start_locating')).toBe('locating');
  });

  it('ready does not respond to "success" (already ready, would be re-entry)', () => {
    expect(transitionCaptureMode('ready', 'success')).toBe('ready');
  });

  it('returns the same value on no-op (cheap React identity check)', () => {
    const before: CaptureMode = 'idle';
    const after = transitionCaptureMode(before, 'success');
    expect(after).toBe(before);
  });
});

describe('transitionCaptureMode — predicates', () => {
  it('isCaptureReady is true ONLY for "ready"', () => {
    expect(isCaptureReady('ready')).toBe(true);
    for (const m of ['idle', 'locating', 'manual', 'error'] as const) {
      expect(isCaptureReady(m)).toBe(false);
    }
  });

  it('isCaptureActive is true for "locating" and "manual"', () => {
    expect(isCaptureActive('locating')).toBe(true);
    expect(isCaptureActive('manual')).toBe(true);
    for (const m of ['idle', 'ready', 'error'] as const) {
      expect(isCaptureActive(m)).toBe(false);
    }
  });
});
