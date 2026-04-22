/**
 * Task 6.12 — `com.dina.service.search` xRPC client.
 *
 * AppView's service-search endpoint returns providers ranked by
 * (capability match, geographic distance, trust score). Brain
 * calls this when the reasoning agent decides a user question
 * needs live data from a service:
 *
 *   User: "when does bus 42 reach Castro?"
 *    → search(capability="eta_query", location={...})
 *    → AppView returns candidate providers sorted by distance.
 *    → Brain picks the top candidate + issues a `service.query`.
 *
 * **Response shape** matches the plan doc §1b:
 *
 *   {
 *     "services": [{
 *       "operatorDid": "did:plc:busdriver",
 *       "name": "SF Transit Authority",
 *       "capability": "eta_query",
 *       "schema": { params, result, description },
 *       "schema_hash": "<sha256>",
 *       "distance_km": 2.3,
 *       "trust_score": 0.92
 *     }]
 *   }
 *
 * **The schema is the capability schema** (task 6.17 `ProfileBuilder`
 * put it there). The requester reads `params_schema` to fill in the
 * query params, then sends the `schema_hash` along with the
 * `service.query` so the provider can detect stale-schema
 * mismatches.
 *
 * **Input validation**: the client enforces sensible limits on
 * `limit` (1–50), on location (`lat` ∈ [-90, 90], `lng` ∈ [-180, 180]),
 * and on capability-name shape (the same `[a-z][a-z0-9_]*` pattern
 * Dina uses for field names).
 *
 * **Never throws** — structured outcomes: `{ok: true, services}`,
 * `{ok: false, reason: 'invalid_input' | 'network_error' |
 * 'rejected_by_appview' | 'malformed_response'}`.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6d task 6.12.
 */

import type { XrpcFetchResult } from './trust_resolve_client';

export interface GeoLocation {
  lat: number;
  lng: number;
  /** Optional search radius in km. */
  radiusKm?: number;
}

export interface ServiceSearchRequest {
  /** Free-text query. Optional — capability can carry enough signal alone. */
  query?: string;
  /** Filter by capability name (e.g. "eta_query"). Matches providers exposing that capability. */
  capability?: string;
  /** Geographic ranking context. */
  location?: GeoLocation;
  /** Max results. Clamped to [1, 50]. Defaults to 10. */
  limit?: number;
  /** Restrict to providers in a specific trust ring. */
  minRing?: 1 | 2 | 3;
}

/** One matched service in the response. */
export interface ServiceMatch {
  operatorDid: string;
  name: string;
  capability: string;
  /**
   * The capability schema the provider published (description +
   * params + result). Consumers validate inbound queries against
   * params before building the payload.
   */
  schema: {
    description: string;
    params: Record<string, unknown>;
    result: Record<string, unknown>;
  };
  /** SHA-256 of the canonical schema — sent alongside service.query. */
  schema_hash: string;
  /** Kilometres from the requesting user's location. -1 when unknown. */
  distance_km: number;
  /** 0..1 trust score from the Trust Network. null when no trust data. */
  trust_score: number | null;
}

export interface ServiceSearchResponse {
  services: ServiceMatch[];
  /** Total matches AppView has — `services.length` may be less due to `limit`. */
  total: number;
}

export type ServiceSearchOutcome =
  | { ok: true; response: ServiceSearchResponse }
  | { ok: false; reason: 'invalid_input'; detail: string }
  | { ok: false; reason: 'network_error'; error: string }
  | { ok: false; reason: 'rejected_by_appview'; status: number; error: string }
  | { ok: false; reason: 'malformed_response'; detail: string };

export type ServiceSearchFetchFn = (
  input: ServiceSearchRequest,
) => Promise<XrpcFetchResult>;

export interface ServiceSearchClientOptions {
  fetchFn: ServiceSearchFetchFn;
  onEvent?: (event: ServiceSearchEvent) => void;
}

export type ServiceSearchEvent =
  | { kind: 'searched'; capability: string | undefined; resultCount: number }
  | { kind: 'rejected'; reason: string; detail?: string };

export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 10;

const CAPABILITY_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.:-]+)$/;

/**
 * Create the service-search xRPC client. Returns an
 * `(input) => Promise<ServiceSearchOutcome>` function the caller
 * wires into the reasoning pipeline.
 */
