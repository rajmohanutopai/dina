/**
 * Service Publisher — publishes `com.dinakernel.service.profile` to the PDS.
 *
 * The service profile is the public face of this home node's capability
 * offering. Requesters find this record via the AppView's index
 * (`com.dinakernel.service.search`) which ingests it.
 *
 * The publisher is **idempotent** at every edge:
 *   - `publish()` uses `putRecord` with a fixed rkey (`self`), so repeat
 *     calls overwrite in place rather than creating duplicates.
 *   - `unpublish()` uses `deleteRecordIdempotent`, so calling it when no
 *     record exists is a no-op.
 *   - `sync(config)` dispatches between the two based on `config.isDiscoverable`
 *     and tolerates transitions between states without bespoke glue.
 *
 * Security: before every write the publisher verifies that the PDS session
 * DID matches the caller-supplied `expectedDID`. This prevents accidentally
 * publishing a home node's profile under the wrong identity (e.g. when app
 * passwords get mixed across accounts).
 *
 * Source: brain/src/service/service_publisher.py  (Python reference)
 */

import { isValidServiceListingRkey } from '@dina/protocol';

import { computeSchemaHash } from './capabilities/registry';

import type { PDSPublisher, PutRecordResult } from '../pds/publisher';

/** AT-Proto NSID collection the profile record is published under. */
export const SERVICE_PROFILE_COLLECTION = 'com.dinakernel.service.profile';
/**
 * Default record key. A single-listing provider publishes one profile under
 * `'self'`. A multi-listing provider (marketplace model: one DID, many
 * listings) passes a distinct rkey per listing to `publish`/`unpublish`/`sync`;
 * each `(collection, rkey)` is an independent record at
 * `at://<did>/com.dinakernel.service.profile/<rkey>`. The AppView indexes one
 * row per listing URI, and `parseServiceListingUri` (the requester-side
 * `service_uri` parse) accepts exactly the same rkey charset this publisher
 * mints — both gate through `isValidServiceListingRkey`.
 */
export const SERVICE_PROFILE_RKEY = 'self';

/** A JSON Schema + its published hash, per capability. */
export interface PublishedCapabilitySchema {
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  schemaHash: string;
  /** GAP-PROF-01/02: human-facing description of what this
   *  capability returns. Included in the canonical hash below so
   *  a description change invalidates the cache. */
  description?: string;
  /** GAP-PROF-03: per-capability TTL hint in seconds. Purely
   *  informational on the publish side; requesters read it from
   *  the published profile and use it as their `ttl_seconds`
   *  default when they omit one on `query_service`. */
  defaultTtlSeconds?: number;
}

/** Minimum shape the publisher needs from the service config. */
export interface ServicePublisherConfig {
  isDiscoverable: boolean;
  /**
   * Explicit catalog discoverability (§5.2). `toPublisherConfig` always sets it
   * (derived from `isDiscoverable` when absent). `public`/`unlisted` publish a
   * record; `known_only` is local-only (unpublished). Carried onto the wire
   * record so AppView + URI-resolvers can tell `unlisted` from `known_only`.
   */
  discoverability?: 'public' | 'unlisted' | 'known_only';
  name: string;
  description?: string;
  /** Capability names advertised in this profile. */
  capabilities: string[];
  /** Per-capability response policy ("auto" | "review"). */
  responsePolicy?: Record<string, 'auto' | 'review'>;
  /** Per-capability JSON Schemas. Added in commit 9b1c4a4. */
  capabilitySchemas?: Record<string, PublishedCapabilitySchema>;
  /** Per-capability concrete category/vertical (catalog §9.1). */
  capabilityCategories?: Record<string, string>;
  /** Geographic service area for AppView geo-filter search. */
  serviceArea?: { lat: number; lng: number; radiusKm: number };
}

/**
 * Whether a publisher config should be PUBLISHED to the PDS (catalog §5.2):
 * `public` + `unlisted` publish; `known_only` is local/pairing-bound and stays
 * off the PDS. Back-compat: a config with no explicit `discoverability` derives
 * it from `isDiscoverable` (true→public, false→known_only).
 */
export function shouldPublishProfile(config: ServicePublisherConfig): boolean {
  const disc = config.discoverability ?? (config.isDiscoverable ? 'public' : 'known_only');
  return disc !== 'known_only';
}

/** Options for `ServicePublisher`. */
export interface ServicePublisherOptions {
  /** PDS-facing adapter. */
  pds: PDSPublisher;
  /**
   * DID that **must** match the PDS session DID before any write.
   * Typically the Home Node's identity DID from Core. A mismatch throws
   * `PublisherIdentityMismatchError`.
   */
  expectedDID: string;
  /** Injectable clock for `updatedAt` timestamp generation. */
  nowFn?: () => number;
  /**
   * Optional structured-log sink. WM-BRAIN-06c emits a warning here
   * when a caller-supplied `schemaHash` disagrees with the canonical
   * hash computed from `{params, result}`. Tests inject a capture; in
   * production the bootstrap wires it into the app logger.
   */
  logger?: (entry: Record<string, unknown>) => void;
}

