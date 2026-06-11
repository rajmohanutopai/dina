/**
 * Provider service-listing validation (spec §5.1 / §8.1 / §41).
 *
 * A provider listing (`ServiceConfig`) must satisfy, per the catalog invariant:
 *  - every capability is EITHER an official catalog capability OR a well-formed
 *    namespaced custom capability — never an unknown flat name (anti-spoof,
 *    spec §6);
 *  - every capability carries a concrete `category` — for an official capability
 *    it must be one the catalog allows (`category_ids`); for a custom capability
 *    it is still required (spec §5.1);
 *  - the listing has an explicit `discoverability` (public/unlisted/known_only)
 *    — with back-compat derivation from the legacy `isDiscoverable` boolean;
 *  - a write/booking/payment/agentic official capability is gated by `review`,
 *    not `auto` (spec §6 rule 6);
 *  - a PUBLIC custom capability ships params/result schemas (spec §8.1);
 *  - a PUBLIC listing must not advertise a sensitive/regulated official
 *    capability unless that capability's policy explicitly allows generic
 *    exposure (`intent_routable && !requires_subject_authorization`) —
 *    PUBLIC_SERVICES_TAXONOMY §3 guardrail #7: the override-to-public is the
 *    real leak risk, not the default.
 *
 * Pure + fail-CLOSED + EXPLAINABLE: returns the full error list (not a throw) so
 * mobile developer mode can show exactly why a publish is blocked (spec §8.1
 * "validation must fail closed; a half-valid public service should not publish").
 * The capability KIND is DERIVED here (never trusted from a provider field), so
 * a provider cannot mark a flat name "official".
 *
 * Zero runtime deps beyond the catalog/registry resolvers (pure TS).
 */

import { getCatalogCapability, classifyCatalogCapability } from './capability-catalog';

import type { ServiceConfig, ServiceListingStatus } from '../types/capability';
import type { Discoverability } from '../types/catalog';

/**
 * Effective discoverability for a listing: the explicit value when present,
 * else derived from the legacy boolean (`isDiscoverable:true → public`,
 * `false → known_only`, spec §5.2). Official capability does NOT imply public.
 */
export function effectiveDiscoverability(config: ServiceConfig): Discoverability {
  if (config.discoverability !== undefined) return config.discoverability;
  return config.isDiscoverable ? 'public' : 'known_only';
}

/**
 * Effective listing status — the explicit value when present, else `active`
 * (back-compat: a config that predates the status field is treated as live).
 */
export function effectiveListingStatus(config: ServiceConfig): ServiceListingStatus {
  return config.status ?? 'active';
}

/**
 * Whether a listing is LIVE on the network — i.e. it should be published to the
 * PDS AND should accept inbound `service.query`. True iff the listing is
 * `active` AND its effective discoverability is not `known_only` (known_only =
 * local/pairing-bound, never published).
 *
 * This is the SINGLE source of truth shared by the publishers (publish vs
 * unpublish) and Core's inbound capability gate, so "published ⇔ queryable"
 * stays symmetric and `status` is an orthogonal AND on top of discoverability.
 * Availability (`status`) is deliberately separated from discoverability (who
 * can find it) so a multi-listing provider can pause ONE listing without
 * deleting it or abusing `known_only` as an off switch.
 */
export function isListingPublishable(config: ServiceConfig): boolean {
  return (
    effectiveListingStatus(config) === 'active' &&
    effectiveDiscoverability(config) !== 'known_only'
  );
}

/**
 * Whether a listing is reachable by a GENERIC (no `service_uri`) query — i.e.
 * an unknown peer who only knows the capability can reach it. True iff the
 * listing is `active` AND `public`. This is STRICTER than `isListingPublishable`:
 * an `unlisted` listing is published + URI-resolvable, but it is NOT generically
 * reachable — it requires the `service_uri`/rkey from a link/QR/invite (catalog
 * §5.2: "Only people with the service link…"). Core's inbound gate uses this for
 * the no-rkey path so unlisted can't be hit without the URI.
 */
