/**
 * Capability schema + service-config types — the data shape a Dina home
 * node publishes to advertise public services it backs.
 *
 * Published via the AT Protocol `com.dinakernel.service.profile` record on the
 * node's PDS. Requesters read it to discover services, then fire a
 * `service.query` D2D to the advertised capability. The `schemaHash`
 * contract lets them detect version skew.
 *
 * Source: extracted from `@dina/core/src/service/service_config.ts` per
 * docs/HOME_NODE_LITE_TASKS.md task 1.17 (category 1.16e).
 *
 * Zero runtime deps — pure type declarations.
 */

import type { Discoverability } from './catalog';

/** How the home node handles incoming `service.query` deliveries. */
export type ServiceResponsePolicy = 'auto' | 'review';

// ─── Listing policy hints (spec §5.3) ───────────────────────────────────────
// V1 = informational only. The provider still enforces real authorization
// (`discoverability != authorization`, spec §5.3). Stored/displayed, never
// treated as a Dina enforcement promise.

/** Who MAY invoke the service (provider-enforced in V1). */
export type AccessPolicyHint =
  | 'anyone'
  | 'authenticated'
  | 'invited'
  | 'paired_dids'
  | 'owner_only'
  | 'provider_defined';

/** Throttling expectation. */
export type RateLimitHint = 'none' | 'low' | 'medium' | 'high' | 'provider_defined';

/** Pricing expectation (no payments in V1). */
export type PricingHint = 'free' | 'paid' | 'quote_required' | 'provider_defined';

/** Freshness expectation for the returned data. */
export type FreshnessHint =
  | 'real_time'
  | 'short_ttl'
  | 'medium_ttl'
  | 'long_ttl'
  | 'provider_defined';

/** Configuration for a single capability published by this node. */
export interface ServiceCapabilityConfig {
  /** Name of the MCP server that backs this capability, e.g. `transit`. */
  mcpServer: string;
  /** MCP tool within that server to invoke. */
  mcpTool: string;
  /** Whether responses are auto-sent or gated by operator review. */
  responsePolicy: ServiceResponsePolicy;
  /**
   * SHA-256 of the canonical schema for this capability. Published
   * alongside the profile so requesters can detect version skew.
   */
  schemaHash?: string;
  /**
   * Concrete category/vertical for THIS capability in THIS listing (spec
   * §5.1) — e.g. an `appointment_availability` capability published as
   * `healthcare` vs `home_local`. Category controls policy/consent/ranking,
   * so it is not cosmetic. For an OFFICIAL capability it must be one of the
   * catalog capability's `category_ids`; for a CUSTOM (namespaced) capability
   * it is still required. Per-capability (not per-listing) because a listing
   * can advertise multiple capabilities — see `listing-validation.ts`.
   */
  category?: string;
}

/** Per-capability JSON Schemas, published via the service profile. */
export interface ServiceCapabilitySchemas {
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  schemaHash: string;
  /**
   * Human-facing description of what this capability returns. Surfaced
   * to requesters via the published profile and folded into the
   * canonical `schemaHash` so a description change invalidates the
   * cache (matches main-dina).
   */
  description?: string;
  /**
   * Per-capability TTL hint in seconds. Purely informational on the
   * publish side; requesters read it from the published profile and
   * use it as their `ttl_seconds` default when they omit one on
   * `query_service`.
   */
  defaultTtlSeconds?: number;
}

/**
 * Lifecycle / availability of a provider service LISTING — a distinct axis from
 * node role (requester/provider/both) and from discoverability (who can find
 * it):
 *   - `active` — live: published per `discoverability` AND accepts inbound
 *     `service.query`. The default when the field is absent (back-compat).
 *   - `paused` — temporarily off: the config (name / category / schemas / rkey)
 *     is KEPT, but the listing is unpublished and rejects inbound queries.
 *     Reversible by flipping back to `active`.
 *   - `draft` — saved locally, never published, not queryable (work in
 *     progress). Same NETWORK effect as `paused`; the distinction is intent.
 * Deleting / clearing the config is the separate, destructive action.
 *
 * This exists so availability is NOT faked through `discoverability` (which
 * answers "who can find it", not "is it on") or through deleting the config
 * (which is destructive). A provider with many listings pauses one without
 * touching the others.
 */
export type ServiceListingStatus = 'draft' | 'active' | 'paused';

/** The full local service configuration. Mirrors the Go `ServiceConfig`. */
export interface ServiceConfig {
  /**
   * Whether this home node is publicly discoverable. LEGACY boolean — kept
   * for back-compat. The explicit `discoverability` below supersedes it:
   * `isDiscoverable:true → public`, `false → known_only` (spec §5.2). Callers
   * should read the effective value via `effectiveDiscoverability()`.
   */
  isDiscoverable: boolean;
  /**
   * Explicit discovery visibility for this listing (spec §5.2):
   * `public` (normal AppView search), `unlisted` (link/QR/invite/pairing only),
   * `known_only` (local bindings/pairing only — NOT searchable). Optional for
   * back-compat; when absent the value is derived from `isDiscoverable`.
   * `discoverability != authorization` — the provider still enforces access.
   */
  discoverability?: Discoverability;
  /**
   * Availability of THIS listing — orthogonal to role + discoverability.
   * `active` (default when absent) publishes + answers queries; `paused`/`draft`
   * KEEP the config but unpublish + reject inbound queries. See
   * `ServiceListingStatus`; read the effective value via `effectiveListingStatus`
   * and the combined live check via `isListingPublishable`.
   */
  status?: ServiceListingStatus;
  /** Human-readable service name. */
  name: string;
  description?: string;
  /** One entry per advertised capability. */
  capabilities: Record<string, ServiceCapabilityConfig>;
  /** JSON Schemas per capability. Omit to leave params unvalidated. */
  capabilitySchemas?: Record<string, ServiceCapabilitySchemas>;
  /**
   * Geographic service area. AppView's `com.dinakernel.service.search` filters
   * candidates by `lat/lng` against this area before returning hits;
   * profiles without it are invisible to geo-scoped searches.
   */
  serviceArea?: { lat: number; lng: number; radiusKm: number };
  // ── Optional V1 policy hints (spec §5.3) — informational, NOT enforced. ──
  accessPolicyHint?: AccessPolicyHint;
  rateLimitHint?: RateLimitHint;
  pricingHint?: PricingHint;
  freshnessHint?: FreshnessHint;
}
