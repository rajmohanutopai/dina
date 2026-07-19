/**
 * Task 6.12 — `com.dinakernel.service.search` xRPC client.
 *
 * AppView's service-search endpoint returns providers ranked by
 * (capability match, geographic distance, PeerLens rating). Brain
 * calls this when the reasoning agent decides a user question
 * needs live data from a service:
 *
 *   User: "when does bus 42 reach Castro?"
 *    → search(capability="eta_query", location={...})
 *    → AppView returns candidate providers sorted by distance.
 *    → Brain picks the top candidate + issues a `service.query`.
 *
 * **Response shape** — the AppView wire is camelCase; this client
 * translates to the original snake_case `ServiceMatch` shape that
 * the rest of the lite codebase consumes.
 *
 * AppView returns (per service):
 *   {
 *     "operatorDid": "did:plc:demoprovider",
 *     "name": "SF Transit Authority",
 *     "capabilities": ["eta_query", ...],
 *     "capabilitySchemas": { eta_query: { description, params, result, schema_hash } },
 *     "matchedCapability": "eta_query",
 *     "matchedSchema": { description, params, result, schema_hash },
 *     "matchedSchemaHash": "<sha256>",
 *     "distanceKm": 2.3,
 *     "trustScore": 0.92,
 *     ...
 *   }
 *
 * The client picks the flat `matched*` + `trustScore` + `distanceKm`
 * fields and maps them to the snake_case `ServiceMatch` interface.
 * `schema` and `schema_hash` are nullable: an operator can publish a
 * service.profile without a capability schema, in which case the
 * requester must either skip or fall back to schemaless queries.
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

import { parseServiceListingUri, classifyCapability } from '@dina/protocol';

import type { XrpcFetchResult } from './peerlens_resolve_client';

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
  /**
   * AT-URI of THIS specific listing
   * (`at://<did>/com.dinakernel.service.profile/<rkey>`). A provider DID may
   * publish many listings (marketplace multi-listing per DID); this is how a
   * caller later passes `service_uri` on the `service.query` to disambiguate
   * which one it picked. Mirrors the Brain-side search result, which preserves
   * the same uri end-to-end.
   */
  uri: string;
  operatorDid: string;
  name: string;
  capability: string;
  /**
   * The capability schema the provider published (description +
   * params + result). `null` when the operator's service profile
   * didn't include a schema for this capability — consumers must
   * either skip such providers or fall back to schemaless queries.
   */
  schema: {
    description: string;
    params: Record<string, unknown>;
    result: Record<string, unknown>;
  } | null;
  /** SHA-256 of the canonical schema. `null` when no schema published. */
  schema_hash: string | null;
  /** Kilometres from the requesting user's location. -1 when unknown. */
  distance_km: number;
  /** 0..1 PeerLens rating from PeerLens. null when no PeerLens data. */
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

const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.:-]+)$/;

/**
 * A searchable capability is EITHER a registry capability (flat, e.g.
 * `eta_query`, possibly via an alias) OR a provider-owned namespaced custom
 * capability (reverse-DNS dotted, e.g. `com.acme.widget_price`) — the OPEN
 * vocabulary half of the "any customer can create their own service" model.
 * Both are accepted via the SHARED `classifyCapability` (same registry the
 * AppView ingester + service-search use, so HNL's accept-set matches what the
 * index will actually match); only a genuinely-unknown flat string is rejected.
 */
function isSearchableCapability(raw: string): boolean {
  return classifyCapability(raw).kind !== 'unknown';
}

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
    if (!isSearchableCapability(input.capability)) {
      return `capability "${input.capability}" is not a known registry or namespaced custom capability`;
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

interface ParseOk { ok: true; response: ServiceSearchResponse }
interface ParseFail { ok: false; reason: 'malformed_response'; detail: string }

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
    // The listing uri is required to disambiguate multi-listing providers
    // downstream (it rides the `service.query` as `service_uri`). Bind it to a
    // well-formed `com.dinakernel.service.profile/<rkey>` listing URI — the same
    // gate `parseServiceListingUri` applies everywhere else — and skip rows
    // whose uri is missing/malformed rather than emit an unusable match. The
    // listing's authority must also be the matched operator (a result can't
    // hand us a uri under a different DID).
    if (typeof e.uri !== 'string') continue;
    const listing = parseServiceListingUri(e.uri);
    if (listing === null || listing.did !== e.operatorDid) continue;
    // AppView emits the matched capability (the one the caller asked
    // for, normalized) as `matchedCapability`. The flat shape lets us
    // skip walking the full `capabilities` array. It may be a registry
    // capability OR a provider-owned namespaced custom (open vocabulary),
    // so accept both via the shared `classifyCapability` gate — the same
    // accept-set the request-side `isSearchableCapability` uses.
    if (
      typeof e.matchedCapability !== 'string' ||
      !isSearchableCapability(e.matchedCapability)
    ) continue;
    // `matchedSchema` is the capability schema entry the operator
    // published for this capability; `null` when none was published.
    // We accept either case but skip rows with malformed schemas so
    // downstream callers don't have to defend against them.
    let schema: ServiceMatch['schema'] = null;
    let schemaHash: string | null = null;
    if (e.matchedSchema !== null && e.matchedSchema !== undefined) {
      if (typeof e.matchedSchema !== 'object' || Array.isArray(e.matchedSchema)) continue;
      const schemaObj = e.matchedSchema as Record<string, unknown>;
      const description = typeof schemaObj.description === 'string' ? schemaObj.description : '';
      if (
        schemaObj.params === null ||
        typeof schemaObj.params !== 'object' ||
        Array.isArray(schemaObj.params)
      ) continue;
      if (
        schemaObj.result === null ||
        typeof schemaObj.result !== 'object' ||
        Array.isArray(schemaObj.result)
      ) continue;
      schema = {
        description,
        params: schemaObj.params as Record<string, unknown>,
        result: schemaObj.result as Record<string, unknown>,
      };
      if (typeof e.matchedSchemaHash === 'string' && e.matchedSchemaHash !== '') {
        schemaHash = e.matchedSchemaHash;
      }
    }
    const distance =
      typeof e.distanceKm === 'number' && Number.isFinite(e.distanceKm)
        ? e.distanceKm
        : -1;
    const trustScore =
      typeof e.trustScore === 'number' && Number.isFinite(e.trustScore)
        ? e.trustScore
        : null;
    services.push({
      uri: e.uri,
      operatorDid: e.operatorDid,
      name: e.name,
      capability: e.matchedCapability,
      schema,
      schema_hash: schemaHash,
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
