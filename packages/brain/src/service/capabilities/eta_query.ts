/**
 * `eta_query` capability — estimated time of arrival for a transit service.
 *
 * This is the capability used in the "service-discovery scenario": the user's Dina
 * asks a transit provider's Dina "when will you reach my location?".
 *
 * Source: brain/src/service/capabilities/eta_query.py  (Pydantic models)
 *
 * Wire-format note: field names are snake_case to match the JSON body that
 * comes off a `service.query` / `service.response` wire message (see
 * `packages/core/src/d2d/service_bodies.ts`).
 *
 * We carry hand-written runtime validators for now; a future pass may replace
 * these with `ajv` driven by the JSON Schemas also exported here — the
 * schemas themselves are authoritative and published via the service
 * profile record in PDS.
 */

export interface Location {
  /** Latitude in degrees, -90..+90 inclusive. */
  lat: number;
  /** Longitude in degrees, -180..+180 inclusive. */
  lng: number;
}

/** Params for a `service.query` with capability `eta_query`.
 *
 * Canonical contract (MT-24-I2): `route_id` is the required discriminator;
 * `location` is optional. Mirrors `brain/src/service/capabilities/eta_query.py`.
 */
export interface EtaQueryParams {
  route_id: string;
  location?: Location;
}

/** Structured vehicle/service status values. */
export type EtaQueryStatus = 'on_route' | 'not_on_route' | 'out_of_service' | 'not_found';

/** Result body for a `service.response` with capability `eta_query`.
 *
 * `status` is the only required field. The other fields are optional
 * because the four terminal statuses surface different shapes —
 * `out_of_service` / `not_found` legitimately omit `eta_minutes`.
 */
export interface EtaQueryResult {
  status: EtaQueryStatus;
  eta_minutes?: number;
  vehicle_type?: string;
  route_name?: string;
  stop_name?: string;
  stop_distance_m?: number;
  map_url?: string;
  message?: string;
}

/**
 * JSON Schema (draft-07) for `EtaQueryParams`. Published in the service
 * profile so requesters can validate before sending, and so the provider's
 * `schema_hash` check has something authoritative to hash.
 *
 * **Cross-stack canonical form (MT-24-I2).** This object is byte-identical
 * to the Python reference at `brain/src/service/capabilities/eta_query.py`
 * and the Go reference at `core/test/canonical_hash_test.go`. The pinned
 * canonical hash for `{description, params, result}` is
 * `2886d1f82453b418f4e620219681b897cdfa536c2d9ee9b0f524605107117a71` and is
 * locked in by `__tests__/service/capabilities/canonical_hash_parity.test.ts`.
 *
 * Why this is intentionally LOOSE:
 *   - `required: ["route_id"]` (NOT `["location"]`). The route id is the
 *     provider-discriminating field; location can be inferred at the
 *     provider end. Strictening would diverge from main-dina and the seeded
 *     test fixtures.
 *   - No `$schema` / `title` / `additionalProperties` / range constraints.
 *     Anything beyond the minimal `{type, required, properties}` keys would
 *     be canonicalised into the hash and break interop.
 */
export const EtaQueryParamsSchema = {
  type: 'object',
  required: ['route_id'],
  properties: {
    route_id: { type: 'string' },
    location: {
      type: 'object',
      required: ['lat', 'lng'],
      properties: {
        lat: { type: 'number' },
        lng: { type: 'number' },
      },
    },
  },
} as const;

/**
 * JSON Schema (draft-07) for `EtaQueryResult`. Same cross-stack
 * canonical-form rules as `EtaQueryParamsSchema` above.
 *
 * `status` is the only required field — the four terminal statuses
 * (on_route / not_on_route / out_of_service / not_found) drive everything
 * else. `eta_minutes` only makes sense for `on_route`, so requiring it
 * would make valid `out_of_service` / `not_found` responses fail
 * validation. Mirrors the service-discovery demo contract.
 */
export const EtaQueryResultSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: {
      type: 'string',
      enum: ['on_route', 'not_on_route', 'out_of_service', 'not_found'],
    },
    eta_minutes: { type: 'integer' },
    route_name: { type: 'string' },
    vehicle_type: { type: 'string' },
    stop_name: { type: 'string' },
    stop_distance_m: { type: 'number' },
    map_url: { type: 'string' },
    message: { type: 'string' },
  },
} as const;

