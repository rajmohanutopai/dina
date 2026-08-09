/**
 * Promotion of a commerce capability into the official catalog
 * (§11.1, §11.3 — WS-10.6).
 *
 * §11.3 lists seven things pilot evidence must prove, and §11.1 explains why
 * the list is not decoration: the existing official `price_check` uses a
 * FLOATING-POINT price and permissive additional properties, and `order_status`
 * has no pinned schemas at all. Both were promoted at some point by somebody
 * who felt the semantics were stable. Commerce v1 therefore had to define its
 * own namespaced capabilities and cannot reuse either.
 *
 * SO THIS MODULE IS A GATE, NOT A CEREMONY. It answers one question — has this
 * capability earned an official id? — against evidence that can be checked
 * rather than asserted. "Stable semantics across multiple independent
 * providers" is not a feeling: it is a count of distinct provider DIDs that
 * answered the same pinned schema hash without a semantic change in the
 * observation window.
 *
 * THE ADDITIVE RULE IS THE HALF THAT BITES. §11.3: "Promotion is additive.
 * Existing custom IDs become aliases or remain supported; they are never
 * silently reinterpreted." A promotion that CHANGED an existing capability's
 * params, result or action class is refused outright — that is exactly how
 * `price_check` came to mean something the commerce contracts cannot use, and
 * repeating it would break every install that already depends on the old
 * meaning. What a promotion may do is add a NEW official id and record the
 * custom one as its alias.
 */

/** One provider's observed behaviour during the pilot. */
export interface ProviderObservation {
  providerDid: string;
  /** The pinned params+result schema hash this provider answered. */
  schemaHash: string;
  /** Distinct successful answers observed. A single call proves nothing. */
  answeredCount: number;
  /** Failure codes this provider emitted, in the shared vocabulary. */
  failureCodes: string[];
  /** Did every answer render on the generic card fallback? */
  cardFallbackRendered: boolean;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
}

/** What the pilot recorded about one candidate capability. */
export interface PromotionEvidence {
  /** The custom id in use today, e.g. `com.dinakernel.commerce.quote`. */
  customCapabilityId: string;
  /** The official id being proposed. */
  proposedOfficialId: string;
  observations: ProviderObservation[];
  /** §11.3 — action and privacy class, both required and both explicit. */
  actionClass: string;
  privacyClass: string;
  /** §11.3 — who may call it publicly, and what authorizes a subject read. */
  publicExposure: string;
  subjectAuthorization: string;
  /** Rate limit observed to hold under load, per minute. */
  observedRateLimitPerMinute: number;
}

/** The official catalog as it stands, so the additive rule can be checked. */
export interface OfficialCapability {
  capabilityId: string;
  schemaHash: string;
  actionClass: string;
  privacyClass: string;
  /** Custom ids already recorded as aliases of this official id. */
  aliases: string[];
}

export type PromotionRefusal =
  | 'single_provider'
  | 'schema_not_stable'
  | 'insufficient_observation'
  | 'observation_window_too_short'
  | 'class_not_declared'
  | 'exposure_not_declared'
  | 'card_fallback_missing'
  | 'failure_codes_not_interoperable'
  | 'no_rate_limit_evidence'
  /** The additive rule: this would reinterpret something already official. */
  | 'would_reinterpret_existing'
  | 'alias_already_bound';

export interface PromotionFinding {
  refusal: PromotionRefusal;
  detail: string;
}

export type PromotionVerdict =
  | {
      eligible: true;
      /** What to ADD. The custom id survives as an alias (§11.3). */
      official: OfficialCapability;
    }
  | { eligible: false; findings: PromotionFinding[] };

/**
 * How many independent providers §11.3's "multiple" means.
 *
 * Two, not three: two independent implementations answering one schema is what
 * distinguishes a contract from one vendor's API, and a higher bar would make
 * promotion unreachable for capabilities only two suppliers in a category
 * offer. It is a floor rather than a target.
 */
