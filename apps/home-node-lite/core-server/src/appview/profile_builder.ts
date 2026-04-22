/**
 * Task 6.17 — service profile builder.
 *
 * When a Home Node exposes a D2D capability (bus schedule, recipe
 * lookup, transit ETA, …), it publishes a `com.dina.service.profile`
 * record to its AT Protocol PDS (task 6.19 handles the actual
 * publish; this module just builds the record body). The record is
 * indexed by AppView (`appview/src/ingester/handlers/service-profile.ts`)
 * + served back in search results to requesters.
 *
 * **Record shape** — mirrors the SF-Transit plan doc §1a
 * ("Service Profile with JSON Schema"):
 *
 *   {
 *     "$type": "com.dina.service.profile",
 *     "name": "…",
 *     "isPublic": true,
 *     "capabilities": ["eta_query", …],
 *     "capabilitySchemas": {
 *       "eta_query": {
 *         "description": "…",
 *         "params": { /* JSON Schema *\/ },
 *         "result": { /* JSON Schema *\/ },
 *         "schema_hash": "<sha256 of the 3 keys above, canonical>"
 *       }
 *     },
 *     "serviceArea": { "lat": …, "lng": …, "radiusKm": … },
 *     "responsePolicy": { "eta_query": "auto" | "review" | "manual" }
 *   }
 *
 * **Contract** (pinned by tests):
 *   - `schema_hash` is SHA-256 of `{description, params, result}`
 *     canonicalised per task 6.18. NOT the whole capability object
 *     (description + params + result only — not the hash itself, and
 *     not any future fields that get added). This is what the
 *     provider + requester agree to hash on.
 *   - `capabilities` is auto-derived from the `capabilitySchemas`
 *     keys, sorted lexicographically for determinism. Callers can
 *     omit it — if they pass it, it must match the keys.
 *   - Invalid input throws with a descriptive error. No silent
 *     coercion: a bad config means "don't publish this" not "publish
 *     an inconsistent record".
 *   - Input is deep-cloned via `structuredClone` before writing —
 *     callers can mutate the config they passed in without
 *     corrupting the built profile.
 *
 * **Pure function** — no network, no filesystem, no clock. Tests
 * build a profile + assert on its shape.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6e task 6.17.
 */

import { computeSchemaHash } from './schema_hash';

/** JSON Schema fragment for a capability's params + result. Kept opaque. */
export type JsonSchema = Record<string, unknown>;

/** How the provider plans to handle inbound queries for a capability. */
export type ResponsePolicy = 'auto' | 'review' | 'manual';

export interface CapabilitySchemaInput {
  description: string;
  params: JsonSchema;
  result: JsonSchema;
}

export interface ServiceAreaInput {
  lat: number;
  lng: number;
  /** Radius in kilometres. Must be > 0. */
  radiusKm: number;
}

export interface BuildProfileInput {
  /** Human-facing service name. */
  name: string;
  /**
   * When true, the AppView surfaces this profile in `service.search`.
   * False → private: useful for services that only respond to known
   * DIDs from the operator's contact list.
   */
  isPublic: boolean;
  /** Capability → schema. Each schema gets a computed `schema_hash`. */
  capabilitySchemas: Record<string, CapabilitySchemaInput>;
  /** Capability → response policy. Must match keys of `capabilitySchemas`. */
  responsePolicy: Record<string, ResponsePolicy>;
  /** Optional geo footprint — lets AppView rank by distance. */
  serviceArea?: ServiceAreaInput;
  /**
   * Optional explicit capability list. When present, must equal
   * `Object.keys(capabilitySchemas)`. Prevents silent drift between
   * the schema block + the capability index.
   */
  capabilities?: string[];
}

export interface CapabilitySchemaRecord {
  description: string;
  params: JsonSchema;
  result: JsonSchema;
  schema_hash: string;
}

export interface ServiceProfileRecord {
  $type: 'com.dina.service.profile';
  name: string;
  isPublic: boolean;
  capabilities: string[];
  capabilitySchemas: Record<string, CapabilitySchemaRecord>;
  responsePolicy: Record<string, ResponsePolicy>;
  serviceArea?: ServiceAreaInput;
}

export const SERVICE_PROFILE_TYPE = 'com.dina.service.profile' as const;
const VALID_POLICIES: ReadonlySet<ResponsePolicy> = new Set([
  'auto',
  'review',
  'manual',
]);

/**
 * Build a `com.dina.service.profile` record ready to be written via
 * `PDSClient.putRecord` (task 6.4). Throws a `RangeError` or
 * `TypeError` with a descriptive message on invalid input — the
 * caller (admin UI "publish profile" button) surfaces this directly.
 */
