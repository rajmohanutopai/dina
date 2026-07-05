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
  /**
   * The provider-issued grant this query exercises (the `grant_id` the
   * requester received in a `service.offer`). NOT a secret — it is only a
   * SELECTOR: the provider authorizes by `grant_id` AND the transport-
   * authenticated caller DID (the grant must be granted to that DID, for this
   * listing + capability, and be active). Required-in-effect for a `known_only`
   * listing (no public/unlisted fallback gate authorizes it); omitted for
   * public/unlisted queries, which authorize by listing/URI rules.
   */
  grant_id?: string;
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

/**
 * `service.offer` body schema — a provider proactively shares a `known_only`
 * listing with a single contact over the direct D2D relationship.
 *
 * SINGLE SOURCE OF TRUTH for the wire contract (protocol v1.1, additive).
 * Unlike `public`/`unlisted` listings (resolved from AppView/PDS), a
 * `known_only` listing is NEVER on the network — so the offer must be
 * SELF-CONTAINED: it carries everything the recipient needs to call the
 * service later (capability + schema + the listing's service_uri). The
 * recipient's Core persists it as contact metadata (`contact_service_offers`),
 * and the resolver surfaces it for that contact before any public discovery.
 * `validateServiceOfferBody` (in `../validators`) enforces these invariants.
 */
export interface ServiceOfferBody {
  /**
   * The provider-issued GRANT id this offer delivers. The offer is the
   * delivery mechanism; the authority is the provider's `service_grants` row
   * with this id. The recipient echoes it back as `service.query.grant_id`.
   * NOT a secret — it is only a selector (auth = grant_id + authenticated DID).
   */
  grant_id: string;
  /** The capability offered (canonical or namespaced custom NSID). */
  capability: string;
  /** Human-readable listing name for display. */
  service_name: string;
  /**
   * AT-URI of the `known_only` listing
   * (`at://<provider-did>/com.dinakernel.service.profile/<rkey>`). Well-formed
   * but intentionally NOT network-resolvable — the recipient rides it on the
   * eventual `service.query` so the provider knows which listing was invoked.
   */
  service_uri: string;
  /** SHA-256 of the capability's params schema (version pin for the query). */
  schema_hash?: string;
  /**
   * The capability's params JSON Schema. Carried inline because a known_only
   * offer has no AppView/PDS record to fetch it from — this is what lets the
   * recipient build + validate a valid query.
   */
  params_schema?: unknown;
  /** The capability's result JSON Schema (optional, for result validation). */
  result_schema?: unknown;
  /** Provider's advertised default TTL (seconds) for queries to this listing. */
  default_ttl_seconds?: number;
  /** Optional expiry (Unix SECONDS); the offer is stale/ignored after this. */
  expires_at?: number;
  /**
   * Echoes the originating `service.grant_request.request_id` when this offer is
   * the auto-grant REPLY to a requester's preflight. Lets the requester correlate
   * the offer to the exact request it made and auto-replay only that one (never
   * an unrelated/proactive offer). Absent on proactive/owner-pushed offers.
   *
   * SECURITY: this field is sender-controlled inner-body data, NOT authority. A
   * recipient that correlates on it MUST also bind to the transport-authenticated
   * sender DID (the request_id alone must never be treated as proof of identity).
   */
  request_id?: string;
}

/**
 * `service.grant_request` body — a requester's preflight for a contact service
 * (`surface:'talk'`, `known_only`). The requester names a CAPABILITY, never a
 * listing rkey (the listing is private — the requester cannot know it; the
 * reply `service.offer` returns the `service_uri`). The provider resolves the
 * capability to its matching talk-surface listing, applies the
 * closeness/default-offerable policy, and replies with a `service.offer`
 * (carrying grant_id + service_uri) only when allowed.
 * `validateServiceGrantRequestBody` (in `../validators`) enforces these
 * invariants. docs/CONTACT_SERVICES_ARCHITECTURE.md §5.2.
 */
export interface ServiceGrantRequestBody {
  /**
   * Unique request id, used for request/offer correlation: the auto-grant
   * `service.offer` reply echoes it back as `ServiceOfferBody.request_id`, so the
   * requester can auto-replay the originating `/schedule` against exactly that
   * grant (and only that one). 16 random bytes; non-secret selector.
   */
  request_id: string;
  /** The capability being requested (canonical or namespaced custom NSID). */
  capability: string;
  /** Optional free-text intent ("find a time next week"). Display/routing only. */
  intent?: string;
  /** The surface this service runs on — always `'talk'` for a relationship service. */
  requested_surface: 'talk';
}