export const MIN_INDEPENDENT_PROVIDERS = 2;

/**
 * How long the behaviour must have held.
 *
 * Thirty days, because the failure this guards against is a vendor changing
 * their semantics in a release — and a window shorter than a release cycle
 * observes stability that has not been tested by one.
 */
export const MIN_OBSERVATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Distinct successful answers one provider must show. */
export const MIN_ANSWERS_PER_PROVIDER = 20;

/**
 * Failure codes every provider must be able to express.
 *
 * §11.3's "interoperable failure codes" means a buyer can tell WHY an answer
 * did not come, whichever provider it asked. A provider that only ever emits
 * one code has not shown it can distinguish the cases a caller must handle
 * differently — "you may not" and "not right now" lead to different next steps.
 */
export const REQUIRED_FAILURE_CODES: readonly string[] = ['refused', 'unavailable'];

export function evaluatePromotion(args: {
  evidence: PromotionEvidence;
  /** The official catalog today. Empty is legal for a first promotion. */
  official: OfficialCapability[];
  nowMs: number;
}): PromotionVerdict {
  const findings: PromotionFinding[] = [];
  const e = args.evidence;

  // ---- The additive rule, checked FIRST -----------------------------------
  // Before anything else, because a promotion that would reinterpret an
  // existing capability is refused however good its evidence is. §11.1's
  // `price_check` is the standing example of what happens otherwise.
  const existing = args.official.find((c) => c.capabilityId === e.proposedOfficialId);
  if (existing !== undefined) {
    const changes: string[] = [];
    if (existing.schemaHash !== stableSchemaHash(e.observations)) changes.push('schema');
    if (existing.actionClass !== e.actionClass) changes.push('action class');
    if (existing.privacyClass !== e.privacyClass) changes.push('privacy class');
    if (changes.length > 0) {
      findings.push({
        refusal: 'would_reinterpret_existing',
        detail: `${e.proposedOfficialId} already exists and this promotion would change its ${changes.join(' and ')}`,
      });
    }
  }
  const boundElsewhere = args.official.find(
    (c) => c.capabilityId !== e.proposedOfficialId && c.aliases.includes(e.customCapabilityId),
  );
  if (boundElsewhere !== undefined) {
    // One custom id cannot alias two official ones: a caller using it would
    // get different semantics depending on which resolver they hit, which is
    // the silent reinterpretation §11.3 forbids wearing a different hat.
    findings.push({
      refusal: 'alias_already_bound',
      detail: `${e.customCapabilityId} is already an alias of ${boundElsewhere.capabilityId}`,
    });
  }

  // ---- §11.3's seven proofs ------------------------------------------------
  const providers = new Set(e.observations.map((o) => o.providerDid));
  if (providers.size < MIN_INDEPENDENT_PROVIDERS) {
    findings.push({
      refusal: 'single_provider',
      detail: `${String(providers.size)} provider(s) observed; ${String(MIN_INDEPENDENT_PROVIDERS)} independent ones are needed`,
    });
  }

  const hashes = new Set(e.observations.map((o) => o.schemaHash));
  if (hashes.size > 1) {
    findings.push({
      refusal: 'schema_not_stable',
      detail: `providers answered ${String(hashes.size)} different pinned schemas`,
    });
  }

  const thin = e.observations.filter((o) => o.answeredCount < MIN_ANSWERS_PER_PROVIDER);
  if (thin.length > 0) {
    findings.push({
      refusal: 'insufficient_observation',
      detail: `${thin.map((o) => o.providerDid).join(', ')} answered fewer than ${String(MIN_ANSWERS_PER_PROVIDER)} times`,
    });
  }

  const short = e.observations.filter(
    (o) => o.lastSeenAtMs - o.firstSeenAtMs < MIN_OBSERVATION_WINDOW_MS,
  );
  if (short.length > 0) {
    findings.push({
      refusal: 'observation_window_too_short',
      detail: `behaviour has not held for ${String(MIN_OBSERVATION_WINDOW_MS / (24 * 60 * 60 * 1000))} days at ${short.map((o) => o.providerDid).join(', ')}`,
    });
  }

  if (e.actionClass === '' || e.privacyClass === '') {
    findings.push({
      refusal: 'class_not_declared',
      detail: 'an official capability states its action class and its privacy class',
    });
  }
  if (e.publicExposure === '' || e.subjectAuthorization === '') {
    findings.push({
      refusal: 'exposure_not_declared',
      detail: 'an official capability states who may call it and what authorizes a subject read',
    });
  }

  const noCard = e.observations.filter((o) => !o.cardFallbackRendered);
  if (noCard.length > 0) {
    findings.push({
      refusal: 'card_fallback_missing',
      detail: `answers from ${noCard.map((o) => o.providerDid).join(', ')} did not render on the generic card`,
    });
  }

  const missingCodes = e.observations.filter(
    (o) => !REQUIRED_FAILURE_CODES.every((code) => o.failureCodes.includes(code)),
  );
  if (missingCodes.length > 0) {
    findings.push({
      refusal: 'failure_codes_not_interoperable',
      detail: `${missingCodes.map((o) => o.providerDid).join(', ')} never expressed ${REQUIRED_FAILURE_CODES.join(' / ')}`,
    });
  }

  if (e.observedRateLimitPerMinute <= 0) {
    findings.push({
      refusal: 'no_rate_limit_evidence',
      detail: 'abuse and rate-limit behaviour was not observed',
    });
  }

  if (findings.length > 0) return { eligible: false, findings };

  return {
    eligible: true,
    official: {
      capabilityId: e.proposedOfficialId,
      schemaHash: stableSchemaHash(e.observations),
      actionClass: e.actionClass,
      privacyClass: e.privacyClass,
      // ADDITIVE. The custom id keeps working and becomes an alias; §11.3
      // forbids retiring it, and a promotion that dropped it would break every
      // install already calling it.
      aliases: [
        ...(existing?.aliases ?? []).filter((a) => a !== e.customCapabilityId),
        e.customCapabilityId,
      ].sort(),
    },
  };
}

