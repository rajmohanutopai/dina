/**
 * Task 6.13 — `com.dina.service.getProfile` xRPC client.
 *
 * Where `service.search` (6.12) returns many services ranked by
 * distance / trust, `service.getProfile` fetches a SINGLE service
 * profile by operator DID. Brain calls this when:
 *
 *   - Expanding a search result: the search endpoint returns
 *     summary fields; `getProfile` returns the full profile
 *     (description, all capabilities, serviceArea, responsePolicy).
 *   - Refreshing a cached provider after a stale schema_hash: the
 *     provider published a new schema; we need the updated profile
 *     + hash to retry the D2D query.
 *   - Admin UI "inspect service" pages that show the full record.
 *
 * **Response shape** — the full `com.dina.service.profile` record
 * plus AppView-computed trust context:
 *
 *   {
 *     "operatorDid": "did:plc:...",
 *     "profile": <ServiceProfileRecord from 6.17>,
 *     "indexedAtMs": 1234567890000,
 *     "trustScore": 0.92,
 *     "trustRing": 2 | null
 *   }
 *
 * **Error taxonomy** identical to trust-resolve (6.11):
 * `invalid_did` / `not_found` / `malformed_response` /
 * `rejected_by_appview` / `network_error`.
 *
 * **Schema-hash integrity**: the client validates that every
 * capability's `schema_hash` is a 64-char lowercase hex string
 * before accepting the response. A profile with a missing / bad
 * hash is malformed (AppView bug or adversarial firehose entry).
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6d task 6.13.
 */

import type { XrpcFetchResult } from './trust_resolve_client';
import type {
  ResponsePolicy,
  ServiceAreaInput,
} from './profile_builder';

/** Profile record with the full capability set — matches 6.17's ProfileBuilder output. */
export interface ServiceProfileView {
  $type: 'com.dina.service.profile';
  operatorDid: string;
  name: string;
  isPublic: boolean;
  capabilities: string[];
  capabilitySchemas: Record<string, CapabilitySchemaView>;
  responsePolicy: Record<string, ResponsePolicy>;
  serviceArea?: ServiceAreaInput;
}

export interface CapabilitySchemaView {
  description: string;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  schema_hash: string;
}

export interface GetProfileResponse {
  operatorDid: string;
  profile: ServiceProfileView;
  /** UTC ms the AppView indexed this profile. */
  indexedAtMs: number;
  /** Trust score from the network — null when unknown. */
  trustScore: number | null;
  /** Caller's ring distance to this operator (1/2/3) — null when unknown. */
  trustRing: 1 | 2 | 3 | null;
}

export interface GetProfileRequest {
  operatorDid: string;
}

export type GetProfileRejectionReason =
  | 'invalid_did'
  | 'not_found'
  | 'malformed_response'
  | 'network_error'
  | 'rejected_by_appview';

export type GetProfileOutcome =
  | { ok: true; response: GetProfileResponse }
  | { ok: false; reason: 'invalid_did'; detail: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'malformed_response'; detail: string }
  | { ok: false; reason: 'network_error'; error: string }
  | { ok: false; reason: 'rejected_by_appview'; status: number; error: string };

export type GetProfileFetchFn = (
  input: GetProfileRequest,
) => Promise<XrpcFetchResult>;

export interface GetProfileClientOptions {
  fetchFn: GetProfileFetchFn;
  onEvent?: (event: GetProfileEvent) => void;
}

export type GetProfileEvent =
  | { kind: 'fetched'; operatorDid: string; capabilityCount: number }
  | { kind: 'rejected'; operatorDid: string; reason: GetProfileRejectionReason };

const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.:-]+)$/;
const SCHEMA_HASH_RE = /^[0-9a-f]{64}$/;
const CAPABILITY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const VALID_POLICIES: ReadonlySet<ResponsePolicy> = new Set([
  'auto',
  'review',
  'manual',
]);

/**
 * Create the `service.getProfile` xRPC client. Returns a function
 * that accepts a `{operatorDid}` request and resolves to a typed
 * outcome.
 */