export function buildServiceProfile(
  input: BuildProfileInput,
): ServiceProfileRecord {
  // Clone first so we can mutate locally without touching the caller's object.
  const cloned = structuredClone(input);

  validateName(cloned.name);
  if (typeof cloned.isPublic !== 'boolean') {
    throw new TypeError('buildServiceProfile: isPublic must be a boolean');
  }

  const schemaKeys = Object.keys(cloned.capabilitySchemas ?? {});
  if (schemaKeys.length === 0) {
    throw new RangeError(
      'buildServiceProfile: capabilitySchemas must declare at least one capability',
    );
  }

  // Sorted + de-duplicated capability list. Sorted = stable hash
  // across restarts even if the caller inserts keys in different
  // order (e.g. iterating a Map).
  const capabilities = [...new Set(schemaKeys)].sort();

  if (cloned.capabilities !== undefined) {
    validateCapabilityListMatches(cloned.capabilities, capabilities);
  }

  // Build each capability schema record.
  const capabilitySchemas: Record<string, CapabilitySchemaRecord> = {};
  for (const cap of capabilities) {
    const raw = cloned.capabilitySchemas[cap]!;
    validateCapabilitySchema(cap, raw);
    // schema_hash covers only {description, params, result} — NOT the
    // hash itself, and NOT any future fields. Matches the requester /
    // provider contract.
    const hashInput = {
      description: raw.description,
      params: raw.params,
      result: raw.result,
    };
    capabilitySchemas[cap] = {
      description: raw.description,
      params: raw.params,
      result: raw.result,
      schema_hash: computeSchemaHash(hashInput),
    };
  }

  // responsePolicy must have an entry for every capability — missing
  // policy would let AppView surface a service the provider hasn't
  // committed to answering.
  validateResponsePolicy(cloned.responsePolicy, capabilities);

  if (cloned.serviceArea !== undefined) {
    validateServiceArea(cloned.serviceArea);
  }

  const record: ServiceProfileRecord = {
    $type: SERVICE_PROFILE_TYPE,
    name: cloned.name,
    isPublic: cloned.isPublic,
    capabilities,
    capabilitySchemas,
    responsePolicy: cloned.responsePolicy,
  };
  if (cloned.serviceArea !== undefined) {
    record.serviceArea = cloned.serviceArea;
  }
  return record;
}

/**
 * Compute just the schema hash for a capability (bypassing profile
 * construction). Useful when the caller has a single capability to
 * compare against a cached hash — avoids building + discarding the
 * whole profile.
 */
export function hashCapabilitySchema(schema: CapabilitySchemaInput): string {
  validateCapabilitySchema('<capability>', schema);
  return computeSchemaHash({
    description: schema.description,
    params: schema.params,
    result: schema.result,
  });
}

// ── Validation ─────────────────────────────────────────────────────────

function validateName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('buildServiceProfile: name must be a non-empty string');
  }
}

function validateCapabilitySchema(
  cap: string,
  schema: unknown,
): asserts schema is CapabilitySchemaInput {
  if (schema === null || typeof schema !== 'object') {
    throw new TypeError(
      `buildServiceProfile: capability "${cap}" schema must be an object`,
    );
  }
  const s = schema as Partial<CapabilitySchemaInput>;
  if (typeof s.description !== 'string' || s.description.trim() === '') {
    throw new TypeError(
      `buildServiceProfile: capability "${cap}" must have a non-empty description`,
    );
  }
  if (s.params === null || typeof s.params !== 'object' || Array.isArray(s.params)) {
    throw new TypeError(
      `buildServiceProfile: capability "${cap}" params must be a JSON-schema object`,
    );
  }
  if (s.result === null || typeof s.result !== 'object' || Array.isArray(s.result)) {
    throw new TypeError(
      `buildServiceProfile: capability "${cap}" result must be a JSON-schema object`,
    );
  }
}

function validateResponsePolicy(
  policy: unknown,
  capabilities: string[],
): asserts policy is Record<string, ResponsePolicy> {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('buildServiceProfile: responsePolicy must be an object');
  }
  const p = policy as Record<string, unknown>;
  for (const cap of capabilities) {
    const v = p[cap];
    if (typeof v !== 'string' || !VALID_POLICIES.has(v as ResponsePolicy)) {
      throw new RangeError(
        `buildServiceProfile: responsePolicy for "${cap}" must be one of auto|review|manual`,
      );
    }
  }
  // Reject responsePolicy entries that don't match any declared capability —
  // that's usually a typo (e.g. "eta-query" vs "eta_query") + indicates
  // the config is inconsistent.
  const extras = Object.keys(p).filter((k) => !capabilities.includes(k));
  if (extras.length > 0) {
    throw new RangeError(
      `buildServiceProfile: responsePolicy has entries for undeclared capabilities: ${extras.join(', ')}`,
    );
  }
}

function validateServiceArea(
  area: unknown,
): asserts area is ServiceAreaInput {
  if (area === null || typeof area !== 'object' || Array.isArray(area)) {
    throw new TypeError('buildServiceProfile: serviceArea must be an object');
  }
  const a = area as Partial<ServiceAreaInput>;
  if (typeof a.lat !== 'number' || !Number.isFinite(a.lat) || a.lat < -90 || a.lat > 90) {
    throw new RangeError('buildServiceProfile: serviceArea.lat must be in [-90, 90]');
  }
  if (typeof a.lng !== 'number' || !Number.isFinite(a.lng) || a.lng < -180 || a.lng > 180) {
    throw new RangeError('buildServiceProfile: serviceArea.lng must be in [-180, 180]');
  }
  if (typeof a.radiusKm !== 'number' || !Number.isFinite(a.radiusKm) || a.radiusKm <= 0) {
    throw new RangeError('buildServiceProfile: serviceArea.radiusKm must be > 0');
  }
}

function validateCapabilityListMatches(
  provided: string[],
  derived: string[],
): void {
  if (!Array.isArray(provided)) {
    throw new TypeError('buildServiceProfile: capabilities, when set, must be an array');
  }
  const sortedProvided = [...provided].sort();
  if (sortedProvided.length !== derived.length) {
    throw new RangeError(
      `buildServiceProfile: capabilities list [${provided.join(',')}] does not match capabilitySchemas keys [${derived.join(',')}]`,
    );
  }
  for (let i = 0; i < sortedProvided.length; i++) {
    if (sortedProvided[i] !== derived[i]) {
      throw new RangeError(
        `buildServiceProfile: capabilities list [${provided.join(',')}] does not match capabilitySchemas keys [${derived.join(',')}]`,
      );
    }
  }
}