/**
 * Thrown when the PDS session DID does not match the caller-supplied
 * `expectedDID`. The write is refused before leaving the process.
 */
export class PublisherIdentityMismatchError extends Error {
  constructor(
    readonly expectedDID: string,
    readonly actualDID: string | null,
  ) {
    super(`PDS session DID (${actualDID ?? 'null'}) does not match expectedDID (${expectedDID})`);
    this.name = 'PublisherIdentityMismatchError';
  }
}

/**
 * Thrown when the supplied config fails structural validation (e.g. empty
 * `name`). The caller is responsible for ensuring the config is well-formed;
 * we nonetheless do a last-mile check so a bad config never reaches PDS.
 */
export class PublisherConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublisherConfigError';
  }
}

/**
 * Thrown when a caller-supplied listing rkey is not a well-formed service
 * listing key. The publish is refused before any PDS write so a malformed key
 * can never mint a record a `parseServiceListingUri` consumer would later
 * reject (publish/parse charset must agree — both gate through
 * `isValidServiceListingRkey`).
 */
export class PublisherRkeyError extends Error {
  constructor(readonly rkey: string) {
    super(`invalid service listing rkey: ${JSON.stringify(rkey)}`);
    this.name = 'PublisherRkeyError';
  }
}

function assertValidRkey(rkey: string): void {
  if (!isValidServiceListingRkey(rkey)) {
    throw new PublisherRkeyError(rkey);
  }
}

export class ServicePublisher {
  private readonly pds: PDSPublisher;
  private readonly expectedDID: string;
  private readonly nowFn: () => number;
  private readonly log: (entry: Record<string, unknown>) => void;

  constructor(options: ServicePublisherOptions) {
    if (!options.pds) throw new Error('ServicePublisher: pds is required');
    if (!options.expectedDID) {
      throw new Error('ServicePublisher: expectedDID is required');
    }
    this.pds = options.pds;
    this.expectedDID = options.expectedDID;
    this.nowFn = options.nowFn ?? Date.now;
    this.log =
      options.logger ??
      (() => {
        /* no-op */
      });
  }

  /**
   * Upsert the service-profile record for `config`.
   * Returns the `{uri, cid}` reported by the PDS.
   *
   * Identity is verified **before** the write so that a credential mismatch
   * never results in a record landing in the wrong repo.
   */
  async publish(
    config: ServicePublisherConfig,
    rkey: string = SERVICE_PROFILE_RKEY,
  ): Promise<PutRecordResult> {
    validateConfig(config);
    assertValidRkey(rkey);
    await this.verifyIdentity();
    const record = buildRecord(config, this.nowFn(), this.log);
    return this.pds.putRecord(SERVICE_PROFILE_COLLECTION, rkey, record);
  }

  /**
   * Remove the published profile. Safe to call when nothing is published.
   * Identity is verified before any write.
   */
  async unpublish(rkey: string = SERVICE_PROFILE_RKEY): Promise<void> {
    assertValidRkey(rkey);
    await this.verifyIdentity();
    await this.pds.deleteRecordIdempotent(SERVICE_PROFILE_COLLECTION, rkey);
  }

  /**
   * Dispatch between `publish` and `unpublish` based on discoverability
   * (catalog §5.2): `public` + `unlisted` publish a record; `known_only` (or a
   * legacy `isDiscoverable=false`) unpublishes — it's local/pairing-bound. This
   * is the method to wire into the config-changed event.
   *
   * Returns `{published: true, result}` after a publish, `{published: false}`
   * after an unpublish.
   */
  async sync(
    config: ServicePublisherConfig,
    rkey: string = SERVICE_PROFILE_RKEY,
  ): Promise<{ published: true; result: PutRecordResult } | { published: false }> {
    if (shouldPublishProfile(config)) {
      const result = await this.publish(config, rkey);
      return { published: true, result };
    }
    await this.unpublish(rkey);
    return { published: false };
  }

  // -------------------------------------------------------------------------

