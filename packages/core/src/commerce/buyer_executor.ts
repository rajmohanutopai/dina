/**
 * The buyer-side executor — the one place a purchase order leaves this node
 * (§9.9, §12.7, §15.2, FR-P5, FR-P6).
 *
 * WHY THIS EXISTS. Three separate rules were built and each ended at the same
 * edge: the §15.2 approval binding had nothing to bind at execution time, the
 * §12.7 state machine had nothing to create its record, and the procurement
 * routes deliberately plan and rank without sending. All three assumed a
 * component that dispatches a buyer order, and none of them was it. This is.
 *
 * IT STILL DOES NOT OWN TRANSPORT. The sender is INJECTED. Egress belongs to
 * the service-query lane that already carries the four gates, signing and
 * MsgBox; a second egress path inside Core would be a second place to forget
 * one of them. What this owns is the ORDER of operations around the send, and
 * that order is the whole safety argument:
 *
 *   1. refuse a duplicate      — an order already tracked is never re-sent;
 *   2. verify the binding      — before anything is written or sent;
 *   3. RECORD, then send       — the crash boundary, mirroring §9.9's
 *                                `effect_started`-before-the-boundary rule;
 *   4. settle from the answer  — through the §12.7 state machine, never by
 *                                reinterpreting the outcome here.
 *
 * STEP 3 IS THE ONE WORTH ARGUING ABOUT. Recording first means a crash between
 * the write and the send leaves a record for an order that never left — which
 * the reconcile lane resolves as `never_received`, safely. Sending first would
 * mean a crash after the send leaves NO record of an order that may exist, and
 * nothing would ever ask about it. The first mistake is recoverable by
 * contract; the second is a silent lost order.
 */

import { isQuoteExpiredAt, verifyOrderAgainstQuote } from '@dina/commerce-protocol';

import { resolveActingInstall } from './acting_install';
import {
  buildBuyerApprovalPayload,
  verifyApprovalBinding,
  type BuyerApprovalContext,
  type BuyerApprovalPayload,
} from './approval_payload';
import {
  acknowledgementToResult,
  applyReconcileResult,
  newBuyerOrder,
  settleBuyerOrder,
  type BuyerOrderRecord,
} from './buyer_reconciliation';
import { BUYER_REFERENCE_MANIFEST } from './reference_manifests';
import { getCommerceRuntime } from './runtime';
import {
  evaluateStaffAuthority,
  type ActingForChain,
  type QuorumPolicy,
  type StaffGrant,
} from './staff_authority';


import type { OrderAcknowledgement, PurchaseOrderProposal } from '@dina/commerce-protocol';

/**
 * What the injected sender reports.
 *
 * THE THREE OUTCOMES ARE NOT INTERCHANGEABLE, and the distinction between the
 * last two is the entire §12.7 problem: `not_sent` is a promise that nothing
 * left this node, and `ambiguous` is an admission that something might have.
 * A sender that reported a transport timeout as `not_sent` would authorize a
 * duplicate order, so the contract says so in the type rather than in a
 * comment somebody has to find.
 */
export type BuyerSendOutcome =
  /** The supplier answered. */
  | { kind: 'acknowledged'; acknowledgement: OrderAcknowledgement }
  /**
   * Refused BEFORE anything crossed the boundary — a closed gate, an unknown
   * supplier, a refusal to sign. Only report this when no byte was sent.
   */
  | { kind: 'not_sent'; reason: string }
  /**
   * Sent, or possibly sent, with no answer. A timeout, a dropped socket, a
   * relay that accepted and went quiet.
   */
  | { kind: 'ambiguous'; reason: string };

export type BuyerOrderSender = (args: {
  supplierDid: string;
  serviceRkey: string;
  order: PurchaseOrderProposal;
}) => Promise<BuyerSendOutcome>;

