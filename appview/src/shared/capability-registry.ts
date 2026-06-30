/**
 * Canonical service-capability registry + resolver.
 *
 * SOURCE OF TRUTH for the closed launch capability vocabulary. See
 * `docs/SERVICES_LAUNCH_ARCHITECTURE.md` Part 1.
 *
 * The problem this solves: `capability` is a free-form string published
 * by providers and searched by consumers. Without a canonical vocabulary,
 * the same kind of service fragments across synonyms (`eta_query` vs
 * `bus_eta` vs `transit_eta`) so a search hits only the providers that
 * happened to pick the same word. This module converges every synonym to
 * ONE canonical name.
 *
 * ─────────────────────────────────────────────────────────────────────
 * SHARED MODULE — DRIFT GATE. This file is the source of truth. It is
 * copied verbatim into `packages/protocol/src/services/capability-registry.ts`
 * so the TS workspace (brain / core / mobile) can import the SAME resolver
 * synchronously and locally (Core's D2D ingress check is sync and cannot
 * await an AppView call). A unit test asserts the two copies are
 * byte-identical. If you edit one, edit both — or the drift gate fails.
 * Keep this file dependency-free (pure TS, no imports) so the copy is a
 * literal byte-for-byte duplicate.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Canonical names are the INCUMBENT strings already used across the demo
 * + TS tool code (`eta_query`, `appointment_status`), NOT tidier renames
 * — a rename would ripple through every config/schema/test/demo path.
 * Tidier names become aliases.
 */

export interface CanonicalCapability {
  /** The one true name everything is keyed on. */
  readonly canonical: string
  /** Synonyms that resolve to `canonical`. Excludes `canonical` itself. */
  readonly aliases: readonly string[]
  /**
   * Concrete categories this capability may be listed under (catalog §9.1).
   * MIRRORS the catalog capability's `category_ids` — the §79 gate asserts
   * parity. AppView uses this to DROP a provider-published category that isn't
   * allowed for an official capability (anti-spoof / anti-pollution), since
   * AppView can't import the catalog. Empty only for an entry with no constraint.
   */
  readonly categoryIds: readonly string[]
  /** Human / LLM-readable "what question this answers" — the discovery signal. */
  readonly description: string
  /** Domain grouping for discovery + marketing. */
  readonly domain: string
  /**
   * MIRRORS the catalog capability's `intent_routable` (the §79 gate asserts
   * parity). Generic intent discovery (`searchCapabilities`) surfaces ONLY
   * entries with `intentRoutable: true` — an official capability can be a
   * shared contract yet stay OUT of the generic LLM routing vocabulary
   * forever (subject-scoped reads like `school_homework_status`: the provider
   * is already known, so discovery goes via provider/profile, never generic
   * search — PUBLIC_SERVICES_TAXONOMY §3). Lives here because AppView cannot
   * import the catalog.
   */
  readonly intentRoutable: boolean
  /**
   * MIRRORS the catalog capability's `privacy_class` (§79 parity). AppView's
   * INGESTER needs it to enforce the public-sensitive rule at the trust
   * boundary: a publisher writing the AT record directly to its PDS bypasses
   * the listing validator entirely, so the ingest path must be able to drop a
   * sensitive/regulated capability from a public row (same pattern as the
   * category anti-spoof drop).
   */
  readonly privacyClass: 'public' | 'personal' | 'sensitive' | 'regulated'
  /**
   * MIRRORS the catalog capability's `requires_subject_authorization` (§79
   * parity). Subject-scoped capabilities read data ABOUT someone (a student's
   * homework, a customer's order) — combined with `privacyClass` this is the
   * ingest-side public-exposure predicate.
   */
  readonly requiresSubjectAuthorization: boolean
}

/**
 * The ingest-side public-exposure predicate (PUBLIC_SERVICES_TAXONOMY §3 /
 * guardrail #7), shared so AppView's ingester and any other registry consumer
 * apply EXACTLY the rule the listing validator applies catalog-side: a
 * sensitive/regulated official capability may sit on a PUBLIC listing only
 * when it is intent-routable AND not subject-scoped.
 */
export function isPublicExposureAllowed(entry: CanonicalCapability): boolean {
  if (entry.privacyClass !== 'sensitive' && entry.privacyClass !== 'regulated') return true
  return entry.intentRoutable && !entry.requiresSubjectAuthorization
}

