/**
 * D2D wire-format types — envelope payload + service-query/response bodies.
 *
 * Source: extracted from `@dina/core/src/d2d/envelope.ts` + `d2d/service_bodies.ts`
 * per docs/HOME_NODE_LITE_TASKS.md task 1.17 (category 1.16c).
 *
 * Zero runtime deps — pure type declarations.
 */

/**
 * D2D message envelope on the wire. `c` carries the NaCl-sealed
 * ciphertext; `s` the Ed25519 signature over the plaintext JSON.
 * Core + adapter packages handle the actual crypto; this type is the
 * wire shape third-party implementers MUST produce.
 */
export interface D2DPayload {
  /** Base64-encoded NaCl sealed ciphertext. */
  c: string;
  /** Hex-encoded Ed25519 signature over the plaintext JSON. */
  s: string;
}

/** Valid response statuses on the wire. */
export type ServiceResponseStatus = 'success' | 'unavailable' | 'error';

/**
 * `service.query` body schema — a public-service request sent over D2D.
 *
 * `params` is opaque JSON; Brain owns capability-specific schema validation.
 * The `schema_hash` contract lets a requester tag which version of the
 * provider's capability schema it was authored against; providers reject
 * stale-schema queries so clients refresh and retry.
 */
export interface ServiceQueryBody {
  query_id: string;
  capability: string;
  /** Opaque JSON payload — schema owned by the provider. */
  params: unknown;
  /** SHA-256 of the capability schema the requester validated against. */
  schema_hash?: string;
  /** Time-to-live in seconds; bounded by `MAX_SERVICE_TTL`. */
  ttl_seconds: number;
}

/** `service.response` body schema — the provider's reply. */
export interface ServiceResponseBody {
  query_id: string;
  capability: string;
  status: ServiceResponseStatus;
  /** Opaque result on success; typed error-shape on failure. */
  result?: unknown;
  error?: string;
  /** SHA-256 of the provider's schema at response time (for drift detection). */
  schema_hash?: string;
}
