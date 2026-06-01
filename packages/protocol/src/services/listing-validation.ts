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
 *  - a PUBLIC custom capability ships params/result schemas (spec §8.1).
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

import type { ServiceConfig } from '../types/capability';
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

export type ListingValidationCode =
  | 'unknown_capability'
  | 'missing_category'
  | 'category_not_allowed'
  | 'missing_discoverability'
  | 'write_needs_approval'
  | 'public_custom_needs_schema';

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