export function isListingPublic(config: ServiceConfig): boolean {
  return (
    effectiveListingStatus(config) === 'active' && effectiveDiscoverability(config) === 'public'
  );
}

export type ListingValidationCode =
  | 'unknown_capability'
  | 'missing_category'
  | 'category_not_allowed'
  | 'missing_discoverability'
  | 'write_needs_approval'
  | 'public_custom_needs_schema'
  | 'public_sensitive_capability'
  | 'subject_auth_needs_review'
  | 'missing_execution_plane'
  | 'no_capabilities';

export interface ListingValidationError {
  readonly code: ListingValidationCode;
  /** The raw capability key this error concerns (when capability-scoped). */
  readonly capability?: string;
  readonly message: string;
}

/** One capability's derived classification, for diagnostics/UI. */
export interface ListingCapabilityInfo {
  readonly raw: string;
  readonly kind: 'official' | 'custom' | 'unknown';
  readonly canonical?: string;
  readonly category?: string;
}

export interface ListingValidationResult {
  readonly ok: boolean;
  readonly errors: readonly ListingValidationError[];
  /** Effective discoverability (derived if not explicit). */
  readonly discoverability: Discoverability;
  /** Per-capability classification (official/custom/unknown). */
  readonly capabilities: readonly ListingCapabilityInfo[];
}

export interface ValidateListingOptions {
  /**
   * Require `discoverability` to be set EXPLICITLY (not just derived from
   * `isDiscoverable`). The mobile publish path passes `true` so a new listing
   * must choose "who can find this" (spec §5.2); back-compat ingest leaves it
   * `false` and uses the derived value.
   */
  readonly requireExplicitDiscoverability?: boolean;
}

const WRITE_ACTIONS: ReadonlySet<string> = new Set(['write', 'booking', 'payment', 'agentic']);

/**
 * Validate a provider listing. Returns `{ok, errors, discoverability,
 * capabilities}`; `ok === errors.length === 0`.
 */