export type SubmitRefusal =
  | 'commerce_unavailable'
  /** §7.2/§7.3 — nobody with authority committed this business. */
  | 'not_authorized'
  /**
   * The acting install is not what it was when the card was minted — paused,
   * revoked, reconfigured, updated, or never the buyer pack. Distinct from a
   * binding failure: the request was well formed and the world moved.
   */
  | 'install_changed_since_approval'
  /**
   * This node cannot READ its own install registry, so it cannot say what is
   * about to act. Distinct from the above and mapped to 503 rather than 409:
   * one is the world moving under a card, the other is a node that cannot
   * answer at all, and a 409 invites a retry loop against a node that will
   * refuse identically for ever. `acting_install.ts` states the distinction;
   * collapsing it here lost it on the send paths while `prepare` kept it.
   */
  | 'install_registry_unavailable'
  | 'approval_binding_failed'
  /**
   * §19 — the held quote has expired. The order is NOT sent: an expired quote
   * cannot be accepted, and dispatching against one burns a purchase order id
   * on a refusal the buyer could see coming.
   */
  | 'quote_expired'
  /**
   * §12.4 step 6 — the order contradicts the quote this node holds for it.
   * Distinct from expiry: the terms themselves disagree.
   */
  | 'quote_mismatch'
  /** An order with this id is already being tracked; §12.7 forbids a second. */
  | 'already_submitted'
  /**
   * A resend was asked for and §12.7 does not permit it: either no order is
   * tracked, or the supplier's answer never earned the authorization. This is
   * the refusal that stands between an ambiguous order and a duplicate one.
   */
  | 'resend_not_authorized';

export type SubmitResult =
  | { ok: true; record: BuyerOrderRecord }
  | { ok: false; refusal: SubmitRefusal; error: string; record?: BuyerOrderRecord };

/**
 * Who is committing the business, and on whose authority (§7.2, §7.3).
 *
 * REQUIRED (DR-1). It was optional once, and the whole section died there: no
 * caller supplied it, so spend ceilings, category and branch authority, quorum
 * and time-bounded delegation never ran on a real order. A node with no staff
 * model passes the single-owner configuration (`singleOwnerAuthority`) — one
 * grant, evaluated like any other — rather than passing nothing.
 */
export interface SubmitAuthority {
  chain: ActingForChain;
  approvals: string[];
  grants: StaffGrant[];
  quorum: QuorumPolicy;
}

/** How long to wait before the first reconcile poll on an ambiguous send. */
export const FIRST_REPOLL_SECONDS = 30;

/**
 * Submit an order the owner approved.
 *
 * WHAT ACTUALLY REFUSES WHAT (NEW-11), because the previous version of this
 * comment claimed all three for one check and none of them were still true of
 * it. `approved` and `context` both arrive from one retained row, and the
 * store computes `approved` by calling `buildBuyerApprovalPayload(order,
 * context)` — the same pure function this rebuilds with. The two payloads are
 * therefore identical BY CONSTRUCTION and `verifyApprovalBinding` cannot fail
 * on any field. It is kept as a cheap invariant on a future caller that
 * assembles the halves differently, not as a live protection:
 *
 * - a MUTATED STORE ROW is refused by `hydrate`, which recomputes the approval
 *   digest and reads a tampered row as absent;
 * - a SWAPPED, paused, revoked or reconfigured INSTALL is refused by
 *   `recheckActingInstall` below, which re-resolves against the registry so
 *   live state is on one side of the decision;
 * - a RE-PLANNED ORDER cannot reach here at all: the order comes out of the
 *   retained card, not the request.
 *
 * The recheck lives INSIDE this function rather than at the routes for the
 * reason `authority` is a required argument: a guard a caller can forget is a
 * guard that eventually gets forgotten, and a third send path would otherwise
 * get the authority check and the tautological binding check and nothing else.
 */