  /**
   * Pre-write identity check: force a PDS session and compare the
   * authenticated DID against `expectedDID`. Throws before any data leaves
   * the process if the PDS account doesn't belong to this home node.
   */
  private async verifyIdentity(): Promise<void> {
    const actual = await this.pds.authenticate();
    if (actual !== this.expectedDID) {
      throw new PublisherIdentityMismatchError(this.expectedDID, actual);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Build the `com.dinakernel.service.profile` record shape from the publisher's
 * config input. Returns a plain JSON-serialisable object that PDS XRPC will
 * accept without further transformation.
 *
 * The shape mirrors the Python reference:
 *   {
 *     "$type": "com.dinakernel.service.profile",
 *     "name": ..., "description"?: ...,
 *     "capabilities": [...],
 *     "responsePolicy": {cap: "auto"|"review", ...},
 *     "capabilitySchemas"?: {cap: {params, result, schemaHash}, ...},
 *     "isDiscoverable": true,
 *     "updatedAt": "ISO-8601-Z"
 *   }
 */
export function buildRecord(
  config: ServicePublisherConfig,
  nowMs: number,
  log: (entry: Record<string, unknown>) => void = () => {
    /* no-op */
  },
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    $type: SERVICE_PROFILE_COLLECTION,
    name: config.name,
    capabilities: [...config.capabilities],
    isDiscoverable: config.isDiscoverable,
    updatedAt: new Date(nowMs).toISOString(),
  };
  // Explicit discoverability (catalog §5.2). `isDiscoverable` stays as the
  // back-compat boolean (= public); this carries the full tri-state so AppView
  // + URI-resolvers can tell `unlisted` from `known_only`. Derived when absent.
  record.discoverability =
    config.discoverability ?? (config.isDiscoverable ? 'public' : 'known_only');
  if (config.description !== undefined && config.description !== '') {
    record.description = config.description;
  }
  if (config.responsePolicy !== undefined && Object.keys(config.responsePolicy).length > 0) {
    record.responsePolicy = { ...config.responsePolicy };
  }
  // Per-capability concrete category/vertical (catalog §9.1) — lets AppView
  // filter/rank by vertical. Only caps that carry a category are included.
  if (
    config.capabilityCategories !== undefined &&
    Object.keys(config.capabilityCategories).length > 0
  ) {
    record.capabilityCategories = { ...config.capabilityCategories };
  }
  if (config.capabilitySchemas !== undefined && Object.keys(config.capabilitySchemas).length > 0) {
    record.capabilitySchemas = serialiseSchemas(config.capabilitySchemas, log);
  }
  if (config.serviceArea !== undefined) {
    // AT Protocol CBOR records forbid floats — encode coordinates as
    // scaled integers (latE7 = round(lat * 1e7)). The ingester divides
    // back when writing to Postgres. radiusKm stays integer.
    record.serviceArea = {
      latE7: Math.round(config.serviceArea.lat * 1e7),
      lngE7: Math.round(config.serviceArea.lng * 1e7),
      radiusKm: Math.round(config.serviceArea.radiusKm),
    };
  }
  return record;
}

/**
 * The published schema_hash is ALWAYS the canonical hash computed
 * from `{params, result, description}`. Caller-supplied hashes are
 * treated as advisory / potentially stale cache — never truth. A
 * mismatch emits a warning so operators can spot drift between the
 * cached hash and the live schema without impacting the published
 * record's integrity.
 *
 * GAP-PROF-02: `description` is part of the canonical input so a
 * description change invalidates the cache (matches main-dina).
 * GAP-PROF-03: `defaultTtlSeconds` is serialised alongside the
 * schema so requesters can read the published TTL.
 */
function serialiseSchemas(
  schemas: Record<string, PublishedCapabilitySchema>,
  log: (entry: Record<string, unknown>) => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [cap, s] of Object.entries(schemas)) {
    const description = s.description ?? '';
    const canonical = computeSchemaHash({
      params: s.params,
      result: s.result,
      description,
    });
    if (s.schemaHash !== '' && s.schemaHash !== canonical) {
      log({
        event: 'service_publisher.schema_hash_mismatch',
        capability: cap,
        supplied: s.schemaHash,
        canonical,
        detail: `service_publisher: supplied schema_hash does not match canonical for ${cap}`,
      });
    }
    // GAP-WIRE-01: emit snake_case on the wire to match main-dina's
    // `service_publisher.py`. The inner TS config (`PublishedCapability
    // Schema`) stays camelCase for idiomatic TS callers; translation
    // happens here at the wire boundary.
    const entry: Record<string, unknown> = {
      params: s.params,
      result: s.result,
      schema_hash: canonical,
    };
    if (description !== '') entry.description = description;
    if (typeof s.defaultTtlSeconds === 'number' && s.defaultTtlSeconds > 0) {
      entry.default_ttl_seconds = s.defaultTtlSeconds;
    }
    out[cap] = entry;
  }
  return out;
}

function validateConfig(config: ServicePublisherConfig): void {
  if (typeof config.isDiscoverable !== 'boolean') {
    throw new PublisherConfigError('config.isDiscoverable must be a boolean');
  }
  if (typeof config.name !== 'string' || config.name === '') {
    throw new PublisherConfigError('config.name is required');
  }
  if (!Array.isArray(config.capabilities)) {
    throw new PublisherConfigError('config.capabilities must be an array');
  }
  for (const cap of config.capabilities) {
    if (typeof cap !== 'string' || cap === '') {
      throw new PublisherConfigError('config.capabilities must contain non-empty strings');
    }
  }
}
