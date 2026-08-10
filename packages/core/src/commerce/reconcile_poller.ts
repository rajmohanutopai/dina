import {
  MAX_HELD_STATUS_RECEIPTS,
  type OrderReconcileRequest,
  type OrderReconcileResult,
} from '@dina/commerce-protocol';

import {
  applyReconcileResult,
  isPollDue,
  settleBuyerOrder,
  type BuyerOrderRecord,
} from './buyer_reconciliation';
import { getCommerceRuntime } from './runtime';

import type { BuyerOrderRepository } from './buyer_orders';
import type { BuyerStatusRepository, EnvelopeEvidence } from './buyer_status';

/**
 * The re-poll half of §12.7 — asking again, for as long as it takes.
 *
 * `submitApprovedOrder` settles the FIRST answer. Everything after that is
 * this: an order parked in `outcome_unknown` or `submitted_unconfirmed` has a
 * `nextPollAtMs`, and something has to honour it. Without this the spec's
 * "loop with bounded re-poll" is a field nobody reads, and an ambiguous order
 * sits forever — which looks identical to an order nobody cared about.
 *
 * A SWEEP, not a timer per order. One pass over the unsettled list on a tick
 * the caller owns: a timer per order is state to leak, to double-fire after a
 * restart, and to forget to cancel when the order settles. The sweep re-reads
 * the store every pass, so a settled order simply stops appearing.
 *
 * IT ASKS; IT DOES NOT DECIDE. Every answer goes through
 * `applyReconcileResult`, so the rules about what an answer MEANS live in one
 * place. In particular this never authorizes a resubmission of its own accord:
 * the loop can run ten thousand times and the only thing that authorizes
 * sending again is a `never_received` the supplier was entitled to give.
 */

/**
 * Send one reconcile question. FIRE-AND-FORGET, and that shape is the point.
 *
 * The first version of this file took an `ask` that RESOLVED to the answer,
 * and nothing could be wired to it: every outbound `service.query` in this
 * system is fire-and-forget, with the answer arriving later as a correlated
 * `service.response`. An await-shaped transport would have meant a
 * correlate-and-await layer built for this one caller, beside the durable
 * correlation everything else already uses.
 *
 * So the loop is split. `askReconcilePolls` asks and advances the clock;
 * `applyReconcileAnswer` applies whatever comes back, whenever it comes back.
 */
export type ReconcileSend = (args: {
  supplierDid: string;
  /** WHICH of the supplier's listings the order went to. */
  serviceRkey: string;
  request: OrderReconcileRequest;
}) => Promise<{ sent: boolean }>;

/**
 * What the buyer presents when it asks.
 *
 * §12.7/§16.2: held supplier-signed evidence is what forces a supplier that
 * lost state to RE-ADOPT rather than deny. Supplying it is therefore not an
 * optimisation — it is what makes a `never_received` answer illegal, and the
 * buyer-side machine refuses to act on such an answer precisely because the
 * evidence was presented.
 */
export type HeldEvidenceReader = (args: {
  supplierDid: string;
  purchaseOrderId: string;
}) => Pick<OrderReconcileRequest, 'held_acknowledgement' | 'held_status_receipts'>;

let heldEvidenceReader: HeldEvidenceReader | null = null;

/**
 * Install what this node holds, ONCE, for the whole buyer lane.
 *
 * A NODE-LEVEL READER RATHER THAN A PER-CALL ARGUMENT, and a two-node journey
 * is what proved it has to be. The ask and the apply are separate calls made by
 * separate components — a sweeper tick and the D2D ingress — and the first
 * could be handed a reader while the second had no way to obtain one. The
 * asymmetry is not cosmetic: §12.7's legality rule is about what the buyer
 * PRESENTED, so a node that asks with its evidence and then judges the answer
 * as though it had asked with none will accept a `never_received` it was
 * entitled to refuse, and authorize the duplicate order the whole section
 * exists to prevent.
 *
 * Null is the honest default and both halves agree on it: no evidence
 * presented, `never_received` legal. What must never happen is one half
 * knowing and the other not.
 */
export function installHeldEvidenceReader(value: HeldEvidenceReader | null): void {
  heldEvidenceReader = value;
}