export async function submitApprovedOrder(args: {
  order: PurchaseOrderProposal;
  approved: BuyerApprovalPayload;
  context: BuyerApprovalContext;
  serviceRkey: string;
  send: BuyerOrderSender;
  nowMs: number;
  /**
   * §7.2/§7.3 — REQUIRED, and required is the fix (DR-1).
   *
   * This was optional, and neither order route supplied it, so
   * `evaluateStaffAuthority` never ran on a real order: spend ceilings,
   * category and branch authority, quorum and time-bounded delegation were
   * dead code reachable only from tests. A node with no staff model does NOT
   * pass nothing — it passes the single-owner configuration
   * (`singleOwnerAuthority`), which is one grant evaluated like any other.
   * There is no branch that skips the check, because that branch is what
   * silently swallowed the whole section.
   */
  authority: SubmitAuthority;
  /**
   * Send an order the supplier said it NEVER RECEIVED (§12.7, WS-7.8).
   *
   * A MODE HERE RATHER THAN A SECOND FUNCTION, and that is the safety
   * argument: everything around the send — the authority check, the §15.2
   * binding rebuilt from the order actually about to go, record-before-send —
   * is identical, and a parallel `resendOrder` would be a second place for one
   * of those to be dropped. The ONLY difference is what an existing record
   * means: normally it refuses a duplicate; here it is required, and it must
   * carry an authorization the supplier's own answer earned.
   *
   * The order goes back out UNCHANGED, same digest and same idempotency key.
   * That is deliberate: it is the same purchase, and if the supplier turns out
   * to be wrong about never having seen it, the key is what stops the second
   * copy from becoming a second order (§15.5).
   */
  resend?: boolean;
}): Promise<SubmitResult> {
  const runtime = getCommerceRuntime();
  if (runtime === null) {
    return {
      ok: false,
      refusal: 'commerce_unavailable',
      error: 'submit: this node has no commerce runtime',
    };
  }
  const supplierDid = args.order.supplier_did;

  // 1. A duplicate is refused at the door, not at the reconcile lane. §12.7's
  //    whole discipline is that a buyer never creates a second order for the
  //    same purchase; the cheapest place to honour that is before the send.
  const existing = runtime.buyerOrders.get(supplierDid, args.order.purchase_order_id);
  if (args.resend === true) {
    // The mirror image of the duplicate check, and the stricter half. Only a
    // `never_received` the supplier was ENTITLED to give sets
    // `resubmissionAuthorized`, and re-reading that flag rather than the state
    // name is the point: `never_received` given against held evidence leaves
    // the state and clears the flag, and it is the flag that matters.
    if (existing === null) {
      return {
        ok: false,
        refusal: 'resend_not_authorized',
        error: 'resend: no order is tracked under this supplier',
      };
    }
    if (!existing.resubmissionAuthorized) {
      return {
        ok: false,
        refusal: 'resend_not_authorized',
        error: 'resend: this order has not been shown to be un-received',
        record: existing,
      };
    }
  } else if (existing !== null) {
    return {
      ok: false,
      refusal: 'already_submitted',
      error: 'submit: this order is already being tracked',
      record: existing,
    };
  }

  // 1b. AUTHORITY, before the binding. There is no point proving an order is
  //     the one that was approved if nobody who approved it may commit this
  //     business — and checking it here rather than at the card means a
  //     re-planned order cannot be sent under an approval whose authority has
  //     since expired.
  {
    const verdict = evaluateStaffAuthority({
      chain: args.authority.chain,
      approvals: args.authority.approvals,
      grants: args.authority.grants,
      quorum: args.authority.quorum,
      request: {
        total: args.order.approved_total,
        // NEW-4 — EMPTY, DELIBERATELY, and that is a refusal rather than a
        // permission. The field this used to read (`allowedCategoryIds`)
        // arrived in the request body and was not bound into the approval
        // digest — it has since been deleted from the context. Evaluating a
        // `category_buyer` grant against it let a principal holding a
        // stationery grant state `['stationery']` and buy machinery — the same
        // shape as the `regionValue` defect one line below, which is derived
        // from the ORDER precisely so nobody names the value that grants them
        // authority.
        //
        // There is no Core-side category derivation to replace it with: the
        // order carries product references, and mapping those to categories
        // needs the supplier's catalog, which this node holds no verified copy
        // of at send time. So the honest reading is that this node cannot
        // evaluate category authority at all yet, and `covers` refuses a
        // `category_buyer` grant on an empty list (it requires
        // `categoryIds.length > 0`). A deployment whose staff model needs
        // category buyers must wait for that derivation rather than have the
        // rule quietly satisfied by the caller.
        categoryIds: [],
        // FROM THE ORDER, never from the context. A `location` grant reads
        // `scheme:value`, and passing null here — as this did — made branch
        // authority unsatisfiable on every real order: `covers` refuses a
        // location grant outright when the request names no region, so a
        // business whose staff model is "this branch buys for this state"
        // could not buy at all. Reading it from the order rather than the
        // caller-supplied context also means nobody can name the region that
        // happens to grant them authority.
        regionValue: `${args.order.delivery.region.scheme}:${args.order.delivery.region.value}`,
        side: 'buy',
      },
      nowMs: args.nowMs,
    });
    if (!verdict.permitted) {
      return {
        ok: false,
        refusal: 'not_authorized',
        error: `submit: ${verdict.reason}${verdict.needsAnotherPrincipal ? ' (a second person would permit it)' : ''}`,
      };
    }
  }

  // 1b. THE ACTING INSTALL, AS IT IS NOW. A card lives for its whole TTL, and
  //     an install can be paused, revoked, reconfigured or updated inside that
  //     window. Re-resolving against the registry is what puts live state on
  //     one side of the send decision; without it every check below compares
  //     the retained row against itself.
  const stillInstalled = resolveActingInstall(args.context, BUYER_REFERENCE_MANIFEST.plugin_id);
  if (!stillInstalled.ok) {
    return {
      ok: false,
      refusal:
        stillInstalled.refusal === 'install_registry_unavailable'
          ? 'install_registry_unavailable'
          : 'install_changed_since_approval',
      error: `submit: ${stillInstalled.refusal} — ${stillInstalled.detail}`,
    };
  }

  // 2. The binding, before anything is written or sent. Rebuilt from the ORDER
  //    about to go. See the note on this function for what it does and does
  //    not still protect.
  const rebuilt = buildBuyerApprovalPayload(args.order, args.context);
  if (!rebuilt.ok) {
    return {
      ok: false,
      refusal: 'approval_binding_failed',
      error: `submit: the card omitted ${rebuilt.missing.join(', ')}`,
    };
  }
  const verdict = verifyApprovalBinding(args.approved, rebuilt.payload);
  if (!verdict.ok) {
    return {
      ok: false,
      refusal: 'approval_binding_failed',
      error: `submit: ${verdict.field} — ${verdict.reason}`,
    };
  }

  // 2b. §12.4 step 6 / §19 — REVALIDATE THE QUOTE, immediately before dispatch.
  //
  //     The approval binding above proves the order matches the card. It says
  //     nothing about whether the QUOTE still stands: an approval can sit on an
  //     owner's screen for an hour, and §19 is explicit that an expired quote
  //     forces a requote rather than a submission. Nothing here checked it —
  //     `quoteExpiresAt` was bound into the payload and never compared to a
  //     clock, and `verifyOrderAgainstQuote` ran only on the SUPPLIER side,
  //     which is the party being checked.
  //
  //     So the buyer dispatched against expired or superseded quotes, burning a
  //     `purchase_order_id` and a §12.7 record, and relied on the counterparty
  //     to refuse. Trusting the other side to enforce your own precondition is
  //     not a check.
  //
  //     A quote this node does not hold is NOT a refusal: the buyer-side quote
  //     store is populated by the arrival path, and an order may legitimately
  //     be placed against a quote obtained out of band. What is refused is a
  //     quote this node HOLDS and can see is expired or contradicted.
  // The CURRENT head is the last accepted revision. `chain()` returns them
  // oldest first, so the tail is what the buyer is holding the supplier to —
  // checking an earlier revision would measure the order against terms both
  // sides have already moved past.
  const heldChain = runtime.buyerQuotes.chain(args.order.supplier_did, args.order.quote_id);
  const heldQuote = heldChain.length === 0 ? null : heldChain[heldChain.length - 1];
  if (heldQuote !== null) {
    const isoNow = new Date(args.nowMs).toISOString();
    if (isQuoteExpiredAt(heldQuote, isoNow)) {
      return {
        ok: false,
        refusal: 'quote_expired',
        error: `submit: quote ${args.order.quote_id} expired at ${heldQuote.valid_until}`,
      };
    }
    // The full comparison needs the PRICED PROJECTION, which lives in the
    // request this node retained when it asked. When the request is not held —
    // a quote obtained out of band, or one that predates the retained-request
    // store — expiry is still checked above and the terms comparison is
    // skipped rather than run against a projection this node cannot produce.
    const retained = runtime.buyerQuoteRequests.get(heldQuote.request_id);
    if (retained !== null) {
      const mismatch = verifyOrderAgainstQuote(
        args.order,
        heldQuote,
        retained.delivery.projection as unknown as Record<string, unknown>,
      );
      if (mismatch !== null) {
        return {
          ok: false,
          refusal: 'quote_mismatch',
          error: `submit: order does not match the held quote — ${mismatch}`,
        };
      }
    }
  }

  // 3. RECORD, then send. A crash here leaves a record for an order that never
  //    left, which reconcile resolves safely; the other order leaves no record
  //    of an order that may exist, and nothing would ever ask about it.
  //    The record carries what a LATER question needs: the re-poll runs after
  //    restarts, and a buyer that cannot restate its own order's digest cannot
  //    ask about it at all (§12.7).
  const record = newBuyerOrder(args.order.purchase_order_id, {
    orderDigest: args.order.order_digest,
    idempotencyKey: args.order.idempotency_key,
    // Straight off the order about to be sent. Any later answer is checked
    // against these, so they must come from the document itself and never
    // from a caller's parallel description of it.
    quoteDigest: args.order.quote_digest,
    quoteId: args.order.quote_id,
    buyerDid: args.order.buyer_did,
    supplierDid: args.order.supplier_did,
    protocolVersion: args.order.protocol_version,
    serviceRkey: args.serviceRkey,
    // §9.11 is a RECEIVER check: the buyer verifies each status's cumulative
    // fulfilment against its own order. Kept here, at the one moment the whole
    // order is in hand, because nothing later can reconstruct it.
    orderLines: args.order.accepted_lines,
  });
  // SCHEDULED BEFORE THE SEND, and this is the half step 3's argument was
  // missing. Recording before sending only helps if something later ASKS: a
  // crash between this write and the dispatch left the order
  // `submitted_unconfirmed` with `nextPollAtMs` null, and both the sweeper and
  // the poller select on a non-null due time — so the record existed and
  // nothing ever looked at it again. The settle below overwrites this with the
  // outcome's own schedule, so the only case it governs is the crash.
  record.nextPollAtMs = args.nowMs + FIRST_REPOLL_SECONDS * 1000;
  if (args.resend === true) {
    // OVERWRITE, before the send, for the same reason a first submission is
    // recorded before its send: a crash between the two must leave a record of
    // an order that may exist. The fresh record also clears
    // `resubmissionAuthorized` — one authorization, one resend.
    //
    // CAS ON THE ROW WE READ. That is what makes "one authorization, one
    // resend" true under concurrency: two workers that both saw the flag race
    // here, and exactly one wins. The loser must not send.
    record.revision = existing?.revision ?? 0;
    if (!runtime.buyerOrders.put(supplierDid, record)) {
      return {
        ok: false,
        refusal: 'resend_not_authorized',
        error: 'resend: another worker already spent this authorization',
        ...(runtime.buyerOrders.get(supplierDid, record.purchaseOrderId) !== null
          ? {
              record: runtime.buyerOrders.get(supplierDid, record.purchaseOrderId) as typeof record,
            }
          : {}),
      };
    }
    record.revision += 1;
  } else if (!runtime.buyerOrders.create(supplierDid, record)) {
    // THE INSERT IS THE GATE, not the read above it. The duplicate check at
    // step 1 is a read, and two concurrent submissions both pass it; only the
    // insert is atomic. Ignoring its answer and sending anyway was the whole
    // defect — it put two orders for the same purchase on the wire.
    return {
      ok: false,
      refusal: 'already_submitted',
      error: 'submit: this order is already being tracked',
      ...(runtime.buyerOrders.get(supplierDid, record.purchaseOrderId) !== null
        ? { record: runtime.buyerOrders.get(supplierDid, record.purchaseOrderId) as typeof record }
        : {}),
    };
  }

  const outcome = await args.send({
    supplierDid,
    serviceRkey: args.serviceRkey,
    order: args.order,
  });

  // 4. Settle through the §12.7 machine. Every outcome is expressed as the
  //    reconcile answer it is equivalent to, so there is ONE place that decides
  //    what a buyer state means — a second interpretation here would eventually
  //    disagree with the reconcile poller about the same situation.
  const reconcileRequest = {
    protocol_version: args.order.protocol_version,
    purchase_order_id: args.order.purchase_order_id,
    order_digest: args.order.order_digest,
    idempotency_key: args.order.idempotency_key,
  };
  const settled = applyReconcileResult({
    record,
    // No held evidence: this is the FIRST attempt, so the buyer has nothing
    // signed to present. That matters — it is what makes a `never_received`
    // equivalent legal, and it would not be legal on a later attempt.
    request: reconcileRequest,
    result: toReconcileResult(outcome),
    nowMs: args.nowMs,
  });
  // THROUGH THE RESOLVER. The send is an await, so a re-poll can settle the
  // order while it is in flight; forcing this answer over a terminal one turns
  // a settled order back into `outcome_unknown`, which is the state that
  // invites a duplicate.
  const stored = settleBuyerOrder({
    orders: runtime.buyerOrders,
    supplierDid,
    settled,
    reapply: (live) =>
      applyReconcileResult({
        record: live,
        request: reconcileRequest,
        result: toReconcileResult(outcome),
        nowMs: args.nowMs,
      }),
  });
  return { ok: true, record: stored };
}

