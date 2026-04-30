/**
 * Place lat/lng capture data layer (TN-MOB-022).
 *
 * Plan §8.5.1:
 *
 *   > When attesting a `place`-type subject, the compose flow needs
 *   > a way to attach lat/lng. Two paths: "use my location" (GPS
 *   > permission → `expo-location.getCurrentPositionAsync`) or
 *   > manual pin-drop (the user moves a draggable marker on a map
 *   > and confirms). Either path produces `{lat, lng}`. The
 *   > compose-flow validator requires at least one of: a Google
 *   > Place ID, OR a `lat`+`lng` pair, OR a Maps URL — the place is
 *   > unidentifiable otherwise.
 *
 * This module owns the **derivation** — pure data → SubjectRef
 * payload. Concretely:
 *
 *   - Validate `lat ∈ [-90, 90]`, `lng ∈ [-180, 180]`, both finite.
 *     Reject `0,0` (Null Island) by default — almost always a sentinel
 *     for "geocoder couldn't resolve" rather than an actual location;
 *     callers who genuinely want it can opt in via `allowNullIsland`.
 *   - Coordinate precision policy: round to 6 decimal places (~11cm
 *     resolution at the equator). 6 dp is the GPS-civilian bound;
 *     storing more is privacy-leaky AND noise.
 *   - Build the `SubjectRef.uri` for AppView's enricher to parse:
 *     `https://www.google.com/maps?q=<lat>,<lng>` — exactly the form
 *     `parseGoogleMapsCoords` in `appview/src/util/subject_enrichment.ts`
 *     accepts. Single source of truth between mobile compose + AppView
 *     enrichment.
 *   - Capture-mode state machine: `idle | locating | manual | ready |
 *     error`. The screen drives transitions via `transitionCaptureMode`;
 *     transitions are validated so a bug in the screen layer can't put
 *     the state into a non-existent combination.
 *
 * Pure function. Zero RN deps (the screen layer wires
 * `expo-location.getCurrentPositionAsync` + the map component to this
 * data layer). Tests under plain Jest.
 */

import type { SubjectRef } from '@dina/protocol';

// ─── Public types ─────────────────────────────────────────────────────────

/** A validated coordinate pair. */
export interface PlaceCoordinates {
  /** Latitude in degrees, [-90, 90], rounded to 6dp. */
  readonly lat: number;
  /** Longitude in degrees, [-180, 180], rounded to 6dp. */
  readonly lng: number;
}

/** Options passed to `validateCoordinates`. */
export interface ValidateCoordinatesOptions {
  /**
   * Allow `0, 0` (Null Island). Default `false`. Almost always a
   * geocoder-failure sentinel; allowing it accidentally maps every
   * "couldn't resolve" event to the Gulf of Guinea.
   */
  readonly allowNullIsland?: boolean;
}

/**
 * Compose-flow capture mode. The screen drives the state via the
 * `transitionCaptureMode` reducer.
 *
 *   - `idle`: nothing captured yet, both buttons enabled.
 *   - `locating`: "Use my location" tapped, GPS query in flight.
 *   - `manual`: pin-drop modal open, user dragging the marker.
 *   - `ready`: a valid `{lat, lng}` is staged.
 *   - `error`: capture attempt failed (permission denied, GPS
 *     unavailable, validation error, etc.).
 */
export type CaptureMode = 'idle' | 'locating' | 'manual' | 'ready' | 'error';

/** All valid `(from, event)` → `to` transitions. */
export type CaptureEvent =
  | 'start_locating'
  | 'start_manual'
  | 'success'
  | 'fail'
  | 'cancel'
  | 'reset';

/**
 * Place subject draft. Combines the user-authored fields (`name`,
 * `identifier`) with derived fields (`uri`) so the compose form has
 * a single object to submit.
 */
