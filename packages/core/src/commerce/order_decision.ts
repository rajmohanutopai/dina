/**
 * Closing the order round trip (§9.9, WS-3.9).
 *
 * Provider ingress admits an inbound order and dispatches it to the runner for
 * one question: does this supplier want the business? This module turns the
 * runner's answer into the thing the buyer is actually owed — a SIGNED
 * acknowledgement produced by Core.
 *
 * WHY THE RUNNER'S ANSWER IS NOT THE RESPONSE. A plugin returns JSON. An
 * acknowledgement is a signed commercial record that settles the quote hold,
 * opens the status chain, and becomes the receipt both sides reconcile against
 * later. If the runner's JSON were bridged back directly, the buyer would hold
 * a claim nothing signed, the hold would never settle, and no chain would
 * exist to ask about. So the runner DECIDES and Core RECORDS; the buyer only
 * ever sees what Core signed.
 *
 * WHY A REFUSAL STILL PRODUCES A SIGNED ANSWER. "Rejected" is a commercial
 * outcome, not an error: the buyer needs a record they can show. Only a
 * malformed runner answer is an error, and it deliberately does NOT decide the
 * order — an undecidable answer leaves the reservation open for the decision
 * sweeper rather than guessing at the supplier's intent.
 *
 * All three §9.9 outcomes are carried: accepted, rejected, and counterproposal.
 * A counter is checked HERE only for shape; its lineage (§9.9) and its
 * registration through the quote family (where §9.8 audience binding is
 * enforced) belong to `decideOrder`, and a second opinion here could only
 * disagree with the one that counts.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  buildSupplierApprovalPayload,
  verifyApprovalBinding,
  type ActingInstall,
  type ApprovingPrincipal,
  type SupplierApprovalPayload,
} from './approval_payload';
import { isCommerceCapability } from './capability_names';
import { rehydrateOrderStatus } from './rehydrate';
import { getCommerceRuntime } from './runtime';

import type { SupplierDecision } from './admission';
import type { IngressResultDecision } from '../workflow/service';
import type { Sha256Fn, SignedQuote } from '@dina/commerce-protocol';

const hash: Sha256Fn = (data) => sha256(data);

export type InboundDecisionResult =
  | { ok: true; acknowledgementJson: string }
  | { ok: false; refusal: InboundDecisionRefusal; error: string };

export type InboundDecisionRefusal =
  | 'commerce_unavailable'
  | 'result_unreadable'
  | 'decision_unrecognized'
  | 'decision_refused'
  /**
   * §15.2b / FR-P5 — the decision about to be signed is not the one that was
   * approved. Distinct from `decision_refused`, which means the state machine
   * would not allow it: this one means the machine WOULD, and a human did not
   * agree to it.
   */
  | 'approval_binding_failed'
  /**
   * §15.2b — this supplier accepts orders only after human review, and no
   * approval accompanied the runner's `accepted`.
   *
   * Distinct from `approval_binding_failed`, which means an approval WAS
   * supplied and did not match. Here nobody was asked at all, and the two send
   * an operator to different places: one is a mismatch to investigate, the
   * other is a card waiting on their desk.
   */
  | 'approval_required';

/**
 * What the supplier approved, and who is about to act on it (§15.2b).
 *
 * OPTIONAL, because §15.2b applies "when supplier policy requires human
 * approval". A node whose policy auto-accepts passes a payload with a policy
 * revision and no principal; a node with no approval discipline at all passes
 * nothing and gets today's behaviour. What must never happen is a payload
 * being passed and NOT checked.
 */
export interface SupplierDecisionApproval {
  approved: SupplierApprovalPayload;
  actingBusinessDid: string;
  principal: ApprovingPrincipal;
  install: ActingInstall;
}

/**
 * Parse a runner result into a supplier decision.
 *
 * EXPORTED because it is part of the PLUGIN CONTRACT, not test plumbing: the
 * shapes this accepts are exactly the shapes a supplier pack's
 * `submit_order` result schema may declare, and a manifest that declares
 * anything else produces answers Core cannot record. Keeping it private meant
 * the two could disagree with nothing able to notice — and they did.
 *
 * Deliberately strict. An unrecognised shape is refused rather than coerced,
 * because every coercion here would be a guess about whether a supplier meant
 * to commit — and the safe reading of "I cannot tell" is to leave the order
 * undecided, not to accept or reject it on the supplier's behalf.
 */