/**
 * The reader a real node installs: what this buyer actually holds (§12.7).
 *
 * WHY THIS EXISTS AT ALL. `installHeldEvidenceReader` was called only from
 * tests. Every real node therefore presented NO evidence, which made a
 * supplier's `never_received` legal — and `never_received` is the one answer
 * that authorises a resubmission. With the supplier's `verifyHeldEvidence`
 * ALSO unwired at both boots, §12.7's re-adoption path was inert end to end
 * and the duplicate order it exists to prevent was reachable on any node.
 *
 * EVIDENCE IS THE ENVELOPE, not a per-record signature. A supplier emits no
 * signature over an acknowledgement — authenticity comes from the signed D2D
 * envelope that carried it — so what the buyer retains, and presents, is that
 * envelope. Recorded as a decision in implementation-notes.html; the
 * alternative (per-record supplier signatures) is more robust because the
 * evidence would survive outside its transport, and costs a protocol major.
 *
 * OMITS WHAT IT CANNOT ATTRIBUTE. A record stored without an envelope is
 * simply absent from the result rather than presented bare. Presenting a
 * record with no signature would be presenting something a supplier can
 * dismiss, and — worse — would make the buyer BELIEVE it had presented
 * evidence when it had handed over nothing that binds anyone.
 */
export function makeHeldEvidenceReader(deps: {
  orders: Pick<BuyerOrderRepository, 'get'>;
  statuses: Pick<BuyerStatusRepository, 'evidenceChain'>;
}): HeldEvidenceReader {
  return ({ supplierDid, purchaseOrderId }) => {
    const record = deps.orders.get(supplierDid, purchaseOrderId);
    const ack =
      record?.acknowledgement != null && record.ackEvidence !== null
        ? {
            held_acknowledgement: {
              record: record.acknowledgement,
              envelope: record.ackEvidence.envelope,
              signature: record.ackEvidence.signature,
            },
          }
        : {};
    // Bounded by the protocol's own cap. A buyer with a pathological chain
    // must not build a request the counterparty will refuse wholesale — that
    // would turn "too much evidence" into "no evidence at all".
    const receipts = deps.statuses
      .evidenceChain(supplierDid, purchaseOrderId)
      .slice(0, MAX_HELD_STATUS_RECEIPTS)
      .map((entry) => ({
        record: entry.record,
        envelope: entry.evidence.envelope,
        signature: entry.evidence.signature,
      }));
    return {
      ...ack,
      ...(receipts.length === 0 ? {} : { held_status_receipts: receipts }),
    };
  };
}

export interface ReconcileSweepResult {
  /** Orders whose poll was due and whose question left this node. */
  asked: number;
  /** Orders the transport could not carry; they stay parked and unchanged. */
  unsent: number;
  /** Orders skipped because this node can no longer describe them. */
  undescribable: number;
}

/**
 * One ASK pass. Returns counts rather than logging them, so the caller decides
 * what an operator sees and a test can assert the sweep did something.
 *
 * ADVANCING THE CLOCK IS PART OF ASKING. A sweep that fired the question and
 * left `nextPollAtMs` where it was would re-ask on every tick until the answer
 * arrived — turning a bounded re-poll into a spin against a supplier who may
 * simply be slow. `applyReconcileResult` owns the backoff, so the advance goes
 * through it with the outcome the buyer is actually in: still unresolved.
 */