export interface PlaceSubjectDraft {
  /** Display name — what the user typed. */
  readonly name: string;
  /** Captured coordinates, or null until set. */
  readonly coordinates: PlaceCoordinates | null;
  /** Optional Google Place ID, prefixed `place_id:` for the enricher. */
  readonly googlePlaceId?: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * Civilian-grade GPS resolution. 6 decimal places ≈ 11cm at the
 * equator. Storing more is noise (true device accuracy is ~3-5m
 * outdoors) AND a privacy leak — extra digits look authoritative
 * but are cargo-cult. Pinned by test.
 */
export const COORDINATE_PRECISION_DP = 6;

/** Latitude bounds. */
export const LAT_MIN = -90;
export const LAT_MAX = 90;

/** Longitude bounds. */
export const LNG_MIN = -180;
export const LNG_MAX = 180;

/**
 * Frozen state-machine table. Each key is `${from}:${event}` and
 * the value is the next state. Missing keys mean the transition is
 * invalid (`transitionCaptureMode` returns the unchanged state +
 * does NOT throw — the screen layer treats invalid as a no-op).
 */
const TRANSITIONS: Readonly<Record<string, CaptureMode>> = Object.freeze({
  // From idle
  'idle:start_locating': 'locating',
  'idle:start_manual': 'manual',
  // From locating
  'locating:success': 'ready',
  'locating:fail': 'error',
  'locating:cancel': 'idle',
  // From manual
  'manual:success': 'ready',
  'manual:fail': 'error',
  'manual:cancel': 'idle',
  // From ready (user can switch sources or reset)
  'ready:start_locating': 'locating',
  'ready:start_manual': 'manual',
  'ready:reset': 'idle',
  // From error (always recoverable via reset or retry)
  'error:reset': 'idle',
  'error:start_locating': 'locating',
  'error:start_manual': 'manual',
})

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Validate a raw `(lat, lng)` pair. Returns the rounded
 * `PlaceCoordinates` on success, or null on failure (out of bounds,
 * NaN, Null Island when not opted in).
 *
 * Total function — never throws. The compose form's "Capture
 * coordinates" button calls this on the GPS-or-pin-drop output and
 * branches on null.
 */
export function validateCoordinates(
  lat: unknown,
  lng: unknown,
  options: ValidateCoordinatesOptions = {},
): PlaceCoordinates | null {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < LAT_MIN || lat > LAT_MAX) return null;
  if (lng < LNG_MIN || lng > LNG_MAX) return null;
  // Null Island defence — see preamble.
  if (lat === 0 && lng === 0 && options.allowNullIsland !== true) return null;

  return Object.freeze({
    lat: roundToPrecision(lat, COORDINATE_PRECISION_DP),
    lng: roundToPrecision(lng, COORDINATE_PRECISION_DP),
  });
}

/**
 * Build the AppView-enricher-compatible Maps URI for a coordinate
 * pair. The form `https://www.google.com/maps?q=<lat>,<lng>` is
 * exactly what `parseGoogleMapsCoords` in
 * `appview/src/util/subject_enrichment.ts` accepts; round-tripping
 * through this function keeps mobile compose + AppView enrichment
 * in lockstep.
 *
 * Caller is expected to pass a coordinate pair already validated by
 * `validateCoordinates` — this function does not re-validate.
 */
export function buildMapsUri(coords: PlaceCoordinates): string {
  return `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
}

/**
 * Compose a `SubjectRef` for a `place` subject from the draft state.
 * Throws when the draft is unidentifiable — neither a Google Place
 * ID nor coordinates are set. The compose form should disable submit
 * until at least one is populated; this is a defence-in-depth guard.
 *
 * `name` is required (the place needs a display name). Empty / blank
 * names throw.
 */
export function buildPlaceSubjectRef(draft: PlaceSubjectDraft): SubjectRef {
  if (typeof draft.name !== 'string' || draft.name.trim().length === 0) {
    throw new Error('buildPlaceSubjectRef: name must be a non-empty string');
  }

  if (draft.coordinates === null && (!draft.googlePlaceId || draft.googlePlaceId.trim().length === 0)) {
    throw new Error(
      'buildPlaceSubjectRef: place is unidentifiable — provide coordinates or googlePlaceId',
    );
  }

  const ref: { -readonly [K in keyof SubjectRef]: SubjectRef[K] } = {
    type: 'place',
    name: draft.name.trim(),
  };

  if (draft.coordinates !== null) {
    ref.uri = buildMapsUri(draft.coordinates);
  }

  if (draft.googlePlaceId && draft.googlePlaceId.trim().length > 0) {
    // Prefixed for the enricher's identifier-parser path.
    ref.identifier = `place_id:${draft.googlePlaceId.trim()}`;
  }

  return ref;
}

/**
 * Apply an event to the current capture mode. Invalid transitions
 * (e.g. `success` from `idle`) return the unchanged state — they're
 * a no-op rather than throwing, so a stray screen-layer bug doesn't
 * crash the compose flow.
 *
 * Returns the same reference when the transition is invalid (cheap
 * React identity check); returns the new state on a valid
 * transition.
 */
export function transitionCaptureMode(from: CaptureMode, event: CaptureEvent): CaptureMode {
  const next = TRANSITIONS[`${from}:${event}`];
  return next ?? from;
}

/** Whether a capture mode means the form has staged-ready coords. */
export function isCaptureReady(mode: CaptureMode): boolean {
  return mode === 'ready';
}

/** Whether a capture mode is mid-flight (UI should show a spinner / map). */
export function isCaptureActive(mode: CaptureMode): boolean {
  return mode === 'locating' || mode === 'manual';
}

// ─── Internal ────────────────────────────────────────────────────────────

function roundToPrecision(value: number, dp: number): number {
  // Math.round vs toFixed: toFixed returns a string, which would
  // require parseFloat to round-trip — both lossy + slow. Math.round
  // keeps it as a number throughout. The `+ Number.EPSILON` nudge
  // would defend against `0.1 + 0.2`-style float artefacts, but the
  // GPS pipeline doesn't accumulate them and we want byte-exact
  // round-trips for the test suite.
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}
