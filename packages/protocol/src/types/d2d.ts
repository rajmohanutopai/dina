/**
 * D2D wire-format types — envelope payload + service-query/response bodies.
 *
 * Source: extracted from `@dina/core/src/d2d/envelope.ts` + `d2d/service_bodies.ts`
 * per docs/HOME_NODE_LITE_TASKS.md task 1.17 (category 1.16c).
 *
 * Zero runtime deps — pure type declarations.
 */

import type { CardSpec } from '../services/card-spec';

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
  /**
   * AT-URI of the SPECIFIC service.profile listing the requester chose
   * (`at://did:plc:…/com.dinakernel.service.profile/<rkey>`). A provider DID may
   * publish many listings (marketplace multi-listing per DID); `to`/DID +
   * `capability` alone can't disambiguate which one the requester picked, so
   * the chosen listing's uri rides the query. Optional + advisory: a
   * single-listing provider can ignore it; the capability+params remain the
   * functional contract. Carried end-to-end from the AppView search result.
   */
  service_uri?: string;
}

/**
 * `service.response` body schema — the provider's reply.
 *
 * SINGLE SOURCE OF TRUTH for the wire contract. Core re-exports this type
 * (see `packages/core/src/d2d/service_bodies.ts`) rather than maintaining a
 * divergent copy, and `validateServiceResponseBody` (in `../validators`)
 * enforces these invariants. Third-party implementers target THIS shape.
 */
export interface ServiceResponseBody {
  query_id: string;
  capability: string;
  status: ServiceResponseStatus;
  /** Opaque result on success; typed error-shape on failure. */
  result?: unknown;
  error?: string;
  /**
   * Time-to-live in seconds; bounded by `MAX_SERVICE_TTL`. Carried back on
   * the response so the requester's Core can size the provider window and
   * mark the result's freshness window. Required (the validator enforces it).
   */
  ttl_seconds: number;
  /** SHA-256 of the provider's schema at response time (for drift detection). */
  schema_hash?: string;
  /**
   * Optional provider-authored display card (the safe, fixed-vocabulary
   * CardSpec). Lets a provider control its result presentation
   * ("marketplace seller controls the card") WITHOUT the requester running
   * any provider code. UNTRUSTED on the wire: the requester MUST re-run
   * `validateCardSpec(card, { trusted: false })` before rendering — that
   * drops provider trust badges, enforces https-only links, strips unknown
   * blocks, etc. When absent (or it fails validation), the requester falls
   * back to the deterministic `buildResultCardSpec` mapper over `result`.
   */
  card?: CardSpec;
}