/**
 * The official common capability vocabulary — the SYNC, dependency-free mirror
 * of the AppView-served capability catalog (`capability-catalog.ts`). It exists
 * because AppView + Core must resolve official capabilities LOCALLY: AppView
 * cannot import `@dina/protocol`, and Core's D2D ingress check is sync and
 * cannot await a catalog fetch. The §79 consistency gate
 * (`capability_catalog.test.ts`) asserts every entry here exists in the catalog
 * with IDENTICAL aliases, so the two never drift — a provider that picks an
 * official capability in the mobile catalog picker resolves + searches through
 * THIS registry.
 *
 * The first three (transit / appointments / commerce) are the demo-backed seed;
 * the rest mirror the curated catalog so every pickable official capability is
 * actually routable.
 *
 * To add a capability later: append an entry here (additive, zero pollution —
 * existing canonical names never change) AND add the matching catalog entry
 * (same id + aliases, or the §79 gate fails). NEVER rename a `canonical` (that
 * fragments the index); add an alias instead.
 */
export const CAPABILITY_REGISTRY: readonly CanonicalCapability[] = Object.freeze([
  Object.freeze({
    canonical: 'eta_query',
    aliases: Object.freeze(['transit_eta', 'bus_eta', 'arrival_time', 'next_bus']),
    categoryIds: Object.freeze(['transit']),
    description: 'Estimated arrival time for a transit route at a stop.',
    domain: 'transit',
    intentRoutable: true,
    privacyClass: 'public',
    requiresSubjectAuthorization: false,
  }),
  Object.freeze({
    canonical: 'appointment_status',
    aliases: Object.freeze(['appointment_query', 'appt_status', 'booking_status']),
    categoryIds: Object.freeze(['appointments', 'healthcare']),
    description: 'Check the status or next availability of an appointment.',
    domain: 'appointments',
    intentRoutable: false, // subject-scoped: reads YOUR existing appointment
    privacyClass: 'sensitive',
    requiresSubjectAuthorization: true,
  }),
  Object.freeze({
    canonical: 'price_check',
    aliases: Object.freeze(['price_lookup', 'stock_price', 'product_price', 'availability_check']),
    categoryIds: Object.freeze(['commerce']),
    description: 'Current price and stock availability of a product at a store.',
    domain: 'commerce',
    intentRoutable: true,
    privacyClass: 'public',
    requiresSubjectAuthorization: false,
  }),
  // ── Catalog-mirrored official capabilities (§79 gate keeps aliases +
  // categoryIds in sync with capability-catalog.ts). These are pickable in the
  // mobile catalog picker, so they MUST resolve + search through this registry. ──
  Object.freeze({
    canonical: 'appointment_availability',
    aliases: Object.freeze(['appointment_slots', 'appt_availability']),
    categoryIds: Object.freeze(['appointments', 'healthcare', 'professional', 'home_local']),
    description: 'Available appointment/consultation slots.',
    domain: 'appointments',
    intentRoutable: true, // provider-side open slots — the "find me a provider" case
    privacyClass: 'personal',
    requiresSubjectAuthorization: false,
  }),
  Object.freeze({
    canonical: 'appointment_book',
    aliases: Object.freeze(['book_appointment', 'appointment_booking']),
    categoryIds: Object.freeze(['appointments', 'healthcare']),
    description: 'Book an appointment slot. Requires explicit approval.',
    domain: 'appointments',
    intentRoutable: true, // creates a NEW booking; reads no existing subject data
    privacyClass: 'sensitive',
    requiresSubjectAuthorization: false,
  }),
  Object.freeze({
    canonical: 'availability_coordination',
    aliases: Object.freeze([]),
    categoryIds: Object.freeze(['appointments']),
    description: 'Coordinate a mutual meeting time with a contact.',
    domain: 'appointments',
    intentRoutable: false, // contact-scoped: coordinate with a KNOWN contact, never generic discovery
    privacyClass: 'personal',
    requiresSubjectAuthorization: false,
  }),
  Object.freeze({
    canonical: 'order_status',
    aliases: Object.freeze(['order_state']),
    categoryIds: Object.freeze(['commerce']),
    description: 'Status of an existing merchant order.',
    domain: 'commerce',
    intentRoutable: false, // subject-scoped: YOUR order at a known merchant
    privacyClass: 'personal',
    requiresSubjectAuthorization: true,
  }),
  Object.freeze({
    canonical: 'package_tracking',
    aliases: Object.freeze(['shipment_tracking', 'parcel_tracking']),
    categoryIds: Object.freeze(['logistics']),
    description: 'Track a shipment/parcel by tracking number.',
    domain: 'logistics',
    intentRoutable: true, // tracking-number-scoped; "track 1Z…" → find the carrier
    privacyClass: 'personal',
    requiresSubjectAuthorization: false,
  }),
  Object.freeze({
    canonical: 'delivery_eta',
    aliases: Object.freeze(['delivery_time']),
    categoryIds: Object.freeze(['logistics']),
    description: 'ETA for an active delivery.',
    domain: 'logistics',
    intentRoutable: false, // subject-scoped: YOUR active delivery, courier known
    privacyClass: 'personal',
    requiresSubjectAuthorization: true,
  }),
  Object.freeze({
    canonical: 'service_health_status',
    aliases: Object.freeze(['health_status', 'api_health']),
    categoryIds: Object.freeze(['developer_ops']),
    description: 'Health of an API/service/system.',
    domain: 'developer_ops',
    intentRoutable: true, // public status pages: "is X down?"
    privacyClass: 'sensitive',
    requiresSubjectAuthorization: false,
  }),
  Object.freeze({
    canonical: 'deploy_status',
    aliases: Object.freeze(['deployment_status']),
    categoryIds: Object.freeze(['developer_ops']),
    description: 'Status of a deployment.',
    domain: 'developer_ops',
    intentRoutable: false, // internal ops; reached via the known provider
    privacyClass: 'sensitive',
    requiresSubjectAuthorization: false,
  }),
  Object.freeze({
    canonical: 'school_homework_status',
    aliases: Object.freeze(['homework_status']),
    categoryIds: Object.freeze(['school']),
    description: 'Homework/assignments for a student.',
    domain: 'school',
    intentRoutable: false, // subject-scoped child data — NEVER generic-routable
    privacyClass: 'sensitive',
    requiresSubjectAuthorization: true,
  }),
  Object.freeze({
    canonical: 'service_quote',
    aliases: Object.freeze(['repair_quote', 'job_quote']),
    categoryIds: Object.freeze(['home_local']),
    description: 'Quote for a requested repair/service job.',
    domain: 'home_local',
    intentRoutable: true, // "find me a plumber quote" — new-provider discovery
    privacyClass: 'personal',
    requiresSubjectAuthorization: false,
  }),
  Object.freeze({
    canonical: 'device_status',
    aliases: Object.freeze(['device_state']),
    categoryIds: Object.freeze(['home_iot']),
    description: 'Status of a device/sensor on a personal node.',
    domain: 'home_iot',
    intentRoutable: false, // your own home devices — never a discovery target
    privacyClass: 'personal',
    requiresSubjectAuthorization: true,
  }),
])

