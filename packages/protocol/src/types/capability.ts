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

/**
 * Reserved runner name for the in-process Tier 1 prompt-provider lane.
 * Capabilities with no `mcpServer` binding route their execution tasks
 * to this runner; only the node's own LocalDelegationRunner claims it
 * (external agent daemons — filtered OR unfiltered — never do). See
 * docs/SERVICE_PROVIDER_TIERS.md.
 */
export const LOCAL_RUNNER_NAME = 'dina.local';

/** Configuration for a single capability published by this node. */
export interface ServiceCapabilityConfig {
  /**
   * Name of the MCP server / agent runner that backs this capability,
   * e.g. `transit`, `openclaw`. OMITTED for Tier 1 prompt-provider
   * capabilities — those carry an `instruction` instead and execute
   * in-process on the provider's own Dina (docs/SERVICE_PROVIDER_TIERS.md).
   * A capability must have at least one execution plane: (mcpServer +
   * mcpTool) or a non-empty instruction — enforced by
   * `validateServiceListing` (`missing_execution_plane`).
   */
  mcpServer?: string;
  /** MCP tool within that server to invoke. Required iff `mcpServer` is set. */
  mcpTool?: string;
  /**
   * Tier 1 prompt-provider lane: the provider's own words on how Dina
   * should answer this capability — e.g. "Use my appointment notes to
   * answer haircut availability. If someone wants to book, ask me
   * first." It is a prompt, not config: free text, written by the
   * provider, combined at execution time with the query params, the
   * provider's vault, and the capability's result schema.
   *
   * PROVIDER-PRIVATE: never published to the PDS/AppView profile record
   * (it may carry internal pricing rules or personal guidance). Pinned
   * by publisher tests.
   */
  instruction?: string;
  /**
   * Unix ms when `instruction` was last edited. As-of discipline: the
   * execution prompt tells the model how old the guidance is so it
   * prefers "unsure — ask the provider" over stale-confident answers.
   */
  instructionUpdatedAt?: number;
  /**
   * Plugin-install execution plane
   * (COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md §11.2a): the listing
   * binds the EXACT (install_id, manifest CID, capability id) recorded
   * at publication. Inbound queries become plugin tasks on that
   * install's lane; a listing naming a paused/revoked/missing install
   * answers with a typed unavailable error, never a stale cache.
   *
   * PROVIDER-PRIVATE like `instruction`: install ids and CIDs never
   * enter the published PDS/AppView record. All three fields are set
   * together (validated as a unit).
   */
  pluginInstallId?: string;
  pluginManifestCid?: string;
  pluginCapabilityId?: string;
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

/**
 * Where a listing is surfaced and managed in the app — a distinct axis from
 * node role, from `discoverability` (who can find it), and from `status`
 * (is it on):
 *   - `services` — a provider/customer service, managed and shown in the
 *     Services tab. The default when the field is absent (back-compat).
 *   - `talk` — a relationship service ("Contact Service"), surfaced, granted,
 *     and invoked inside the Talk thread with a specific contact. Never appears
 *     in the Services tab; reachable per-contact via a grant.
 *
 * ORTHOGONAL to `discoverability`: a `known_only` listing can be `services`
 * (a private provider service) OR `talk` (a relationship service). Do NOT
 * conflate this axis with the `public`/`unlisted`/`known_only` words — that
 * axis answers "who can find it", this one answers "where is it surfaced".
 *
 * Listing-level (not per-capability): the same capability — e.g.
 * `availability_coordination` — can appear in different listings with
 * different surfaces; the listing decides. Read the effective value via
 * `effectiveSurface()`. See docs/CONTACT_SERVICES_ARCHITECTURE.md §3, §5.3.
 */
export type ServiceSurface = 'services' | 'talk';

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
  /**
   * Where this listing is surfaced and managed — the Services tab
   * (`services`, the default when absent) or a Talk thread with a contact
   * (`talk`, a relationship "Contact Service"). ORTHOGONAL to
   * `discoverability` (a `known_only` listing can be either surface). Read the
   * effective value via `effectiveSurface()`. Listing-level, not per-capability.
   * See docs/CONTACT_SERVICES_ARCHITECTURE.md §5.3.
   */
  surface?: ServiceSurface;
  /**
   * Contact Services: whether this listing participates in the closeness-default
   * grant flow (docs/CONTACT_SERVICES_ARCHITECTURE.md §5.1). When `true` and a
   * contact requests it without a grant, the grant is auto-materialized for a
   * `close` contact / prompted ("ask to enable") for `medium` / silently
   * soft-rejected for `distant`/`unknown`. When absent/`false` (the default) the
   * listing is manual-grant-only: an un-granted request is always soft-rejected
   * and the owner must hand-issue an offer. Only consulted for `surface:'talk'`
   * listings. Read the effective value via `effectiveDefaultOfferable()`.
   */
  defaultOfferable?: boolean;
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
  /**
   * Tier 1 vault scope pin: the SINGLE persona this listing's
   * prompt-provider executions may read notes from. NARROWS the runtime's
   * fail-closed default (all non-sensitive personas) — it can never widen
   * it: the pin is intersected with the tier scope at execution time, so
   * pinning a sensitive/locked persona yields an EMPTY scope, not access.
   * Unset = the tier default.
   *
   * PROVIDER-PRIVATE like `instruction`: execution config, never
   * published to the PDS/AppView record (pinned by tests).
   */
  vaultPersona?: string;
  // ── Optional V1 policy hints (spec §5.3) — informational, NOT enforced. ──
  accessPolicyHint?: AccessPolicyHint;
  rateLimitHint?: RateLimitHint;
  pricingHint?: PricingHint;
  freshnessHint?: FreshnessHint;
}