// ---------------------------------------------------------------------------
// Hand-written runtime validators.
// These mirror the JSON Schemas above; a Phase 4 pass will delete them in
// favour of ajv driven by the schema objects directly.
// ---------------------------------------------------------------------------

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function validateLocation(loc: unknown, path: string): string | null {
  if (!loc || typeof loc !== 'object') {
    return `${path}: must be a JSON object`;
  }
  const l = loc as Record<string, unknown>;
  // Canonical schema requires lat + lng but doesn't pin a numeric range
  // (cross-stack interop — see EtaQueryParamsSchema above). The runtime
  // validator stays in lockstep — anything stricter would mis-report a
  // wire-valid query as malformed, and the rounded canonical hash test
  // would never catch the drift because it only hashes the schema, not
  // this validator.
  if (!isFiniteNumber(l.lat)) return `${path}.lat: must be a finite number`;
  if (!isFiniteNumber(l.lng)) return `${path}.lng: must be a finite number`;
  return null;
}

/**
 * Validate `EtaQueryParams`. Returns `null` on success.
 *
 * Canonical contract (MT-24-I2): `route_id` is required, `location` is
 * optional. Used as the registry-fallback validator only — the wire-path
 * `ServiceHandler` calls `validateAgainstSchema(params, published.params)`
 * which validates against the published JSON Schema directly (so this
 * function and the published schema must stay in lockstep — see
 * `EtaQueryParamsSchema` above).
 */
export function validateEtaQueryParams(params: unknown): string | null {
  if (!params || typeof params !== 'object') {
    return 'eta_query params: must be a JSON object';
  }
  const p = params as Record<string, unknown>;

  if (typeof p.route_id !== 'string' || p.route_id === '') {
    return 'eta_query params.route_id: must be a non-empty string';
  }
  if (p.location !== undefined) {
    const locErr = validateLocation(p.location, 'eta_query params.location');
    if (locErr !== null) return locErr;
  }
  return null;
}

const ALLOWED_STATUSES: ReadonlySet<string> = new Set([
  'on_route',
  'not_on_route',
  'out_of_service',
  'not_found',
]);

/**
 * Validate `EtaQueryResult`. Returns `null` on success.
 *
 * Canonical contract (MT-24-I2): `status` is the only required field.
 * `eta_minutes` only makes sense for `status: 'on_route'`, so requiring it
 * unconditionally would reject valid `out_of_service` / `not_found`
 * responses. Same lockstep-with-published-schema discipline as
 * `validateEtaQueryParams`.
 */
export function validateEtaQueryResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') {
    return 'eta_query result: must be a JSON object';
  }
  const r = result as Record<string, unknown>;

  if (typeof r.status !== 'string' || !ALLOWED_STATUSES.has(r.status)) {
    return `eta_query result.status: must be one of ${Array.from(ALLOWED_STATUSES).join('|')}`;
  }
  if (
    r.eta_minutes !== undefined &&
    (!isFiniteNumber(r.eta_minutes) || !Number.isInteger(r.eta_minutes))
  ) {
    return 'eta_query result.eta_minutes: must be an integer when present';
  }
  if (r.vehicle_type !== undefined && typeof r.vehicle_type !== 'string') {
    return 'eta_query result.vehicle_type: must be a string when present';
  }
  if (r.route_name !== undefined && typeof r.route_name !== 'string') {
    return 'eta_query result.route_name: must be a string when present';
  }
  if (r.stop_name !== undefined && typeof r.stop_name !== 'string') {
    return 'eta_query result.stop_name: must be a string when present';
  }
  if (
    r.stop_distance_m !== undefined &&
    (!isFiniteNumber(r.stop_distance_m) || r.stop_distance_m < 0)
  ) {
    return 'eta_query result.stop_distance_m: must be a non-negative finite number';
  }
  if (r.map_url !== undefined && typeof r.map_url !== 'string') {
    return 'eta_query result.map_url: must be a string when present';
  }
  if (r.message !== undefined && typeof r.message !== 'string') {
    return 'eta_query result.message: must be a string when present';
  }
  return null;
}
