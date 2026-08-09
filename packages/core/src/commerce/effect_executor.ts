import {
  evaluateIdempotencyEvidence,
  resubmissionPolicy,
  type IdempotencyEvidence,
  type RetentionRequirement,
} from './idempotency_evidence';

import type { CredentialBroker } from './credential_broker';

/**
 * The external order boundary (§9.9 step 3, §15.5 — WS-9.4).
 *
 * WS-9.4's acceptance is one sentence: an accepted order appears exactly once
 * externally, or the ambiguity is reconciled honestly. Those are the only two
 * endings this module permits, and everything here exists to keep a third —
 * "it probably worked, send it again" — out of reach.
 *
 * THE ORDERING IS THE WHOLE DESIGN, and §15.5 states it: the reservation
 * record is written before the effect is attempted, and `effect_started` is
 * durably written before the effect ITSELF. So the sequence is
 *
 *     mark effect_started  →  cross the boundary  →  record what came back
 *
 * and never any other order. A crash between the mark and the call leaves a
 * row that says "the effect may have fired", which §9.9 refuses to time out —
 * costly, and correct. A crash the other way round would leave an executed
 * external order behind a record that still looks safe to expire, which is how
 * a supplier delivers goods against an order they believe they never accepted.
 *
 * RETRY IS EARNED, NOT ASSUMED. An ambiguous attempt may be repeated only when
 * the connector has PROVEN the external system deduplicates the same key for
 * long enough (`idempotency_evidence.ts`). Without that proof the attempt ends
 * as `ambiguous`, the order stays `effect_started`, and §12.7 owns what
 * happens next. That is §15.5's explicit default and the reason this module
 * takes evidence as an argument rather than a flag.
 *
 * ONE KEY, EVERY ATTEMPT. Every retry sends the idempotency key the order was
 * admitted under. A retry with a fresh key is not a retry; it is a second
 * order wearing the same intention.
 */

export interface OrderEffectRequest {
  buyerDid: string;
  purchaseOrderId: string;
  /** The key the order was admitted under. Never regenerated for a retry. */
  idempotencyKey: string;
  /** The broker resource and operation that cross the boundary. */
  resource: string;
  operation: string;
  installId: string;
  /** What the external system is being asked to create. No credentials. */
  params: unknown;
}

export type EffectOutcome =
  /** The external order exists, exactly once, and this is its reference. */
  | { kind: 'succeeded'; externalRef: string; attempts: number }
  /**
   * The boundary was never crossed: the broker refused before any request.
   * The order can be answered cleanly — nothing happened out there.
   */
  | { kind: 'refused_before_sending'; refusal: string; error: string }
  /**
   * The effect may or may not have fired. §12.7 owns it from here.
   * `retriedAutomatically` says whether proven evidence let us try again.
   */
  | { kind: 'ambiguous'; error: string; attempts: number; retriedAutomatically: boolean };

/**
 * Broker refusals decided BEFORE any network I/O.
 *
 * The broker settles every authorization check before it opens the secret
 * store — deliberately, and there is a test that asserts it. So these
 * refusals prove nothing left the node, which is the difference between an
 * order that can be rejected cleanly and one that has to be reconciled.
 *
 * `operation_failed` is NOT here, and that omission is the safety property:
 * an executor that threw, timed out, or answered an error may still have
 * created the order.
 */
const REFUSED_BEFORE_SENDING: ReadonlySet<string> = new Set([
  'no_such_resource',
  'install_not_permitted',
  'operation_not_declared',
  'params_carry_credential',
  'no_executor',
]);

/**
 * How many times one effect may be attempted when evidence permits it.
 *
 * Two, not "until it works". A connector that fails twice with a proven-
 * idempotent key is having an outage, not a transient blip, and a third
 * attempt buys nothing an operator would not rather decide themselves.
 */
export const MAX_PROVEN_ATTEMPTS = 2;

export interface EffectDeps {
  broker: CredentialBroker;
  /**
   * Durably record that the boundary is about to be crossed. MUST return only
   * after the write is committed — the whole ordering rests on it.
   */
  markEffectStarted: (buyerDid: string, purchaseOrderId: string) => boolean;
  /** Already `effect_started`? Then a second effect is forbidden outright. */
  effectAlreadyStarted: (buyerDid: string, purchaseOrderId: string) => boolean;
  /** Evidence for this connector, or null when none was ever recorded. */
  readEvidence: (resource: string, operation: string) => IdempotencyEvidence | null;
  requirement: RetentionRequirement;
  now: () => number;
}

/**
 * Cross the boundary once, and account for it honestly.
 *
 * Returns without calling the broker when the order is already
 * `effect_started`: whatever happened out there happened, and the answer is
 * reconciliation rather than a second attempt.
 */
export async function performOrderEffect(
  request: OrderEffectRequest,
  deps: EffectDeps,
): Promise<EffectOutcome> {
  if (deps.effectAlreadyStarted(request.buyerDid, request.purchaseOrderId)) {
    // NOT an error and NOT a retry. This is the crash-recovery path: a
    // previous attempt marked the boundary and we cannot know what followed.
    return {
      kind: 'ambiguous',
      error: 'this order already crossed the external boundary once',
      attempts: 0,
      retriedAutomatically: false,
    };
  }

  // DURABLE, AND BEFORE THE CALL. If this write fails there is nothing to
  // recover from, so the effect must not be attempted at all.
  if (!deps.markEffectStarted(request.buyerDid, request.purchaseOrderId)) {
    return {
      kind: 'refused_before_sending',
      refusal: 'effect_phase_not_recorded',
      error: 'the effect boundary could not be recorded, so no effect was attempted',
    };
  }

  const verdict = evaluateIdempotencyEvidence({
    evidence: deps.readEvidence(request.resource, request.operation),
    requirement: deps.requirement,
    nowMs: deps.now(),
  });
  // Read ONCE, before the first attempt. Re-reading between attempts would let
  // an evidence record written mid-flight authorise a retry that was not
  // authorised when the ambiguity arose.
  const maxAttempts = resubmissionPolicy(verdict) === 'automatic' ? MAX_PROVEN_ATTEMPTS : 1;

  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const performed = await deps.broker.perform({
      installId: request.installId,
      resource: request.resource,
      operation: request.operation,
      // ONE key for every attempt. A fresh key would make the retry a second
      // order, which is the failure the whole module is built around.
      params: { idempotency_key: request.idempotencyKey, order: request.params },
    });

    if (performed.ok) {
      return {
        kind: 'succeeded',
        externalRef: externalRefOf(performed.result),
        attempts: attempt,
      };
    }

    if (REFUSED_BEFORE_SENDING.has(performed.refusal)) {
      // Only reachable on the FIRST attempt in practice — a grant does not
      // disappear between two calls a second apart — but checked every time
      // rather than assumed, because "in practice" is where this kind of bug
      // lives.
      return {
        kind: 'refused_before_sending',
        refusal: performed.refusal,
        error: performed.error,
      };
    }

    lastError = performed.error;
  }

  return {
    kind: 'ambiguous',
    error: lastError,
    attempts: maxAttempts,
    retriedAutomatically: maxAttempts > 1,
  };
}

/**
 * The external reference, or the empty string.
 *
 * An external system that answers without one has still created the order, so
 * this is not a failure — but the empty string must reach the record rather
 * than a placeholder, because a reconciliation that searched for `"unknown"`
 * would find nothing and report the order missing.
 */
function externalRefOf(result: unknown): string {
  if (result === null || typeof result !== 'object') return '';
  const ref = (result as { external_ref?: unknown }).external_ref;
  return typeof ref === 'string' ? ref : '';
}