/**
 * Build the alias → canonical lookup from a set of entries. Includes each
 * canonical mapped to itself so a canonical input is idempotent. Throws on
 * a duplicate alias (an authoring bug) rather than silently picking one.
 *
 * Exported (not just an inline IIFE) so the fail-loud invariant is unit-
 * testable against a deliberately-bad fixture without depending on the
 * shipped registry.
 */
export function buildAliasMap(
  entries: readonly CanonicalCapability[],
): ReadonlyMap<string, string> {
  const m = new Map<string, string>()
  for (const entry of entries) {
    register(m, entry.canonical, entry.canonical)
    for (const alias of entry.aliases) {
      register(m, alias, entry.canonical)
    }
  }
  return m
}

function register(m: Map<string, string>, token: string, canonical: string): void {
  const existing = m.get(token)
  if (existing !== undefined && existing !== canonical) {
    throw new Error(
      `capability-registry: token "${token}" maps to both ` +
        `"${existing}" and "${canonical}" — vocabulary tokens must be unique.`,
    )
  }
  m.set(token, canonical)
}

const ALIAS_TO_CANONICAL: ReadonlyMap<string, string> = buildAliasMap(CAPABILITY_REGISTRY)

/** Canonical → entry, for description/domain lookup. */
const CANONICAL_TO_ENTRY: ReadonlyMap<string, CanonicalCapability> = new Map(
  CAPABILITY_REGISTRY.map((e) => [e.canonical, e]),
)

/**
 * Normalize a raw capability string the same way every layer does BEFORE
 * the alias lookup: trim + lowercase. Kept separate so callers that only
 * want the normalized form (not the canonical mapping) share one rule.
 */
