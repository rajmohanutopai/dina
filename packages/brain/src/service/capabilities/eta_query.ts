/**
 * `eta_query` capability — estimated time of arrival for a transit service.
 *
 * This is the capability used in the "Bus Driver Scenario": the user's Dina
 * asks a bus driver's Dina "when will you reach my location?".
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

/** Params for a `service.query` with capability `eta_query`. */
export interface EtaQueryParams {
  location: Location;
  /** Optional specific route identifier. Empty string means "any route". */
  route_id?: string;
}

/** Structured vehicle/service status values. */
export type EtaQueryStatus = 'on_route' | 'not_on_route' | 'out_of_service' | 'not_found';

/** Result body for a `service.response` with capability `eta_query`. */
export interface EtaQueryResult {
  eta_minutes: number;
  vehicle_type: string;
  route_name: string;
  current_location?: Location;

  // Optional extension fields. Senders should include these when available;
  // receivers must tolerate their absence while the capability schema evolves.
  stop_name?: string;
  stop_distance_m?: number;
  map_url?: string;
  status?: EtaQueryStatus;
  message?: string;
}

/**
 * JSON Schema (draft-07) for `EtaQueryParams`. Published in the service
 * profile so requesters can validate before sending, and so the provider's
 * `schema_hash` check has something authoritative to hash.
 */
export const EtaQueryParamsSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'EtaQueryParams',
  type: 'object',
  additionalProperties: false,
  required: ['location'],
  properties: {
    location: {
      type: 'object',
      additionalProperties: false,
      required: ['lat', 'lng'],
      properties: {
        lat: { type: 'number', minimum: -90, maximum: 90 },
        lng: { type: 'number', minimum: -180, maximum: 180 },
      },
    },
    route_id: { type: 'string' },
  },
} as const;

/** JSON Schema (draft-07) for `EtaQueryResult`. */
export const EtaQueryResultSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'EtaQueryResult',
  type: 'object',
  additionalProperties: false,
  required: ['eta_minutes', 'vehicle_type', 'route_name'],
  properties: {
    eta_minutes: { type: 'number', minimum: 0 },
    vehicle_type: { type: 'string' },
    route_name: { type: 'string' },
    current_location: {
      type: 'object',
      additionalProperties: false,
      required: ['lat', 'lng'],
      properties: {
        lat: { type: 'number', minimum: -90, maximum: 90 },
        lng: { type: 'number', minimum: -180, maximum: 180 },
      },
    },
    stop_name: { type: 'string' },
    stop_distance_m: { type: 'number', minimum: 0 },
    map_url: { type: 'string' },
    status: {
      type: 'string',
      enum: ['on_route', 'not_on_route', 'out_of_service', 'not_found'],
    },
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

function isInRange(x: number, lo: number, hi: number): boolean {
  return x >= lo && x <= hi;
}

function validateLocation(loc: unknown, path: string): string | null {
  if (!loc || typeof loc !== 'object') {
    return `${path}: must be a JSON object`;
  }
  const l = loc as Record<string, unknown>;
  if (!isFiniteNumber(l.lat) || !isInRange(l.lat, -90, 90)) {
    return `${path}.lat: must be a finite number in [-90, 90]`;
  }
  if (!isFiniteNumber(l.lng) || !isInRange(l.lng, -180, 180)) {
    return `${path}.lng: must be a finite number in [-180, 180]`;
  }
  // Reject extra properties per additionalProperties:false.
  for (const key of Object.keys(l)) {
    if (key !== 'lat' && key !== 'lng') {
      return `${path}: unexpected property "${key}"`;
    }
  }
  return null;
}

/** Validate `EtaQueryParams`. Returns `null` on success. */
export function validateEtaQueryParams(params: unknown): string | null {
  if (!params || typeof params !== 'object') {
    return 'eta_query params: must be a JSON object';
  }
  const p = params as Record<string, unknown>;

  const locErr = validateLocation(p.location, 'eta_query params.location');
  if (locErr !== null) {
    return locErr;
  }
  if (p.route_id !== undefined && typeof p.route_id !== 'string') {
    return 'eta_query params.route_id: must be a string when present';
  }
  for (const key of Object.keys(p)) {
    if (key !== 'location' && key !== 'route_id') {
      return `eta_query params: unexpected property "${key}"`;
    }
  }
  return null;
}

const ALLOWED_STATUSES: ReadonlySet<string> = new Set([
  'on_route',
  'not_on_route',
  'out_of_service',
  'not_found',
]);

/** Validate `EtaQueryResult`. Returns `null` on success. */
export function validateEtaQueryResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') {
    return 'eta_query result: must be a JSON object';
  }
  const r = result as Record<string, unknown>;

  if (!isFiniteNumber(r.eta_minutes) || r.eta_minutes < 0) {
    return 'eta_query result.eta_minutes: must be a non-negative finite number';
  }
  if (typeof r.vehicle_type !== 'string') {
    return 'eta_query result.vehicle_type: must be a string';
  }
  if (typeof r.route_name !== 'string') {
    return 'eta_query result.route_name: must be a string';
  }
  if (r.current_location !== undefined) {
    const err = validateLocation(r.current_location, 'eta_query result.current_location');
    if (err !== null) return err;
  }
  if (r.stop_name !== undefined && typeof r.stop_name !== 'string') {
    return 'eta_query result.stop_name: must be a string when present';
  }
  if (r.stop_distance_m !== undefined) {
    if (!isFiniteNumber(r.stop_distance_m) || r.stop_distance_m < 0) {
      return 'eta_query result.stop_distance_m: must be a non-negative finite number';
    }
  }
  if (r.map_url !== undefined && typeof r.map_url !== 'string') {
    return 'eta_query result.map_url: must be a string when present';
  }
  if (r.status !== undefined) {
    if (typeof r.status !== 'string' || !ALLOWED_STATUSES.has(r.status)) {
      return `eta_query result.status: must be one of ${Array.from(ALLOWED_STATUSES).join('|')}`;
    }
  }
  if (r.message !== undefined && typeof r.message !== 'string') {
    return 'eta_query result.message: must be a string when present';
  }

  const allowed = new Set([
    'eta_minutes',
    'vehicle_type',
    'route_name',
    'current_location',
    'stop_name',
    'stop_distance_m',
    'map_url',
    'status',
    'message',
  ]);
  for (const key of Object.keys(r)) {
    if (!allowed.has(key)) {
      return `eta_query result: unexpected property "${key}"`;
    }
  }
  return null;
}