/**
 * Express a send outcome as the reconcile answer it is equivalent to.
 *
 * `not_sent` becomes `never_received` because the sender PROMISED nothing
 * crossed the boundary — that is the same fact a supplier reports when it
 * genuinely never saw the order, and it is the one fact that safely authorizes
 * sending again. Everything about that safety rests on the sender telling the
 * truth, which is why the type documents the obligation at the definition.
 *
 * `ambiguous` becomes `received_unresolved` rather than `received_processing`:
 * processing means the decision has not reached the external boundary, which
 * this node cannot know, and the two differ in exactly the direction that
 * matters — `received_unresolved` is the one that never authorizes a resend.
 */
function toReconcileResult(
  outcome: BuyerSendOutcome,
): Parameters<typeof applyReconcileResult>[0]['result'] {
  switch (outcome.kind) {
    case 'acknowledged':
      return acknowledgementToResult(outcome.acknowledgement, FIRST_REPOLL_SECONDS);
    case 'not_sent':
      return { outcome: 'never_received' };
    case 'ambiguous':
      return { outcome: 'received_unresolved', retry_after_seconds: FIRST_REPOLL_SECONDS };
  }
}

let sender: BuyerOrderSender | null = null;

/**
 * Install the sender at boot, beside the commerce runtime. Null on shutdown.
 *
 * A REGISTRY rather than a route parameter, for the same reason the commerce
 * runtime is one: the composition root is the only place that knows how this
 * node reaches a supplier, and threading a sender through every caller is how
 * one caller ends up constructing its own.
 */
export function installBuyerOrderSender(value: BuyerOrderSender | null): void {
  sender = value;
}

/**
 * Null until a composition root supplies one.
 *
 * A caller that finds null must REFUSE. There is no fallback worth having: a
 * default sender would either be a no-op that silently swallowed orders, or a
 * direct HTTP call that skipped the four gates.
 */
export function getBuyerOrderSender(): BuyerOrderSender | null {
  return sender;
}