export function createGetProfileClient(
  opts: GetProfileClientOptions,
): (input: GetProfileRequest) => Promise<GetProfileOutcome> {
  if (typeof opts?.fetchFn !== 'function') {
    throw new TypeError('createGetProfileClient: fetchFn is required');
  }
  const fetchFn = opts.fetchFn;
  const onEvent = opts.onEvent;

  return async function getProfile(
    input: GetProfileRequest,
  ): Promise<GetProfileOutcome> {
    const did = typeof input?.operatorDid === 'string' ? input.operatorDid.trim() : '';
    if (did === '' || !DID_RE.test(did)) {
      onEvent?.({
        kind: 'rejected',
        operatorDid: String(input?.operatorDid ?? ''),
        reason: 'invalid_did',
      });
      return {
        ok: false,
        reason: 'invalid_did',
        detail: 'operatorDid must be did:plc or did:web',
      };
    }

    let result: XrpcFetchResult;
    try {
      result = await fetchFn({ operatorDid: did });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent?.({ kind: 'rejected', operatorDid: did, reason: 'network_error' });
      return { ok: false, reason: 'network_error', error: msg };
    }

    if (result.status === 404 || result.body === null) {
      onEvent?.({ kind: 'rejected', operatorDid: did, reason: 'not_found' });
      return { ok: false, reason: 'not_found' };
    }
    if (result.status < 200 || result.status >= 300) {
      const msg = typeof (result.body as { error?: unknown })?.error === 'string'
        ? ((result.body as { error: string }).error)
        : `status ${result.status}`;
      onEvent?.({
        kind: 'rejected',
        operatorDid: did,
        reason: 'rejected_by_appview',
      });
      return {
        ok: false,
        reason: 'rejected_by_appview',
        status: result.status,
        error: msg,
      };
    }

    const parsed = parseResponse(result.body, did);
    if (!parsed.ok) {
      onEvent?.({
        kind: 'rejected',
        operatorDid: did,
        reason: 'malformed_response',
      });
      return parsed;
    }
    onEvent?.({
      kind: 'fetched',
      operatorDid: did,
      capabilityCount: parsed.response.profile.capabilities.length,
    });
    return parsed;
  };
}

// ── Internals ──────────────────────────────────────────────────────────

type ParseOk = { ok: true; response: GetProfileResponse };
type ParseFail = { ok: false; reason: 'malformed_response'; detail: string };

function parseResponse(
  body: Record<string, unknown>,
  requestedDid: string,
): ParseOk | ParseFail {
  const operatorDid = body.operatorDid;
  if (typeof operatorDid !== 'string' || operatorDid !== requestedDid) {
    return {
      ok: false,
      reason: 'malformed_response',
      detail: `body.operatorDid "${String(operatorDid)}" does not match requested "${requestedDid}"`,
    };
  }
  const profile = parseProfile(body.profile, operatorDid);
  if (!profile.ok) return profile;

  const indexedAtMs =
    typeof body.indexedAtMs === 'number' &&
    Number.isInteger(body.indexedAtMs) &&
    body.indexedAtMs >= 0
      ? body.indexedAtMs
      : null;
  if (indexedAtMs === null) {
    return {
      ok: false,
      reason: 'malformed_response',
      detail: 'indexedAtMs must be a non-negative integer',
    };
  }
  const trustScore =
    typeof body.trustScore === 'number' && Number.isFinite(body.trustScore)
      ? body.trustScore
      : null;
  const trustRing =
    body.trustRing === 1 || body.trustRing === 2 || body.trustRing === 3
      ? (body.trustRing as 1 | 2 | 3)
      : null;

  return {
    ok: true,
    response: {
      operatorDid,
      profile: profile.value,
      indexedAtMs,
      trustScore,
      trustRing,
    },
  };
}

