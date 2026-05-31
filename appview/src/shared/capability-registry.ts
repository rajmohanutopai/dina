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
  /** Human / LLM-readable "what question this answers" — the discovery signal. */
  readonly description: string
  /** Domain grouping for discovery + marketing. */
  readonly domain: string
}

/**
 * The closed launch vocabulary. Two domains, both backed by real
 * provider+responder demo code (transit = bus42-agent, appointments =
 * Dr Carl demo) so they are actually seedable — no aspirational entries.
 *
 * To add a capability later: append an entry (additive, zero pollution —
 * existing canonical names never change). NEVER rename a `canonical`
 * (that fragments the index); add an alias instead.
 */
export const CAPABILITY_REGISTRY: readonly CanonicalCapability[] = Object.freeze([
  Object.freeze({
    canonical: 'eta_query',
    aliases: Object.freeze(['transit_eta', 'bus_eta', 'arrival_time', 'next_bus']),
    description: 'Estimated arrival time for a public transit route at a stop.',
    domain: 'transit',
  }),
  Object.freeze({
    canonical: 'appointment_status',
    aliases: Object.freeze(['appointment_query', 'appt_status', 'booking_status']),
    description: 'Check the status or next availability of an appointment with a provider.',
    domain: 'appointments',
  }),
  Object.freeze({
    canonical: 'price_check',
    aliases: Object.freeze(['price_lookup', 'stock_price', 'product_price', 'availability_check']),
    description: 'Check the current price and stock availability of a product at a store.',
    domain: 'commerce',
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