export function readSupplierDecision(value: unknown): SupplierDecision | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case 'accepted': {
      const supplierOrderId = record.supplier_order_id ?? record.supplierOrderId;
      if (typeof supplierOrderId !== 'string' || supplierOrderId === '') return null;
      const externalRef = record.external_ref ?? record.externalRef;
      return {
        kind: 'accepted',
        supplierOrderId,
        ...(typeof externalRef === 'string' ? { externalRef } : {}),
      };
    }
    case 'rejected': {
      const reasonCode = record.reason_code ?? record.reasonCode;
      if (typeof reasonCode !== 'string' || reasonCode === '') return null;
      return { kind: 'rejected', reasonCode };
    }
    case 'counterproposal': {
      const replacement = record.replacement_quote ?? record.replacementQuote;
      // Shape only. The REAL gate is `decideOrder`, which checks counter
      // lineage (§9.9) and registers the quote through the family — where
      // §9.8 audience binding is enforced so no registration path can skip
      // it. Duplicating those checks here would be a second opinion that
      // could disagree with the one that counts.
      if (replacement === null || typeof replacement !== 'object') return null;
      return { kind: 'counterproposal', replacementQuote: replacement as SignedQuote };
    }
    default:
      return null;
  }
}

/**
 * Record the runner's decision and return the acknowledgement to send back.
 *
 * `purchaseOrderId` and `buyerDid` come from the ADMITTED order, not from the
 * runner's answer: a plugin naming a different order would otherwise decide
 * one it was never asked about.
 */