export function normalizeCapability(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * Resolve a raw capability string to its canonical name, or `null` if it
 * is not in the registry.
 *
 * `null` is meaningful: an UNKNOWN capability. Per spec, callers must NOT
 * treat an unknown as a pass-through canonical label — it is dropped from
 * public discovery and metered. Returning `null` (not the normalized raw
 * string) forces every call site to make that choice explicitly.
 */
export function resolveCanonicalCapability(raw: string): string | null {
  const normalized = normalizeCapability(raw)
  if (normalized.length === 0) return null
  return ALIAS_TO_CANONICAL.get(normalized) ?? null
}

/**
 * A provider-owned (namespaced) custom capability — the OPEN half of the
 * vocabulary. The closed registry above is for SHARED, promoted capabilities
 * many providers compete on; a single seller who wants a bespoke capability
 * ("any customer can create their own service") publishes a NAMESPACED one
 * instead of polluting the shared flat namespace.
 *
 * Format: reverse-DNS-style dotted — at least one `.`, each segment
 * `[a-z0-9_]+`, first segment `[a-z0-9]+`, e.g. `com.acme.widget_price`. The
 * dot is the discriminator: registry canonical names are flat (`eta_query`,
 * `appointment_status`) and never contain a dot, so a dotted string is
 * unambiguously a custom capability and can never collide with a promoted
 * one. A custom capability is its own canonical key (no alias folding) — the
 * namespace owner controls its meaning.
 */
const CUSTOM_CAPABILITY_RE = /^[a-z0-9]+(?:\.[a-z0-9_]+)+$/

/** Whether a normalized string is a well-formed namespaced custom capability. */
export function isCustomCapability(normalized: string): boolean {
  return CUSTOM_CAPABILITY_RE.test(normalized)
}

/** The three admissible outcomes of classifying a raw capability string. */
export type CapabilityClass =
  | { readonly kind: 'canonical'; readonly canonical: string }
  | { readonly kind: 'custom'; readonly canonical: string }
  | { readonly kind: 'unknown' }

/**
 * Classify a raw capability into the open vocabulary: a registry alias/
 * canonical (shared, promoted), a well-formed namespaced custom capability
 * (provider-owned), or genuinely unknown (dropped from the public index).
 */
export function classifyCapability(raw: string): CapabilityClass {
  const normalized = normalizeCapability(raw)
  if (normalized.length === 0) return { kind: 'unknown' }
  const canonical = ALIAS_TO_CANONICAL.get(normalized)
  if (canonical !== undefined) return { kind: 'canonical', canonical }
  if (isCustomCapability(normalized)) return { kind: 'custom', canonical: normalized }
  return { kind: 'unknown' }
}

/**
 * Resolve a raw capability to the index key a SEARCH should match — the
 * canonical name for a registry capability, the normalized namespaced name
 * for a custom one, or `null` for an unknown. Use this (not
 * `resolveCanonicalCapability`) wherever a search must also match
 * provider-owned capabilities; `resolveCanonicalCapability` stays for code
 * that is intentionally registry-only.
 */
export function resolveSearchableCapability(raw: string): string | null {
  const c = classifyCapability(raw)
  return c.kind === 'unknown' ? null : c.canonical
}

/** The canonical entry (description/domain) for a raw or canonical string. */
export function getCapabilityEntry(raw: string): CanonicalCapability | null {
  const canonical = resolveCanonicalCapability(raw)
  if (canonical === null) return null
  return CANONICAL_TO_ENTRY.get(canonical) ?? null
}

/**
 * The categories an OFFICIAL capability may be listed under (catalog §9.1), or
 * `null` for a custom (namespaced) or unknown capability — which carry no
 * registry category constraint (a custom capability's category is provider-
 * owned). AppView uses this to drop a published category that lies about an
 * official capability's vertical (e.g. `appointment_availability` published
 * under `developer_ops`), since AppView can't import the catalog to check.
 */
export function allowedCategoriesForCapability(raw: string): readonly string[] | null {
  const entry = getCapabilityEntry(raw)
  return entry === null ? null : entry.categoryIds
}

/** All canonical capabilities (e.g. for the discovery coverage join). */
export function allCanonicalCapabilities(): readonly CanonicalCapability[] {
  return CAPABILITY_REGISTRY
}

/**
 * Result of canonicalizing a provider's published capability set for the
 * PUBLIC index. The three public fields are kept consistent with each
 * other (the maps are re-keyed to the same canonical names as the array)
 * so a search that matches on a canonical capability also finds its
 * schema + policy. Unknowns are reported separately so the caller can
 * meter them and exclude them from public discovery WITHOUT flipping the
 * row-level `isDiscoverable` (a profile with one known + one unknown
 * capability stays discoverable for the known one).
 *
 * Spec: SERVICES_LAUNCH_ARCHITECTURE.md Part 1, Layer 2 (P1b + P2).
 */
export interface CanonicalizedCapabilities {
  /** Deduped canonical capability names for the public `capabilitiesJson`. */
  readonly capabilities: string[]
  /** `capabilitySchemas` re-keyed to canonical names (known caps only). */
  readonly capabilitySchemas: Record<string, unknown>
  /** `responsePolicy` re-keyed to canonical names (known caps only). */
  readonly responsePolicy: Record<string, string>
  /** Raw (normalized) capability strings that are NOT in the registry. */
  readonly unknown: string[]
}

/**
 * Canonicalize a provider's published capability set for the public index.
 *
 * - Each capability string → its canonical name; unknown ones are
 *   collected in `unknown` and dropped from the public arrays.
 * - The `capabilitySchemas` and `responsePolicy` maps are re-keyed from
 *   the raw published key to the canonical name, so all three public
 *   fields agree (this is the P1b fix — without it, search matches the
 *   canonical capability but finds a null schema keyed under the alias).
 * - Deterministic: when two raw capabilities canonicalize to the same
 *   name (a provider listing both `bus_eta` and `eta_query`), the FIRST
 *   occurrence's schema/policy wins; later collisions are ignored (the
 *   array is deduped). Order of `capabilities` follows first appearance.
 *
 * Pure — no I/O, no metrics. The caller meters `unknown`.
 */
export function canonicalizeForIndex(
  rawCapabilities: readonly string[] | undefined,
  rawSchemas: Record<string, unknown> | undefined,
  rawPolicy: Record<string, string> | undefined,
): CanonicalizedCapabilities {
  const capabilities: string[] = []
  const seen = new Set<string>()
  const unknown: string[] = []
  const capabilitySchemas: Record<string, unknown> = {}
  const responsePolicy: Record<string, string> = {}

  for (const raw of rawCapabilities ?? []) {
    const normalized = normalizeCapability(raw)
    if (normalized.length === 0) continue
    // Open vocabulary: a registry alias folds to its canonical name; a
    // well-formed namespaced custom capability is admitted under its own
    // name (provider-owned); anything else is genuinely unknown.
    const cls = classifyCapability(normalized)
    if (cls.kind === 'unknown') {
      // Not surfaced publicly. Dedupe the unknown report too.
      if (!unknown.includes(normalized)) unknown.push(normalized)
      continue
    }
    const canonical = cls.canonical
    if (seen.has(canonical)) {
      // Already have this key (e.g. provider listed two aliases of the same
      // thing). Keep the first schema/policy; skip the rest.
      continue
    }
    seen.add(canonical)
    capabilities.push(canonical)

    // Re-key the maps: find the published entry under the RAW key the
    // provider used (could be the alias or the canonical), move it under
    // the canonical name. `rawSchemas`/`rawPolicy` are keyed by whatever
    // string the provider published, so look up by the original raw — but
    // normalized, since the published map keys may differ in case.
    const schemaVal = lookupByNormalizedKey(rawSchemas, raw)
    if (schemaVal !== undefined) capabilitySchemas[canonical] = schemaVal
    const policyVal = lookupByNormalizedKey(rawPolicy, raw)
    if (policyVal !== undefined) responsePolicy[canonical] = policyVal
  }

  return { capabilities, capabilitySchemas, responsePolicy, unknown }
}

/**
 * Look up a value in a published map by a key that may differ in case /
 * whitespace from how the provider stored it. Tries the exact raw key
 * first (the common path — published map key == published capability
 * string), then falls back to a normalized-key scan so
 * `capabilitySchemas: { "Bus_ETA": … }` still matches a `bus_eta`
 * capability. Returns `undefined` when absent.
 */
function lookupByNormalizedKey<T>(
  map: Record<string, T> | undefined,
  rawKey: string,
): T | undefined {
  if (map === undefined) return undefined
  if (Object.prototype.hasOwnProperty.call(map, rawKey)) return map[rawKey]
  const target = normalizeCapability(rawKey)
  for (const [k, v] of Object.entries(map)) {
    if (normalizeCapability(k) === target) return v
  }
  return undefined
}