export function createServiceSearchClient(
  opts: ServiceSearchClientOptions,
): (input: ServiceSearchRequest) => Promise<ServiceSearchOutcome> {
  if (typeof opts?.fetchFn !== 'function') {
    throw new TypeError('createServiceSearchClient: fetchFn is required');
  }
  const fetchFn = opts.fetchFn;
  const onEvent = opts.onEvent;

  return async function search(
    input: ServiceSearchRequest,
  ): Promise<ServiceSearchOutcome> {
    const validation = validateInput(input);
    if (validation !== null) {
      onEvent?.({
        kind: 'rejected',
        reason: 'invalid_input',
        detail: validation,
      });
      return { ok: false, reason: 'invalid_input', detail: validation };
    }
    const normalised = normaliseInput(input);

    let result: XrpcFetchResult;
    try {
      result = await fetchFn(normalised);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent?.({ kind: 'rejected', reason: 'network_error', detail: msg });
      return { ok: false, reason: 'network_error', error: msg };
    }

    if (result.status < 200 || result.status >= 300) {
      const msg = typeof (result.body as { error?: unknown })?.error === 'string'
        ? ((result.body as { error: string }).error)
        : `status ${result.status}`;
      onEvent?.({
        kind: 'rejected',
        reason: 'rejected_by_appview',
        detail: msg,
      });
      return {
        ok: false,
        reason: 'rejected_by_appview',
        status: result.status,
        error: msg,
      };
    }

    if (result.body === null) {
      // Treat missing body on 2xx as an empty result set rather than
      // an error — AppView has been known to return 200 with null.
      onEvent?.({
        kind: 'searched',
        capability: normalised.capability,
        resultCount: 0,
      });
      return { ok: true, response: { services: [], total: 0 } };
    }

    const parsed = parseResponse(result.body);
    if (!parsed.ok) {
      onEvent?.({
        kind: 'rejected',
        reason: 'malformed_response',
        detail: parsed.detail,
      });
      return parsed;
    }
    onEvent?.({
      kind: 'searched',
      capability: normalised.capability,
      resultCount: parsed.response.services.length,
    });
    return { ok: true, response: parsed.response };
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validateInput(input: ServiceSearchRequest | null | undefined): string | null {
  if (input === null || input === undefined || typeof input !== 'object') {
    return 'request must be an object';
  }
  if (input.capability !== undefined) {
    if (typeof input.capability !== 'string') return 'capability must be a string';
    if (!CAPABILITY_NAME_RE.test(input.capability)) {
      return `capability "${input.capability}" must match ${CAPABILITY_NAME_RE}`;
    }
  }
  if (input.query !== undefined) {
    if (typeof input.query !== 'string') return 'query must be a string';
    if (input.query.length > 1000) return 'query must be <= 1000 chars';
  }
  if (input.location !== undefined) {
    const loc = input.location;
    if (
      loc === null ||
      typeof loc !== 'object' ||
      typeof loc.lat !== 'number' ||
      typeof loc.lng !== 'number'
    ) {
      return 'location must have numeric lat + lng';
    }
    if (!Number.isFinite(loc.lat) || loc.lat < -90 || loc.lat > 90) {
      return 'location.lat must be in [-90, 90]';
    }
    if (!Number.isFinite(loc.lng) || loc.lng < -180 || loc.lng > 180) {
      return 'location.lng must be in [-180, 180]';
    }
    if (loc.radiusKm !== undefined) {
      if (
        typeof loc.radiusKm !== 'number' ||
        !Number.isFinite(loc.radiusKm) ||
        loc.radiusKm <= 0
      ) {
        return 'location.radiusKm must be > 0';
      }
    }
  }
  if (input.limit !== undefined) {
    if (
      typeof input.limit !== 'number' ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_SEARCH_LIMIT
    ) {
      return `limit must be integer in [1, ${MAX_SEARCH_LIMIT}]`;
    }
  }
  if (input.minRing !== undefined) {
    if (input.minRing !== 1 && input.minRing !== 2 && input.minRing !== 3) {
      return 'minRing must be 1, 2, or 3';
    }
  }
  return null;
}

function normaliseInput(input: ServiceSearchRequest): ServiceSearchRequest {
  return {
    ...input,
    limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
  };
}

type ParseOk = { ok: true; response: ServiceSearchResponse };
type ParseFail = { ok: false; reason: 'malformed_response'; detail: string };

function parseResponse(body: Record<string, unknown>): ParseOk | ParseFail {
  if (!Array.isArray(body.services)) {
    return {
      ok: false,
      reason: 'malformed_response',
      detail: 'body.services must be an array',
    };
  }
  const services: ServiceMatch[] = [];
  for (const entry of body.services) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.operatorDid !== 'string' || !DID_RE.test(e.operatorDid)) continue;
    if (typeof e.name !== 'string' || e.name === '') continue;
    if (typeof e.capability !== 'string' || !CAPABILITY_NAME_RE.test(e.capability)) continue;
    if (e.schema === null || typeof e.schema !== 'object' || Array.isArray(e.schema)) continue;
    const schemaObj = e.schema as Record<string, unknown>;
    if (typeof schemaObj.description !== 'string') continue;
    if (schemaObj.params === null || typeof schemaObj.params !== 'object' || Array.isArray(schemaObj.params)) {
      continue;
    }
    if (schemaObj.result === null || typeof schemaObj.result !== 'object' || Array.isArray(schemaObj.result)) {
      continue;
    }
    if (typeof e.schema_hash !== 'string' || e.schema_hash === '') continue;
    const distance =
      typeof e.distance_km === 'number' && Number.isFinite(e.distance_km)
        ? e.distance_km
        : -1;
    const trustScore =
      typeof e.trust_score === 'number' && Number.isFinite(e.trust_score)
        ? e.trust_score
        : null;
    services.push({
      operatorDid: e.operatorDid,
      name: e.name,
      capability: e.capability,
      schema: {
        description: schemaObj.description,
        params: schemaObj.params as Record<string, unknown>,
        result: schemaObj.result as Record<string, unknown>,
      },
      schema_hash: e.schema_hash,
      distance_km: distance,
      trust_score: trustScore,
    });
  }
  const total =
    typeof body.total === 'number' && Number.isInteger(body.total) && body.total >= 0
      ? body.total
      : services.length;
  return { ok: true, response: { services, total } };
}