export function settleInboundOrderDecision(args: {
  buyerDid: string;
  purchaseOrderId: string;
  runnerResultJson: string;
  approval?: SupplierDecisionApproval;
}): InboundDecisionResult {
  const runtime = getCommerceRuntime();
  if (runtime === null) {
    return {
      ok: false,
      refusal: 'commerce_unavailable',
      error: 'order decision: this node has no commerce runtime',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(args.runnerResultJson);
  } catch (error) {
    return {
      ok: false,
      refusal: 'result_unreadable',
      error: `order decision: runner result is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const decision = readSupplierDecision(parsed);
  if (decision === null) {
    return {
      ok: false,
      refusal: 'decision_unrecognized',
      error: 'order decision: runner answer is not a recognised supplier decision',
    };
  }

  // §15.2b — DOES ACCEPTING THIS ORDER NEED A HUMAN?
  //
  // `orderAcceptance` was a stored setting nothing read. A supplier who chose
  // `review` still had their runner's `accepted` recorded and SIGNED without
  // anyone seeing it, because the binding check below only runs when an
  // approval is supplied — and the inbound plugin lane supplies none.
  //
  // ACCEPTANCE ONLY. A rejection commits this business to nothing and a
  // counterproposal is an offer the buyer must still take up; gating those
  // would stop a supplier declining work while their approver is asleep, which
  // is the opposite of protecting them. `accepted` is the one answer that
  // reserves stock and creates an obligation.
  //
  // A settings row that does not VALIDATE fails closed. "I cannot read your
  // policy" must not read as "you said auto" on the one decision that spends
  // money.
  if (decision.kind === 'accepted' && args.approval === undefined) {
    const settings = runtime.settings.readSupplier();
    if (!settings.ok && !settings.absent) {
      return {
        ok: false,
        refusal: 'approval_required',
        error:
          'order decision: supplier settings do not validate, so acceptance cannot be automatic (§15.2b)',
      };
    }
    // THE SECOND HALF OF A TWO-PART RULE: `review` must never silently
    // auto-accept.
    //
    // `validateSupplierSettings` now REFUSES `orderAcceptance: 'review'`
    // outright, because §15.2b has no approval card and no owner decision
    // route, so selecting it would reject every order at the decision
    // deadline without asking anyone. That refusal applies on READ as well as
    // write, so a stored `review` row reaches the branch ABOVE — settings do
    // not validate — and this one is not reachable through the store today.
    //
    // It stays, and is tested through a repository double that returns a
    // validating `review` row, because it guards a state the store is not the
    // only way to produce: a composition root may install a settings runtime
    // directly, and the change that finally builds the §15.2b lane will drop
    // the validator refusal. If this branch went away with it, that change
    // would silently turn every review-mode order into an automatic
    // acceptance — which is the failure the whole clause exists to prevent.
    // Both halves land or neither does.
    if (settings.ok && settings.settings.orderAcceptance === 'review') {
      return {
        ok: false,
        refusal: 'approval_required',
        error: 'order decision: this supplier accepts orders only after human review (§15.2b)',
      };
    }
  }

  // §15.2b BEFORE the decision is recorded, not after. Checking afterwards
  // would mean the chain had already moved on something the supplier did not
  // approve, and the only remedy left would be a compensating entry.
  if (args.approval !== undefined) {
    const ref = runtime.orders.load(args.buyerDid, args.purchaseOrderId)?.ref ?? null;
    if (ref === null) {
      return {
        ok: false,
        refusal: 'approval_binding_failed',
        error: 'order decision: no order to bind the approval to',
      };
    }
    const executing = buildSupplierApprovalPayload({
      actingBusinessDid: args.approval.actingBusinessDid,
      principal: args.approval.principal,
      buyerDid: args.buyerDid,
      purchaseOrderId: args.purchaseOrderId,
      orderDigest: ref.orderDigest,
      quoteDigest: ref.quoteDigest,
      // The kind comes from the RUNNER'S ANSWER, which is the whole point: a
      // runner that answers `accepted` where the supplier approved `rejected`
      // must not be able to sign an acceptance.
      acknowledgementKind: decision.kind,
      install: args.approval.install,
    });
    const verdict = verifyApprovalBinding(args.approval.approved, executing);
    if (!verdict.ok) {
      return {
        ok: false,
        refusal: 'approval_binding_failed',
        error: `order decision: ${verdict.field} — ${verdict.reason}`,
      };
    }
  }

  const decided = runtime.admission.decideOrder(args.buyerDid, args.purchaseOrderId, decision);
  if ('error' in decided) {
    return { ok: false, refusal: 'decision_refused', error: decided.error };
  }
  return { ok: true, acknowledgementJson: JSON.stringify(decided.acknowledgement) };
}

/** The capabilities whose runner answer is a supplier DECISION, not a result. */
const DECIDES_ORDER: ReadonlySet<string> = new Set([
  'submit_order',
  'com.dinakernel.commerce.submit_order',
]);

/**
 * §12.5/§12.8 — the capability whose answer is a POLICY OPINION, not a result.
 *
 * A cancellation is a race against dispatch, and only Core can adjudicate it:
 * it holds the status head, the order receipt and the idempotency record, and
 * it decides inside ONE transaction whether the cancellation or the dispatch
 * won. Two deciders would let both believe they did.
 *
 * The runner still has a say — whether this business WANTS to allow the
 * cancellation — and that is exactly the `CancellationPolicy` hook, which the
 * engine calls only when a real choice exists. What the runner cannot do is
 * declare the outcome; its verdict used to be passed straight back, which made
 * `resolveCancellation` and the whole atomic engine unreachable.
 */
const CANCELS_ORDER: ReadonlySet<string> = new Set([
  'cancel_order',
  'com.dinakernel.commerce.cancel_order',
]);

/** The capability whose answer makes a claim Core can check (§9.11). */
const REPORTS_STATUS: ReadonlySet<string> = new Set([
  'order_status',
  'com.dinakernel.commerce.order_status',
]);

/**
 * §9.11 (WS-2.10) — a runner may enrich a status, but not invent one.
 *
 * The supplier pack publishes the result shape for `order_status`, which is
 * why Core does not answer that capability itself: only the supplier knows the
 * carrier reference or the note. But `state` is a field BOTH sides hold, and
 * the two are not equal in authority. Core's chain is the record the supplier
 * SIGNED; a runner saying `dispatched` while the chain says `accepted` is
 * reporting something this business has not claimed, and the buyer would have
 * no way to tell the difference.
 *
 * So the enrichment passes through untouched and `state` is overwritten with
 * the head Core signed. Overwriting rather than refusing, because a refusal
 * would cost the buyer the carrier reference too — and the runner is not
 * necessarily lying, it may simply be ahead of the chain.
 *
 * AND THE SIGNED RECORDS THEMSELVES TRAVEL. Correcting `state` makes the
 * answer TRUE; it does not make it CHECKABLE. A bare state field carries no
 * sequence, no predecessor digest and no epoch, so a buyer receiving one has
 * nothing to run §9.11's fork detection against — and §9.11 puts that
 * detection on the receiver precisely because supplier-side CAS is run by the
 * party a buyer is worried about.
 *
 * A CHAIN, NOT A HEAD, and this is the part that took a journey test to see.
 * Succession is checked link by link: a buyer holding sequence 2 and handed
 * sequence 5 can neither verify it nor honestly call it a fork. So the answer
 * carries every record from the buyer's stated `since_sequence` through the
 * head, walked back from the head through `previous_status_digest` — the same
 * links the buyer is about to check.
 *
 * IT REFUSES TO TRUNCATE. A gap wider than `MAX_STATUS_CATCHUP` yields NO
 * chain rather than a partial one, because a partial chain is exactly what a
 * receiver cannot verify — it would arrive looking like a fork. The state is
 * still corrected, so the answer stays true; it is simply unproven, and the
 * buyer can say so.
 *
 * THE FIELD IS CORE'S, NEVER THE RUNNER'S. It is overwritten when a chain
 * exists and DELETED when one does not, which is the half that matters: a
 * runner that included its own `signed_status_chain` on an order with no chain
 * would otherwise have found the one gap where a forged record passes through
 * untouched. "No chain" must mean the field is absent, not merely unexamined.
 *
 * WITH NO CHAIN, THE ANSWER IS OTHERWISE LEFT ALONE. An order that has no
 * genesis has no signed state to contradict, and substituting one here would be
 * Core making the same kind of claim it is stopping the runner from making.
 */
/**
 * How far back a catch-up may reach.
 *
 * A named bound rather than "all of it": a status chain is short in every
 * ordinary trade, and an answer that could carry thousands of records is a
 * denial-of-service surface pointed at the party asking a routine question.
 * Fifty covers a genuinely eventful order and refuses a pathological one.
 */
export const MAX_STATUS_CATCHUP = 50;

function correctReportedStatus(args: {
  buyerDid: string;
  purchaseOrderId: string;
  params: unknown;
  runnerResultJson: string;
}): string | null {
  const runtime = getCommerceRuntime();
  if (runtime === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.runnerResultJson);
  } catch {
    // Unreadable. The bridge's schema check owns that failure; this seam has
    // nothing to correct and must not swallow the original answer.
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  const chain = runtime.chains.load(args.buyerDid, args.purchaseOrderId);
  if (!chain.exists) {
    if (!('signed_status_chain' in record)) return null;
    const { signed_status_chain: _forged, ...rest } = record;
    return JSON.stringify(rest);
  }
  const signed = chain.head.state;
  const catchUp = collectStatusChain(chain.head.headDigest, sinceSequenceOf(args.params));
  if (record.state === signed && catchUp === null && !('signed_status_chain' in record)) {
    return null; // Already agrees and there is nothing to attach.
  }
  // A missing receipt is a store-integrity failure on the SUPPLIER's side, and
  // the honest answer to it is a corrected state with no evidence attached —
  // not a fabricated record, and not the runner's own field left standing.
  const { signed_status_chain: _replaced, ...rest } = record;
  return JSON.stringify(
    catchUp === null
      ? { ...rest, state: signed }
      : { ...rest, state: signed, signed_status_chain: catchUp },
  );
}

/**
 * WHERE THE BUYER SAYS ITS CHAIN ENDS.
 *
 * A missing, malformed or negative value reads as 0 — send everything. That
 * direction is the safe one: too much is verifiable, too little is not.
 */
function sinceSequenceOf(params: unknown): bigint {
  if (params === null || typeof params !== 'object') return 0n;
  const raw = (params as Record<string, unknown>).since_sequence;
  if (typeof raw !== 'string' || !/^[0-9]{1,9}$/.test(raw)) return 0n;
  return BigInt(raw);
}

/**
 * Walk back from the head, oldest first, stopping at `since`.
 *
 * Returns null rather than a partial chain — see the refusal-to-truncate note
 * above. Every record is rehydrated, so a receipt that no longer matches its
 * digest ends the walk instead of travelling as evidence.
 */
function collectStatusChain(headDigest: string, since: bigint): Record<string, unknown>[] | null {
  const runtime = getCommerceRuntime();
  if (runtime === null) return null;
  const collected: Record<string, unknown>[] = [];
  let digest: string | undefined = headDigest;
  for (let step = 0; step < MAX_STATUS_CATCHUP; step += 1) {
    if (digest === undefined) return collected.reverse();
    const receipt = runtime.receipts.get(digest);
    if (receipt === null) return null;
    const rehydrated = rehydrateOrderStatus(receipt.recordJson, digest, hash);
    if (!rehydrated.ok) return null;
    const status = rehydrated.value;
    collected.push(status as unknown as Record<string, unknown>);
    // Reached the buyer's stated position: everything it is missing is now
    // collected, and the record AT `since` is included so the buyer has the
    // predecessor its first link is checked against.
    if (BigInt(status.sequence) <= since) return collected.reverse();
    digest = status.previous_status_digest;
  }
  // The walk ran out of budget before reaching the buyer's position. A partial
  // chain is unverifiable, so none travels.
  return null;
}

/**
 * The workflow-layer seam (§9.9): turn a completed `submit_order` task into
 * the signed acknowledgement, and leave every other capability alone.
 *
 * `passthrough` for anything it does not own, which is what keeps the workflow
 * layer free of commerce knowledge — it asks one question and gets "not mine"
 * for the whole rest of the service surface.
 *
 * A FAILURE ON THE DECISION LANE WITHHOLDS. This corrects the earlier
 * reasoning rather than quietly keeping it: the old code returned null on
 * failure so "the runner's own answer still reaches the buyer rather than the
 * response vanishing", and that contradicted the very next sentence of its own
 * comment — an answer we cannot record must not be presented as one we did.
 * The runner's payload is unsigned and unrecorded; putting it on the wire in
 * reply to `submit_order` tells the buyer their order was decided when no
 * decision exists. The order stays undecided, the decision sweeper owns it,
 * and §12.7's buyer reconcile is exactly the path for an unanswered
 * submission.
 *
 * The STATUS lane still passes through, and the asymmetry is deliberate: a
 * status report that Core cannot improve on is a report, not a commitment, and
 * `correctReportedStatus` returns null specifically to avoid swallowing an
 * answer it has nothing to correct.
 */
export function transformInboundOrderResult(args: {
  capability: string;
  capabilityId?: string;
  fromDid: string;
  params: unknown;
  resultJSON: string;
}): IngressResultDecision {
  // THE SAME QUESTION THE INGRESS GATE ASKED, asked the same way. A raw
  // `Set.has(wireLabel)` missed the hyphenated manifest ids the supplier
  // reference pack actually publishes, so an order admitted under
  // `com.dinakernel.commerce.submit-order` reserved capacity and then fell
  // through to `passthrough` here — handing the buyer the runner's unsigned
  // decision. The sets keep their underscore spelling; the canonicalizer makes
  // that the only spelling anything compares.
  const decides = isCommerceCapability(DECIDES_ORDER, args.capability, args.capabilityId);
  const reports = isCommerceCapability(REPORTS_STATUS, args.capability, args.capabilityId);
  const cancels = isCommerceCapability(CANCELS_ORDER, args.capability, args.capabilityId);
  if (cancels) {
    // The BUYER's request is `params`; the runner's verdict is only policy.
    const settled = settleInboundCancellation({
      buyerDid: args.fromDid,
      request: args.params,
      runnerResultJson: args.resultJSON,
    });
    return settled.ok
      ? { kind: 'replace', json: settled.resultJson }
      : { kind: 'withhold', reason: settled.refusal };
  }
  if (!decides && !reports) return { kind: 'passthrough' };
  const params = args.params;
  const purchaseOrderId =
    params !== null && typeof params === 'object'
      ? (params as { purchase_order_id?: unknown }).purchase_order_id
      : undefined;
  if (typeof purchaseOrderId !== 'string' || purchaseOrderId === '') {
    return { kind: 'passthrough' };
  }

  if (reports) {
    const corrected = correctReportedStatus({
      buyerDid: args.fromDid,
      purchaseOrderId,
      // The buyer's stated position in the chain travels in the PARAMS it
      // sent, not in the runner's answer: the runner has no idea what the
      // buyer already holds.
      params: args.params,
      runnerResultJson: args.resultJSON,
    });
    return corrected === null ? { kind: 'passthrough' } : { kind: 'replace', json: corrected };
  }

  const settled = settleInboundOrderDecision({
    // The buyer is the AUTHENTICATED sender, never a field the runner chose.
    buyerDid: args.fromDid,
    purchaseOrderId,
    runnerResultJson: args.resultJSON,
  });
  if (settled.ok) return { kind: 'replace', json: settled.acknowledgementJson };
  // §15.2b — HELD FOR A HUMAN, not merely refused. `approval_required` is the
  // one refusal that names a person rather than a fault, so it gets a durable
  // card an owner can answer. Recorded before withholding: an order the buyer
  // will never hear about must at least be visible to the supplier.
  //
  // Only this refusal. The others mean Core could not record the decision at
  // all, and there is nothing for an owner to agree to.
  if (settled.refusal === 'approval_required') {
    getCommerceRuntime()?.pendingDecisions.put({
      buyerDid: args.fromDid,
      purchaseOrderId,
      capability: args.capabilityId ?? args.capability,
      runnerResultJson: args.resultJSON,
      reason: settled.refusal,
      createdAt: Date.now(),
    });
  }
  return { kind: 'withhold', reason: settled.refusal };
}

/**
 * §12.5/§12.8 — record a cancellation and return what Core decided.
 *
 * The runner proposes; Core disposes. `resolveCancellation` runs the whole
 * thing in ONE transaction — validating the request, checking the digest
 * binding, replaying idempotently, and settling the cancellation-versus-
 * dispatch race — and the persisted `CancellationResult` is what the buyer
 * receives. Before this, `cancel_order` fell through to `passthrough`: a
 * runner could report a cancellation that changed no order, no status head and
 * no hold, and the buyer would believe it.
 */
export function settleInboundCancellation(args: {
  buyerDid: string;
  request: unknown;
  runnerResultJson: string;
}): { ok: true; resultJson: string } | { ok: false; refusal: string } {
  const runtime = getCommerceRuntime();
  if (runtime === null) {
    return { ok: false, refusal: 'commerce_unavailable' };
  }

  // The runner's verdict, read as a POLICY preference. An unreadable or
  // unrecognised answer is not a refusal to cancel — it is an absent opinion,
  // and the safe reading of "I cannot tell what this business wants" is to
  // hold it for a human rather than to cancel or to refuse on their behalf.
  let policyChoice: 'cancelled' | 'refused_policy' | 'pending_review' = 'pending_review';
  try {
    const parsed: unknown = JSON.parse(args.runnerResultJson);
    const verdict =
      parsed !== null && typeof parsed === 'object'
        ? (parsed as { verdict?: unknown }).verdict
        : undefined;
    if (verdict === 'cancelled' || verdict === 'refused_policy' || verdict === 'pending_review') {
      policyChoice = verdict;
    }
  } catch {
    /* absent opinion; the default above stands */
  }

  const outcome = runtime.lifecycle.resolveCancellation(
    args.request,
    // THE AUTHENTICATED SENDER, never a field inside the request. A buyer_did
    // the requester chose would let anyone cancel anyone's order.
    args.buyerDid,
    () => policyChoice,
  );
  if ('error' in outcome) return { ok: false, refusal: outcome.error };
  return { ok: true, resultJson: JSON.stringify(outcome) };
}
