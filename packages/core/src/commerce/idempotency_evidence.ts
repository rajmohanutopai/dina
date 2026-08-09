/**
 * Idempotency evidence at the order boundary (§15.5 — WS-9.4).
 *
 * §15.5 ends with the sentence this module exists for:
 *
 *   "No layer may declare idempotency merely because Dina deduplicates its own
 *    task row. The real external order system must deduplicate the effect;
 *    until a connector proves that with the same key and retention window,
 *    automatic resubmission stays disabled and ambiguity resolves through
 *    12.7."
 *
 * SO A CLAIM IS NOT EVIDENCE. A connector saying "we are idempotent" is a
 * sentence in a config file. What this module accepts is an OBSERVATION: the
 * same idempotency key sent twice, and the external system answering with the
 * same reference without creating a second order. Anything less leaves
 * automatic resubmission off, which is the safe direction — an unproven retry
 * is how one purchase order becomes two deliveries and two invoices.
 *
 * WHY THE RETENTION WINDOW IS PART OF THE PROOF. An external system that
 * deduplicates for an hour is not idempotent for an order whose quote is valid
 * for a day: the retry that matters is the one after the outage, and by then
 * the key has aged out and the effect fires again. §15.5 states the required
 * window as quote validity + reconciliation window + commercial retention, so
 * that sum is what the evidence is checked against rather than a number
 * somebody liked.
 *
 * WHAT THIS DOES NOT DO. It does not retry, and it does not decide an order.
 * It answers one question — may an ambiguous external attempt be repeated with
 * the same key? — and `effect_executor.ts` is the only caller. Splitting the
 * verdict from the action means an evidence change cannot quietly alter what a
 * retry does.
 */

/**
 * §15.5's required window, as its three parts.
 *
 * Kept separate rather than summed by the caller so the refusal can say WHICH
 * part the connector falls short of. An operator told "your window is too
 * short" and not by how much has to guess.
 */