export function validateServiceListing(
  config: ServiceConfig,
  options: ValidateListingOptions = {},
): ListingValidationResult {
  const errors: ListingValidationError[] = [];
  const capabilities: ListingCapabilityInfo[] = [];
  const discoverability = effectiveDiscoverability(config);

  // A LIVE listing (active + published) must advertise at least one capability —
  // a live-but-empty listing is a hostile/dead advertisement (it tells the
  // network "I'm here" but answers nothing). Enforced in the validator (not just
  // the mobile editor) so the my-listings activate-toggle + direct/paired
  // clients can't slip an empty active listing past Core. A `paused`/`draft`
  // listing may be empty (work in progress).
  if (isListingPublishable(config) && Object.keys(config.capabilities ?? {}).length === 0) {
    errors.push({
      code: 'no_capabilities',
      message: 'A live service must advertise at least one capability (add one, or pause the listing).',
    });
  }

  if (options.requireExplicitDiscoverability === true && config.discoverability === undefined) {
    errors.push({
      code: 'missing_discoverability',
      message: 'Choose who can find this service (public, unlisted, or known-only).',
    });
  }

  const entries = Object.entries(config.capabilities ?? {});
  for (const [raw, capConfig] of entries) {
    const cls = classifyCatalogCapability(raw);
    const category = capConfig.category;
    const info: ListingCapabilityInfo = {
      raw,
      kind: cls.kind,
      ...(cls.canonical !== undefined ? { canonical: cls.canonical } : {}),
      ...(category !== undefined ? { category } : {}),
    };
    capabilities.push(info);

    if (cls.kind === 'unknown') {
      errors.push({
        code: 'unknown_capability',
        capability: raw,
        message: `"${raw}" is not an official Dina capability and is not a valid namespaced custom capability (e.g. com.example.${raw}).`,
      });
      continue; // can't validate category/schema for an unpublishable capability
    }

    // Category is required for BOTH official and custom (spec §5.1 / §41).
    if (category === undefined || category.trim() === '') {
      errors.push({
        code: 'missing_category',
        capability: raw,
        message: `Choose a category for "${raw}".`,
      });
    }

    // Every capability on an ACTIVE listing needs an execution plane:
    // either an agent binding (mcpServer + mcpTool) or a Tier 1
    // instruction ("how should Dina answer?"). Without one, inbound
    // queries would queue forever and the requester only learns via
    // TTL expiry. Status-aware like `no_capabilities`: a paused/draft
    // listing may carry half-configured capabilities while the
    // provider works on them. Applies to ALL discoverabilities —
    // known_only listings answer real queries too.
    const hasAgentPlane =
      typeof capConfig.mcpServer === 'string' &&
      capConfig.mcpServer !== '' &&
      typeof capConfig.mcpTool === 'string' &&
      capConfig.mcpTool !== '';
    const hasInstructionPlane =
      typeof capConfig.instruction === 'string' && capConfig.instruction.trim() !== '';
    if (effectiveListingStatus(config) === 'active' && !hasAgentPlane && !hasInstructionPlane) {
      errors.push({
        code: 'missing_execution_plane',
        capability: raw,
        message: `"${raw}" has no way to answer: write instructions for Dina ("how should Dina answer?") or connect an agent for it.`,
      });
    }

    if (cls.kind === 'official' && cls.canonical !== undefined) {
      const def = getCatalogCapability(cls.canonical);
      if (def !== null) {
        if (category !== undefined && category.trim() !== '' && !def.category_ids.includes(category)) {
          errors.push({
            code: 'category_not_allowed',
            capability: raw,
            message: `Category "${category}" is not allowed for "${cls.canonical}". Allowed: ${def.category_ids.join(', ')}.`,
          });
        }
        // Write/booking/payment/agentic must be review-gated, not auto.
        if (WRITE_ACTIONS.has(def.action_class) && capConfig.responsePolicy === 'auto') {
          errors.push({
            code: 'write_needs_approval',
            capability: raw,
            message: `"${cls.canonical}" performs a ${def.action_class} action and must use the "review" response policy, not "auto".`,
          });
        }
        // Sensitive/regulated official capabilities must not be published
        // PUBLIC unless the capability's policy explicitly allows generic
        // exposure (taxonomy §3 / guardrail #7). Without this, a provider
        // flipping a listing to `public` would leak a subject-scoped
        // capability (e.g. school_homework_status) into generic discovery —
        // the catalog DEFAULT alone doesn't protect against the override.
        if (
          discoverability === 'public' &&
          (def.privacy_class === 'sensitive' || def.privacy_class === 'regulated') &&
          !(def.intent_routable && !def.requires_subject_authorization)
        ) {
          errors.push({
            code: 'public_sensitive_capability',
            capability: raw,
            message: `"${cls.canonical}" is a ${def.privacy_class} capability and can't be on a Public listing. Use Unlisted or Private / Approved Only.`,
          });
        }
        // A SUBJECT-SCOPED capability (reads data about someone — an order, a
        // delivery, a device) on a reachable-by-strangers listing (public or
        // unlisted) must be review-gated, not auto: D2D ingress admits any
        // possessor of the capability/service_uri with stranger-chosen params
        // (order ids, patient ids), and no execution layer checks the
        // requester's relationship to the subject yet. Review puts a human in
        // front of every stranger-supplied subject identifier — the same
        // pattern as write_needs_approval. `known_only` listings are exempt:
        // access there is explicitly grant-gated per grantee.
        if (
          def.requires_subject_authorization &&
          discoverability !== 'known_only' &&
          capConfig.responsePolicy === 'auto'
        ) {
          errors.push({
            code: 'subject_auth_needs_review',
            capability: raw,
            message: `"${cls.canonical}" reads subject data and must use the "review" response policy on a ${discoverability} listing (or make the listing Private / Approved Only).`,
          });
        }
      }
    }

    // A PUBLIC custom capability must ship schemas (spec §8.1).
    if (cls.kind === 'custom' && discoverability === 'public') {
      const hasSchema = config.capabilitySchemas?.[raw] !== undefined;
      if (!hasSchema) {
        errors.push({
          code: 'public_custom_needs_schema',
          capability: raw,
          message: `Public custom capability "${raw}" must include params/result schemas so other Dinas can call it safely.`,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, discoverability, capabilities };
}