export async function askReconcilePolls(args: {
  send: ReconcileSend;
  nowMs: number;
  /**
   * Overrides the node's installed reader. Tests use it; production does not —
   * the ask and the apply must read the same evidence, and the only way to
   * guarantee that is for both to default to the same installed one.
   */
  heldEvidence?: HeldEvidenceReader;
  /** Bound on work per pass, so a large backlog cannot stall a tick. */
  maxPerSweep?: number;
  /**
   * Ask about ONE order, now, whether or not its poll is due (WS-7.8).
   *
   * The owner pressed "ask again". The backoff exists to stop the AUTOMATIC
   * loop spinning against a slow supplier; it is not a limit on what the owner
   * may do on their own node. The ask still advances `nextPollAtMs`, so one tap
   * does not leave the loop asking twice about the same order.
   *
   * Same code path rather than a second one: a dedicated "ask now" helper would
   * be a second place to forget the advance, the evidence, or the
   * describability check.
   */
  only?: { supplierDid: string; purchaseOrderId: string };
}): Promise<ReconcileSweepResult> {
  const runtime = getCommerceRuntime();
  if (runtime === null) return { asked: 0, unsent: 0, undescribable: 0 };

  const due =
    args.only === undefined
      ? runtime.buyerOrders
          .listUnsettled()
          .filter((entry) => isPollDue(entry.record, args.nowMs))
          .slice(0, args.maxPerSweep ?? 25)
      : oneOrder(
          runtime.buyerOrders.get(args.only.supplierDid, args.only.purchaseOrderId),
          args.only.supplierDid,
        );

  let asked = 0;
  let unsent = 0;
  let undescribable = 0;
  for (const entry of due) {
    const request = buildReconcileRequest({
      supplierDid: entry.supplierDid,
      record: entry.record,
      ...evidenceOption(args.heldEvidence),
    });
    if (request === null) {
      // The order this record refers to cannot be described any more. Asking
      // without a digest and an idempotency key would be asking about nothing,
      // and a supplier's honest answer to that question would be
      // `never_received` — the one answer that must never arrive by accident.
      undescribable += 1;
      continue;
    }

    let sent = false;
    try {
      sent = (
        await args.send({
          supplierDid: entry.supplierDid,
          serviceRkey: entry.record.serviceRkey,
          request,
        })
      ).sent;
    } catch {
      // A transport failure is not an answer and not a refusal. Leave the
      // record exactly as it is so the next pass asks again.
      sent = false;
    }
    if (!sent) {
      unsent += 1;
      continue;
    }
    // Asked. Push the next poll out by the machine's own backoff, WITHOUT
    // moving the state — and the outcome is chosen to guarantee that.
    //
    // ASKING IS NOT AN ANSWER. §12.7 keeps two parked states apart:
    // `submitted_unconfirmed` means the decision has not reached the external
    // boundary, `outcome_unknown` means the effect MAY have fired. Advancing
    // every record as `received_unresolved` would quietly move the first into
    // the second — reclassifying an order as possibly-committed because the
    // BUYER asked about it, which is the supplier's fact to state and not
    // ours. So the advance is expressed as the outcome the record is already
    // in. Neither authorizes resubmission; both share the same backoff, which
    // is why the advance still goes through `applyReconcileResult` rather than
    // touching `nextPollAtMs` here.
    const advance =
      entry.record.state === 'submitted_unconfirmed'
        ? ({ outcome: 'received_processing', retry_after_seconds: 0 } as const)
        : ({ outcome: 'received_unresolved', retry_after_seconds: 0 } as const);
    // Through the resolver: the ASK is an await too, and an answer can land
    // while we are still recording that we asked.
    settleBuyerOrder({
      orders: runtime.buyerOrders,
      supplierDid: entry.supplierDid,
      settled: applyReconcileResult({
        record: entry.record,
        request,
        result: advance,
        nowMs: args.nowMs,
      }),
      reapply: (live) =>
        applyReconcileResult({ record: live, request, result: advance, nowMs: args.nowMs }),
    });
    asked += 1;
  }

  return { asked, unsent, undescribable };
}

/**
 * Apply an answer that arrived on the response lane.
 *
 * Separate from the ask because the answer arrives on its own schedule —
 * possibly after a restart, possibly never. The buyer-side rules live entirely
 * in `applyReconcileResult`: this reconstructs the REQUEST that was asked (so
 * the machine can check the answer's legality against what was presented) and
 * hands both over.
 *
 * IT NEVER INVENTS A REQUEST. If the order can no longer be described, the
 * answer is dropped rather than judged against a question nobody asked —
 * `never_received` is legal only when no evidence was presented, so a
 * reconstructed request missing its evidence would make an illegal answer look
 * legal.
 */