export interface RetentionRequirement {
  /** How long a quote this order was placed against stays valid. */
  quoteValidityMs: number;
  /** §12.7 — how long an ambiguous outcome may stay open. */
  reconciliationWindowMs: number;
  /** §16 — how long commercial records are kept. */
  commercialRetentionMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The node's default requirement, with each part's reason.
 *
 * §15.5 names the sum but not the numbers, and the numbers matter: too low
 * and the proof is worthless, too high and no real connector can ever clear
 * it. These are chosen to be demanding but attainable, and an owner whose
 * commercial retention is genuinely shorter may configure a smaller one — the
 * spec says "the CONFIGURED commercial-retention period", which is an
 * admission that this is a policy number rather than a protocol constant.
 *
 * The sum is deliberately the bar the CONNECTOR must clear, not one Dina
 * imposes on itself: it is what makes "we deduplicate for 24 hours" an honest
 * answer of NO to a retry after a two-day outage.
 */
export const DEFAULT_RETENTION_REQUIREMENT: RetentionRequirement = {
  /** A quote a buyer holds over a weekend and approves on Monday. */
  quoteValidityMs: 7 * DAY_MS,
  /** §12.7 — how long an ambiguous outcome may stay open before a human. */
  reconciliationWindowMs: 30 * DAY_MS,
  /** §16 — the shortest commercial retention worth calling one. */
  commercialRetentionMs: 90 * DAY_MS,
};

export function requiredRetentionMs(requirement: RetentionRequirement): number {
  return (
    requirement.quoteValidityMs +
    requirement.reconciliationWindowMs +
    requirement.commercialRetentionMs
  );
}

/**
 * The observation. Two attempts with ONE key, and what the external system
 * said each time.
 *
 * `secondCreatedNewOrder` is reported by the connector rather than inferred,
 * because only the external system knows whether it made a second record. A
 * connector that cannot answer it must say `true` — the reading that refuses.
 */
export interface IdempotencyProbe {
  idempotencyKey: string;
  firstExternalRef: string;
  secondExternalRef: string;
  secondCreatedNewOrder: boolean;
  firstAtMs: number;
  secondAtMs: number;
}

export interface IdempotencyEvidence {
  /** The broker resource the effect goes through. */
  resource: string;
  /** The operation that crosses the boundary, e.g. `submit_purchase_order`. */
  operation: string;
  /** How long the connector says the external system remembers a key. */
  declaredRetentionMs: number;
  /** The observation. Null means DECLARED ONLY, which is not evidence. */
  probe: IdempotencyProbe | null;
  recordedAtMs: number;
}

export type EvidenceRefusal =
  /** Declared, never observed. §15.5's "merely because" case. */
  | 'no_probe'
  /** The external system made a second order. The opposite of proven. */
  | 'probe_created_second_order'
  /** Two different references means two different orders. */
  | 'external_ref_mismatch'
  /** The probe used a key it did not reuse, so it tested nothing. */
  | 'probe_key_unused'
  /** The two attempts were too close together to say anything about time. */
  | 'probe_window_too_narrow'
  /** The declared window is shorter than §15.5 requires. */
  | 'retention_too_short'
  /** The observation is older than what it claims to prove. */
  | 'evidence_expired';

export type EvidenceVerdict =
  | { proven: true; retentionMs: number }
  | { proven: false; refusal: EvidenceRefusal; detail: string };

/**
 * The shortest gap between two probe attempts that says anything.
 *
 * Two calls a millisecond apart would be deduplicated by an in-flight request
 * lock rather than by a durable key, and an in-flight lock is exactly the
 * mechanism that stops working at the moment a retry matters — after a crash.
 * A minute is short enough for an operator to run by hand and long enough to
 * have outlived any request-scoped lock.
 */
export const MIN_PROBE_GAP_MS = 60 * 1000;

/**
 * Evidence must be re-observed at least this often.
 *
 * An external system's behaviour is not a constant: a vendor can change their
 * deduplication window in a release nobody told the supplier about. Evidence
 * with no expiry would make a one-off probe authorise automatic retries for
 * the life of the install.
 */
export const EVIDENCE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * May an ambiguous attempt through this connector be repeated with the same
 * key?
 *
 * The order of checks is the order an operator would want to hear about them:
 * the missing observation first, then what the observation showed, then
 * whether it showed it for long enough.
 */
export function evaluateIdempotencyEvidence(args: {
  evidence: IdempotencyEvidence | null;
  requirement: RetentionRequirement;
  nowMs: number;
}): EvidenceVerdict {
  const evidence = args.evidence;
  if (evidence === null || evidence.probe === null) {
    return {
      proven: false,
      refusal: 'no_probe',
      detail:
        'this connector has not demonstrated that the external system deduplicates the same key',
    };
  }
  const probe = evidence.probe;

  if (probe.idempotencyKey === '') {
    return {
      proven: false,
      refusal: 'probe_key_unused',
      detail: 'a probe that sent no idempotency key tested nothing',
    };
  }
  if (probe.secondCreatedNewOrder) {
    return {
      proven: false,
      refusal: 'probe_created_second_order',
      detail: 'the second attempt created a second order, which is what idempotency prevents',
    };
  }
  if (probe.firstExternalRef === '' || probe.firstExternalRef !== probe.secondExternalRef) {
    // An EMPTY reference is refused as well as a mismatched one. A connector
    // that returns nothing has not shown the two attempts resolved to one
    // order; it has shown it cannot tell.
    return {
      proven: false,
      refusal: 'external_ref_mismatch',
      detail: 'the two attempts did not resolve to one external order reference',
    };
  }
  if (probe.secondAtMs - probe.firstAtMs < MIN_PROBE_GAP_MS) {
    return {
      proven: false,
      refusal: 'probe_window_too_narrow',
      detail: `the two attempts were less than ${String(MIN_PROBE_GAP_MS / 1000)}s apart, which an in-flight lock would also satisfy`,
    };
  }

  const required = requiredRetentionMs(args.requirement);
  if (evidence.declaredRetentionMs < required) {
    return {
      proven: false,
      refusal: 'retention_too_short',
      detail: `the connector remembers a key for ${String(evidence.declaredRetentionMs)}ms; §15.5 needs ${String(required)}ms (quote validity + reconciliation window + commercial retention)`,
    };
  }
  if (args.nowMs - evidence.recordedAtMs > EVIDENCE_MAX_AGE_MS) {
    return {
      proven: false,
      refusal: 'evidence_expired',
      detail: 'this observation is older than the period it is trusted for; probe again',
    };
  }

  // The window the caller may rely on is the OBSERVED declaration, not the
  // requirement it cleared. They are usually different, and a retry decision
  // should be made against what the connector actually promises.
  return { proven: true, retentionMs: evidence.declaredRetentionMs };
}

/**
 * What an ambiguous effect may do next.
 *
 * `manual_only` is not a failure — it is §15.5's default and §12.7's path. The
 * order stays open, the owner is told what is unresolved, and nobody
 * resubmits until a human or the external system settles it.
 */
export type ResubmissionPolicy = 'automatic' | 'manual_only';

export function resubmissionPolicy(verdict: EvidenceVerdict): ResubmissionPolicy {
  return verdict.proven ? 'automatic' : 'manual_only';
}