/**
 * The one schema hash every provider answered, or the empty string.
 *
 * Empty when they disagree, which the `schema_not_stable` finding already
 * reports — returning one of the competing hashes would let the additive check
 * compare against a hash only some providers use.
 */
function stableSchemaHash(observations: ProviderObservation[]): string {
  const hashes = new Set(observations.map((o) => o.schemaHash));
  return hashes.size === 1 ? (observations[0]?.schemaHash ?? '') : '';
}

/**
 * Apply a promotion to the catalog.
 *
 * Returns a NEW catalog rather than mutating: a promotion an owner rejected
 * must leave nothing behind, and an in-place edit makes that depend on the
 * caller remembering to undo it.
 */
export function applyPromotion(
  official: OfficialCapability[],
  promoted: OfficialCapability,
): OfficialCapability[] {
  const others = official.filter((c) => c.capabilityId !== promoted.capabilityId);
  return [...others, promoted].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
}

/**
 * Resolve a capability id a caller used, honouring aliases (§11.3).
 *
 * "Never silently reinterpreted" has a read side: a caller that keeps using
 * the custom id must reach the same capability, and must be able to SEE that
 * it was an alias rather than have the substitution hidden from it.
 */
export function resolveCapabilityId(
  official: OfficialCapability[],
  requested: string,
): { capabilityId: string; viaAlias: boolean } | null {
  const direct = official.find((c) => c.capabilityId === requested);
  if (direct !== undefined) return { capabilityId: direct.capabilityId, viaAlias: false };
  const aliased = official.find((c) => c.aliases.includes(requested));
  return aliased === undefined ? null : { capabilityId: aliased.capabilityId, viaAlias: true };
}
