/**
 * Service-capability catalog types — the official, AppView-served vocabulary
 * a Dina provider chooses from when publishing a service.
 *
 * See `docs/SERVICE_CAPABILITY_CATALOG_DESIGN.md`. The catalog is the curated
 * source of truth for OFFICIAL common capabilities (e.g. `eta_query`,
 * `price_check`). It is distinct from a provider *listing* (one concrete
 * service published by one DID/rkey — see `./capability.ts`) and from
 * provider-owned *namespaced custom* capabilities (`com.acme.widget_price`).
 *
 * V1 carries the fields that drive product behaviour today. The spec's full
 * `CapabilityDefinition` is the eventual shape; fields not yet load-bearing
 * (display templates, example provider types, cache hints, signature) are
 * deferred and can be added additively without a wire break.
 *
 * Zero runtime deps — pure type declarations.
 */

/** Lifecycle of a catalog category. */
export type CategoryLifecycle = 'stable' | 'beta' | 'hidden';

/**
 * Lifecycle of a capability: `draft` (internal) → `beta` (labelled, schema may
 * change with migration) → `stable` (normal use) → `deprecated` (existing
 * providers work; new listings discouraged) → `retired` (hidden from new
 * creation). See spec §7.
 */
export type CapabilityLifecycle = 'draft' | 'beta' | 'stable' | 'deprecated' | 'retired';

/**
 * What kind of action the capability performs. Drives approval/consent
 * expectations: anything past `read`/`quote` (write / booking / payment /
 * agentic) requires an explicit approval policy (spec §6 rule 6).
 */
export type ActionClass = 'read' | 'quote' | 'write' | 'booking' | 'payment' | 'agentic';

/**
 * Data-privacy class of the capability. Drives default consent/copy strength.
 * `regulated` (health/finance/legal) is the strictest.
 */
export type PrivacyClass = 'public' | 'personal' | 'sensitive' | 'regulated';

/**
 * Default discoverability for a NEW listing of this capability. This is a
 * default, not a constraint — a listing carries its own explicit
 * `discoverability` (spec §5.2). Developer/ops and other private-by-nature
 * capabilities default to `known_only` even though they are official common
 * contracts (spec §19). `discoverability != authorization` (spec §5.3).
 */
export type Discoverability = 'public' | 'unlisted' | 'known_only';

/**
 * Hint for how a requester should gate this capability before sending.
 * Informational in V1 (the provider still enforces real authorization), but
 * write/booking/payment/agentic capabilities should not be `none`.
 */
export type ApprovalPolicyHint =
  | 'none'
  | 'confirm_before_send'
  | 'confirm_before_action'
  | 'always_approval';

/** A product/UI grouping of capabilities. NOT used for routing by itself. */
export interface CatalogCategory {
  /** Stable id, e.g. `transit`, `commerce`, `healthcare`. */
  readonly id: string;
  /** Human-facing name, e.g. "Transit and Mobility". */
  readonly display_name: string;
  readonly short_description: string;
  readonly long_description?: string;
  /** Symbolic icon key (never an arbitrary remote asset — spec §5). */
  readonly icon?: string;
  /** Display ordering in provider-setup UI (spec §36). */
  readonly sort_order: number;
  readonly lifecycle: CategoryLifecycle;
}

/**
 * One official capability — the wire contract many providers can implement.
 * `id` is the canonical capability string (flat snake_case, no dots — dots are
 * reserved for namespaced custom capabilities).
 */
export interface CapabilityDefinition {
  /** Canonical capability id. Stable forever once `stable` (spec §4.1). */
  readonly id: string;
  /** Synonyms that canonicalize to `id`. Excludes `id` itself. */
  readonly aliases: readonly string[];
  /** UI categories this capability may appear under (cross-category — spec §9.1). */
  readonly category_ids: readonly string[];
  /** Default category for simple UIs (must be one of `category_ids`). */
  readonly default_category_id?: string;
  readonly display_name: string;
  readonly short_description: string;
  readonly long_description?: string;
  readonly lifecycle: CapabilityLifecycle;
  readonly action_class: ActionClass;
  readonly privacy_class: PrivacyClass;
  /** Default discoverability for a new listing (spec §5.2 / §19). */
  readonly default_discoverability: Discoverability;
  readonly approval_policy_hint: ApprovalPolicyHint;
  /** Catalog version this capability was introduced in. */
  readonly introduced_in: string;
  /**
   * Default params/result JSON Schemas, where a real schema exists. Optional in
   * V1: catalog entries are a discovery menu; the AUTHORITATIVE schema/hash
   * lives on each provider listing (spec §5.1). Provided for the launch-backed
   * capabilities; absent for catalog entries awaiting a backing provider.
   */
  readonly params_schema?: Readonly<Record<string, unknown>>;
  readonly result_schema?: Readonly<Record<string, unknown>>;
}

/** A retired/deprecated capability kept for back-compat resolution. */
export interface DeprecatedCapability {
  readonly id: string;
  readonly replacement_id?: string;
  readonly deprecated_at: string;
  readonly removal_not_before?: string;
  readonly reason: string;
}

/**
 * The full catalog payload AppView serves at
 * `GET /xrpc/com.dinakernel.catalog.capabilities` and mobile caches.
 * `catalog_hash` + `generated_at` are injected by the serving layer over the
 * protocol-provided canonical serialization (protocol stays zero-dep).
 */
export interface CapabilityCatalog {
  /** Monotonic date/semantic version of the catalog content. */
  readonly catalog_version: string;
  /** Canonical hash of the payload (caller-computed). */
  readonly catalog_hash: string;
  /** ISO timestamp the payload was generated (caller-supplied). */
  readonly generated_at: string;
  /** Minimum client version that can safely consume this catalog, if any. */
  readonly min_client_version?: string;
  readonly categories: readonly CatalogCategory[];
  readonly capabilities: readonly CapabilityDefinition[];
  readonly deprecated_capabilities: readonly DeprecatedCapability[];
}