type ProfileParseOk = { ok: true; value: ServiceProfileView };
function parseProfile(
  raw: unknown,
  operatorDid: string,
): ProfileParseOk | ParseFail {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      reason: 'malformed_response',
      detail: 'profile must be an object',
    };
  }
  const p = raw as Record<string, unknown>;
  if (p.$type !== 'com.dina.service.profile') {
    return {
      ok: false,
      reason: 'malformed_response',
      detail: `profile.$type must be "com.dina.service.profile" (got ${JSON.stringify(p.$type)})`,
    };
  }
  if (typeof p.name !== 'string' || p.name.trim() === '') {
    return {
      ok: false,
      reason: 'malformed_response',
      detail: 'profile.name must be a non-empty string',
    };
  }
  if (typeof p.isPublic !== 'boolean') {
    return {
      ok: false,
      reason: 'malformed_response',
      detail: 'profile.isPublic must be a boolean',
    };
  }
  if (!Array.isArray(p.capabilities)) {
    return {
      ok: false,
      reason: 'malformed_response',
      detail: 'profile.capabilities must be an array',
    };
  }
  const capabilities: string[] = [];
  for (const c of p.capabilities) {
    if (typeof c === 'string' && CAPABILITY_RE.test(c)) {
      capabilities.push(c);
    }
  }
  if (p.capabilitySchemas === null || typeof p.capabilitySchemas !== 'object' || Array.isArray(p.capabilitySchemas)) {
    return {
      ok: false,
      reason: 'malformed_response',
      detail: 'profile.capabilitySchemas must be an object',
    };
  }
  const capabilitySchemas: Record<string, CapabilitySchemaView> = {};
  const schemasRaw = p.capabilitySchemas as Record<string, unknown>;
  for (const [cap, schemaVal] of Object.entries(schemasRaw)) {
    if (!CAPABILITY_RE.test(cap)) continue;
    const schema = parseCapabilitySchema(schemaVal);
    if (schema === null) continue;
    capabilitySchemas[cap] = schema;
  }
  // Every declared capability must have a matching schema — AppView's
  // indexer guarantees this; if we see drift, the response is corrupt.
  for (const cap of capabilities) {
    if (!(cap in capabilitySchemas)) {
      return {
        ok: false,
        reason: 'malformed_response',
        detail: `capability "${cap}" declared but no matching schema`,
      };
    }
  }
  if (p.responsePolicy === null || typeof p.responsePolicy !== 'object' || Array.isArray(p.responsePolicy)) {
    return {
      ok: false,
      reason: 'malformed_response',
      detail: 'profile.responsePolicy must be an object',
    };
  }
  const responsePolicy: Record<string, ResponsePolicy> = {};
  for (const [cap, policy] of Object.entries(p.responsePolicy as Record<string, unknown>)) {
    if (
      typeof policy !== 'string' ||
      !VALID_POLICIES.has(policy as ResponsePolicy)
    ) {
      continue;
    }
    responsePolicy[cap] = policy as ResponsePolicy;
  }
  const view: ServiceProfileView = {
    $type: 'com.dina.service.profile',
    operatorDid,
    name: p.name,
    isPublic: p.isPublic,
    capabilities,
    capabilitySchemas,
    responsePolicy,
  };
  if (p.serviceArea !== undefined) {
    const sa = parseServiceArea(p.serviceArea);
    if (sa === null) {
      return {
        ok: false,
        reason: 'malformed_response',
        detail: 'profile.serviceArea must have numeric lat / lng / radiusKm',
      };
    }
    view.serviceArea = sa;
  }
  return { ok: true, value: view };
}

function parseCapabilitySchema(raw: unknown): CapabilitySchemaView | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.description !== 'string') return null;
  if (s.params === null || typeof s.params !== 'object' || Array.isArray(s.params)) return null;
  if (s.result === null || typeof s.result !== 'object' || Array.isArray(s.result)) return null;
  if (typeof s.schema_hash !== 'string' || !SCHEMA_HASH_RE.test(s.schema_hash)) {
    return null;
  }
  return {
    description: s.description,
    params: s.params as Record<string, unknown>,
    result: s.result as Record<string, unknown>,
    schema_hash: s.schema_hash,
  };
}

function parseServiceArea(raw: unknown): ServiceAreaInput | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.lat !== 'number' || !Number.isFinite(a.lat) || a.lat < -90 || a.lat > 90) {
    return null;
  }
  if (typeof a.lng !== 'number' || !Number.isFinite(a.lng) || a.lng < -180 || a.lng > 180) {
    return null;
  }
  if (
    typeof a.radiusKm !== 'number' ||
    !Number.isFinite(a.radiusKm) ||
    a.radiusKm <= 0
  ) {
    return null;
  }
  return { lat: a.lat, lng: a.lng, radiusKm: a.radiusKm };
}
