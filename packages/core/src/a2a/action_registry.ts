/**
 * Inbound A2A action registry (design §5.4): a capability a remote A2A
 * caller names resolves to the catalog's action class, deterministically,
 * with no LLM, before anything else looks at it.
 *
 * Aliases resolve first, so `bus_eta` is judged as `eta_query`. Then:
 *  - a namespaced custom capability is refused (no custom Dina capabilities
 *    inbound in v1, §1.3), and so is every `com.dinakernel.commerce.*` one
 *    (outside buyers come through UCP, plan D2);
 *  - a name with no catalog entry is refused (no entry → deny);
 *  - a `payment` capability is refused, always, with no override.
 *
 * The decision is a pure function of looked-up facts
 * (`decideInboundClass`); `classifyInboundCapability` looks the facts up in
 * the shipped catalog. `ACTION_REGISTRY_REVISION` digests every fact the
 * decision can read, so an execution snapshot can pin it and a catalog
 * change between acceptance and execution voids the operation
 * (design §7.2 step 9).
 *
 * The outbound side has its own rule: an owner may bind a remote skill to
 * any class except `payment` (design §5.5).
 */

import { COMMERCE_CAPABILITY_PREFIX } from '@dina/a2a';
import {
  CAPABILITY_REGISTRY,
  getCapabilityEntry,
  getCatalogCapability,
  isCustomCapability,
  isPublicExposureAllowed,
  normalizeCapability,
  resolveCanonicalCapability,
  type ActionClass,
} from '@dina/protocol';

import { canonicalDigest } from './digest';

export type InboundActionClass = Exclude<ActionClass, 'payment'>;

/**
 * The classes whose call acts on the world (§7.3): an inbound call of one of
 * these runs under a permit its claim consumes, and once it has run, a lost
 * result is reported as `outcome_unknown`, never as a plain failure.
 */
export const INBOUND_EFFECTFUL_CLASSES: ReadonlySet<InboundActionClass> = new Set(['write', 'booking', 'agentic']);

export const INBOUND_CLASSIFICATION_FAILURES = [
  'custom_capability',
  'commerce_capability',
  'unknown_capability',
  'payment_denied',
] as const;
export type InboundClassificationFailure = (typeof INBOUND_CLASSIFICATION_FAILURES)[number];

export type InboundClassification =
  | { ok: true; canonical: string; actionClass: InboundActionClass; publicExposureAllowed: boolean }
  | { ok: false; reason: InboundClassificationFailure };

/** What the decision reads about one capability name. */
export interface CapabilityFacts {
  /** `normalizeCapability(raw)`. */
  normalized: string;
  /** Its canonical catalog id after alias resolution, or `null`. */
  canonical: string | null;
  /** The catalog action class of `canonical`, or `null`. */
  actionClass: ActionClass | null;
  publicExposureAllowed: boolean;
}

export function decideInboundClass(facts: CapabilityFacts): InboundClassification {
  if (facts.normalized.startsWith(COMMERCE_CAPABILITY_PREFIX)) {
    return { ok: false, reason: 'commerce_capability' };
  }
  if (isCustomCapability(facts.normalized)) return { ok: false, reason: 'custom_capability' };
  if (facts.canonical === null || facts.actionClass === null) {
    return { ok: false, reason: 'unknown_capability' };
  }
  if (facts.actionClass === 'payment') return { ok: false, reason: 'payment_denied' };
  return {
    ok: true,
    canonical: facts.canonical,
    actionClass: facts.actionClass,
    publicExposureAllowed: facts.publicExposureAllowed,
  };
}

export function shippedCapabilityFacts(raw: string): CapabilityFacts {
  const normalized = normalizeCapability(raw);
  const canonical = resolveCanonicalCapability(normalized);
  const entry = canonical === null ? null : getCapabilityEntry(canonical);
  return {
    normalized,
    canonical,
    actionClass:
      canonical === null ? null : (getCatalogCapability(canonical)?.action_class ?? null),
    publicExposureAllowed: entry !== null && isPublicExposureAllowed(entry),
  };
}

export function classifyInboundCapability(raw: string): InboundClassification {
  return decideInboundClass(shippedCapabilityFacts(raw));
}

/** One registry entry, as far as classification reads it. */
export interface RegistryFact {
  canonical: string;
  aliases: readonly string[];
  action_class: ActionClass | null;
  public_exposure_allowed: boolean;
}

/**
 * sha256 over the RFC 8785 form of every registry fact classification reads:
 * per canonical capability, its aliases, its catalog action class and its
 * public-exposure verdict. Order-free: entries and aliases are sorted first.
 */
export function actionRegistryRevisionOf(facts: readonly RegistryFact[]): string {
  return canonicalDigest(
    facts
      .map((f) => ({ ...f, aliases: [...f.aliases].sort() }))
      .sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0)),
  );
}

/** The shipped registry's facts. */
export function shippedRegistryFacts(): RegistryFact[] {
  return [...CAPABILITY_REGISTRY].map((entry) => ({
    canonical: entry.canonical,
    aliases: [...entry.aliases],
    action_class: getCatalogCapability(entry.canonical)?.action_class ?? null,
    public_exposure_allowed: isPublicExposureAllowed(entry),
  }));
}

/** The revision a call's snapshot pins; a catalog change moves it (§7.2 step 9). */
export const ACTION_REGISTRY_REVISION: string = actionRegistryRevisionOf(shippedRegistryFacts());

/** Classes an owner may assign to a remote skill. `payment` is never one. */
export const OUTBOUND_ASSIGNABLE_CLASSES: ReadonlySet<string> = new Set<InboundActionClass>([
  'read',
  'quote',
  'write',
  'booking',
  'agentic',
]);

export function isAssignableOutboundClass(value: unknown): value is InboundActionClass {
  return typeof value === 'string' && OUTBOUND_ASSIGNABLE_CLASSES.has(value);
}