export function applyReconcileAnswer(args: {
  supplierDid: string;
  purchaseOrderId: string;
  result: OrderReconcileResult;
  /**
   * §12.7/§16.2 — the verified envelope this answer arrived in.
   *
   * Retained on the settled record so a LATER reconcile can present it. The
   * evidence must be captured at the moment the acknowledgement lands: by the
   * time the buyer needs it, the envelope is long gone.
   */
  envelope?: EnvelopeEvidence;
  nowMs: number;
  heldEvidence?: HeldEvidenceReader;
}): 'applied' | 'unknown_order' | 'undescribable' {
  const runtime = getCommerceRuntime();
  if (runtime === null) return 'unknown_order';
  const record = runtime.buyerOrders.get(args.supplierDid, args.purchaseOrderId);
  if (record === null) return 'unknown_order';

  const request = buildReconcileRequest({
    supplierDid: args.supplierDid,
    record,
    ...evidenceOption(args.heldEvidence),
  });
  if (request === null) return 'undescribable';

  // The supplier's answer arrives asynchronously, so the row can have moved
  // since it was loaded — including into a TERMINAL state, which this answer
  // must not undo.
  // The evidence rides on the SETTLED record, both first time and on the
  // CAS reapply — a settle that dropped it on the retry path would lose the
  // evidence for exactly the orders that raced, which are the ones a busy
  // node produces most.
  const withEvidence = (settled: BuyerOrderRecord): BuyerOrderRecord =>
    args.envelope === undefined ? settled : { ...settled, ackEvidence: args.envelope };
  settleBuyerOrder({
    orders: runtime.buyerOrders,
    supplierDid: args.supplierDid,
    settled: withEvidence(
      applyReconcileResult({ record, request, result: args.result, nowMs: args.nowMs }),
    ),
    reapply: (live) =>
      withEvidence(
        applyReconcileResult({ record: live, request, result: args.result, nowMs: args.nowMs }),
      ),
  });
  return 'applied';
}

/**
 * The reader BOTH halves use: the caller's override when there is one, the
 * node's installed reader otherwise. Written once so the ask and the apply
 * cannot end up reading different things.
 */
function evidenceOption(override: HeldEvidenceReader | undefined): {
  heldEvidence?: HeldEvidenceReader;
} {
  const reader = override ?? heldEvidenceReader;
  return reader === null ? {} : { heldEvidence: reader };
}

/** The `only` selection, as the sweep's own shape. Empty when it is not held. */
function oneOrder(
  record: BuyerOrderRecord | null,
  supplierDid: string,
): { supplierDid: string; record: BuyerOrderRecord }[] {
  return record === null ? [] : [{ supplierDid, record }];
}

/**
 * The question, built once so ask and apply cannot disagree about it.
 *
 * BUILT FROM THE RECORD, never from an injected reader. The first version took
 * an `orderDetails` callback the boot supplied, which made the description a
 * second source of truth beside the stored order — and the two would disagree
 * exactly when it mattered, because the reader's job is hardest for an old
 * order and an old order is what the re-poll is for. The digest and the
 * idempotency key now live on the record, written when the order was sent.
 */
function buildReconcileRequest(args: {
  supplierDid: string;
  record: BuyerOrderRecord;
  heldEvidence?: HeldEvidenceReader;
}): OrderReconcileRequest | null {
  const { record } = args;
  // A record written before it carried its own description cannot be asked
  // about. Asking without a digest and an idempotency key would be asking
  // about nothing, and a supplier's honest answer to that question would be
  // `never_received` — the one answer that must never arrive by accident.
  if (record.orderDigest === '' || record.idempotencyKey === '') return null;
  if (record.protocolVersion === '' || record.serviceRkey === '') return null;

  const held = args.heldEvidence?.({
    supplierDid: args.supplierDid,
    purchaseOrderId: record.purchaseOrderId,
  });
  return {
    protocol_version: record.protocolVersion,
    purchase_order_id: record.purchaseOrderId,
    order_digest: record.orderDigest,
    idempotency_key: record.idempotencyKey,
    ...(held?.held_acknowledgement === undefined
      ? {}
      : { held_acknowledgement: held.held_acknowledgement }),
    ...(held?.held_status_receipts === undefined
      ? {}
      : { held_status_receipts: held.held_status_receipts }),
  };
}
