/**
 * The ONE dispatch-under-approval path (§15.2 / PHOTO_COMMERCE_LANES_DESIGN
 * §5.4 stage 5), extracted from the submit route so the three callers that
 * must agree cannot drift:
 *
 *   - `POST /v1/commerce/orders/submit` — the single dispatch route;
 *   - `POST /v1/commerce/orders/drafts/submit` — the §5.1 submission
 *     orchestrator, whose step 2 is exactly this;
 *   - the dispatch-intent sweeper — crash replay and transient retry,
 *     which must send THE SAME WAY the first attempt did or the replay
 *     proves nothing about the crash.
 *
 * The §5.1 FOUR-CLASS outcome map lives here too, beside the dispatch it
 * classifies, because the class boundaries are typed refusal names this
 * module's own answers carry — keyed on the TYPED refusal, never the HTTP
 * status alone.
 */

import { approvalDigest } from './approval_payload';
import { v1RecordAdmissible } from './attribution_boundary';
import { getBuyerAuthorityProvider } from './buyer_authority';
import {
  getBuyerOrderSender,
  submitApprovedOrder,
  type SubmitAuthority,
  type SubmitRefusal,
} from './buyer_executor';
import { describeOrderForOwner } from './buyer_reconciliation';

import type { BuyerApprovalContext } from './approval_payload';
import type { RetainedOrderApproval } from './order_approvals';
import type { CommerceRuntime } from './runtime';
import type { PurchaseOrderProposal } from '@dina/commerce-protocol';

/** Route-shaped: what the caller answers with, or classifies. */
export interface DispatchAnswer {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Which status a submit refusal deserves (NEW-17).
 *
 * The three are different answers to a client: 200 says the order is already
 * placed, 503 says this node cannot decide, 409 says it decided no. Mapping an
 * unreadable install registry to 409 told a client "the install changed since
 * approval, retry" about a node that will refuse identically for ever — and
 * every other not-configured condition on these routes already answers 503.
 */
export function unanswerableStatus(refusal: SubmitRefusal): number {
  if (refusal === 'already_submitted') return 200;
  if (refusal === 'install_registry_unavailable') return 503;
  return 409;
}

/**
 * §7.2/§7.3 — who may commit this business, resolved by CORE (DR-1).
 *
 * FAIL CLOSED. A node whose composition root installed no authority provider
 * cannot say who is allowed to spend its money, so it does not spend it. The
 * previous shape passed nothing and `submitApprovedOrder` skipped the check
 * entirely, which meant every order on this node was committed with no
 * authority evaluation at all.
 */
export function resolveAuthority(
  order: PurchaseOrderProposal,
  context: BuyerApprovalContext,
  serviceRkey: string,
): { ok: true; authority: SubmitAuthority } | { ok: false; response: DispatchAnswer } {
  const provider = getBuyerAuthorityProvider();
  if (provider === null) {
    return {
      ok: false,
      response: { status: 503, body: { error: 'authority_provider_unavailable' } },
    };
  }
  const authority = provider({ order, context, serviceRkey });
  if (authority === null) {
    // §7.3: an owner with no grant record is not an owner. A missing record is
    // a refusal, never a default.
    return { ok: false, response: { status: 403, body: { error: 'no_authority_record' } } };
  }
  return { ok: true, authority };
}

export function readAnswerableApproval(
  runtime: CommerceRuntime,
  approvalId: string,
  nowMs: number,
): { ok: true; approval: RetainedOrderApproval } | { ok: false; response: DispatchAnswer } {
  const approval = runtime.orderApprovals.get(approvalId);
  if (approval === null) {
    // Absent, or held in a form this node can no longer reconstruct — a row
    // edited after writing reads as absent on purpose, because sending
    // against an approval we cannot rebuild is sending against nothing.
    return { ok: false, response: { status: 404, body: { error: 'unknown_approval' } } };
  }
  if (approval.consumedAt !== null) {
    return { ok: false, response: { status: 409, body: { error: 'approval_already_used' } } };
  }
  if (nowMs >= approval.expiresAt) {
    return { ok: false, response: { status: 409, body: { error: 'approval_expired' } } };
  }
  // §6.4 — past the attribution boundary an UNATTRIBUTED (v1) approval is
  // believed only through the immutable grandfather index: Core mints
  // v2-exclusively after the crossing, so a v1 row here is either
  // pre-staff history (indexed) or a downgrade, and a downgrade must not
  // spend money.
  if (
    approval.payload.attribution === undefined &&
    !v1RecordAdmissible(runtime.attributionBoundary, approvalDigest(approval.payload))
  ) {
    return { ok: false, response: { status: 409, body: { error: 'approval_unattributed' } } };
  }
  return { ok: true, approval };
}

/**
 * Send under a retained card — the whole submit path from "which card" to
 * the mapped answer. §5.4 stage 4's SUBMIT-TIME source-binding check is the
 * ENFORCEMENT (competitor revocation is the courtesy): a photo-minted
 * approval names its draft, conversation and generations, and the stale one
 * dies HERE because its generations are no longer the ones the draft holds
 * — not because a cleanup ran in time. Legacy approvals carry no binding
 * and submit as today.
 */
export async function dispatchUnderRetainedApproval(
  runtime: CommerceRuntime,
  approvalId: string,
  nowMs: number,
): Promise<DispatchAnswer> {
  const send = getBuyerOrderSender();
  if (send === null) {
    // FAIL CLOSED, and visibly. There is no fallback worth having: a default
    // sender would either be a no-op that swallowed orders or a direct HTTP
    // call that skipped the four gates. A node whose composition root has not
    // supplied one cannot buy, and says so.
    return { status: 503, body: { error: 'buyer_sender_unavailable' } };
  }

  const held = readAnswerableApproval(runtime, approvalId, nowMs);
  if (!held.ok) return held.response;

  const source = held.approval.payload.source;
  if (source !== undefined) {
    const sourceDraft = runtime.orderDrafts.get(source.draft_id);
    if (sourceDraft === null) {
      return { status: 404, body: { error: 'unknown_source_draft' } };
    }
    const conversation = sourceDraft.conversations.find(
      (c) => c.conversationId === source.conversation_id,
    );
    if (conversation === undefined || conversation.approvalId !== approvalId) {
      return {
        status: 409,
        body: {
          error: 'stale_source_binding',
          detail: 'this approval no longer belongs to a live conversation',
        },
      };
    }
    for (const bound of source.assignment_generations) {
      const line = sourceDraft.lines.find((l) => l.lineId === bound.line_id);
      if (line === undefined || line.assignmentGeneration !== bound.generation) {
        return {
          status: 409,
          body: {
            error: 'stale_source_binding',
            detail: `line ${bound.line_id} moved since this approval was minted`,
          },
        };
      }
    }
    for (const bound of source.requirement_generations) {
      const requirement = sourceDraft.requirements.find((r) => r.key === bound.key);
      if (requirement === undefined || requirement.generation !== bound.generation) {
        return {
          status: 409,
          body: {
            error: 'stale_source_binding',
            detail: `requirement ${bound.key} changed since this approval was minted`,
          },
        };
      }
    }
  }

  const authorised = resolveAuthority(
    held.approval.order,
    held.approval.context,
    held.approval.serviceRkey,
  );
  if (!authorised.ok) return authorised.response;

  const result = await submitApprovedOrder({
    authority: authorised.authority,
    // ALL THREE COME FROM THE RETAINED CARD. Taking any of them from the
    // request would restore the defect: the rebuild inside
    // `submitApprovedOrder` compares a payload derived from the order to the
    // approved payload, and a caller supplying both proves only that it was
    // self-consistent.
    order: held.approval.order,
    approved: held.approval.payload,
    context: held.approval.context,
    serviceRkey: held.approval.serviceRkey,
    send,
    nowMs,
  });
  // SPENT ONLY ON A SEND. A refusal leaves the card answerable, so a
  // transient `buyer_sender_unavailable` or a momentarily expired quote does
  // not burn a decision the owner would have to make again from scratch.
  if (result.ok) runtime.orderApprovals.consume(approvalId, nowMs);
  if (!result.ok) {
    return {
      // 503 for a node that cannot answer, 200 for "already submitted"
      // (the right answer to a repeated tap), 409 for a well-formed request
      // the world disagreed with. See `unanswerableStatus`.
      status: unanswerableStatus(result.refusal),
      body: { ok: false, refusal: result.refusal, error: result.error, record: result.record },
    };
  }
  return { status: 200, body: { ok: true, ...describeOrderForOwner(result.record) } };
}

// ---------------------------------------------------------------------------
// The §5.1 four-class outcome map
// ---------------------------------------------------------------------------

export type DispatchClass =
  /** The send happened and the supplier's answer confirms it. */
  | { kind: 'confirmed' }
  /** Durable record created or send attempted; §12.7 reconcile owns it now. */
  | { kind: 'uncertain' }
  /**
   * The NODE ITSELF briefly cannot act — nothing created, nothing sent, and
   * the SAME intent succeeds on retry. Competitors stay closed, the approval
   * is untouched; its own TTL still governs.
   */
  | { kind: 'transient'; reason: string }
  /**
   * Deterministic, pre-send: nothing left the node and nothing could have.
   * Replaying it loops for ever, so the intent must terminate.
   */
  | { kind: 'refused'; reason: string };

/**
 * "Any TYPED node-cannot-act unavailability refusal" — currently four, each
 * a named test boundary (§5.1). r14 enumerated two, and the other two would
 * have defaulted into "uncertain": a never-sent intent parked in reconcile.
 */
const TRANSIENT_REFUSALS: ReadonlySet<string> = new Set([
  'buyer_sender_unavailable',
  'install_registry_unavailable',
  'commerce_unavailable',
  'authority_provider_unavailable',
]);

/** Record states §12.7 has not settled — the conversation waits with it. */
const UNSETTLED_RECORD_STATES: ReadonlySet<string> = new Set([
  'submitted_unconfirmed',
  'outcome_unknown',
]);

/**
 * Classify a dispatch answer into §5.1's four classes — keyed on the TYPED
 * refusal, never the HTTP status alone.
 *
 * THE DEFAULT DIRECTION IS DELIBERATE: an unrecognized typed refusal maps to
 * `refused`, not `uncertain`, because every refusal this path can produce is
 * pre-send except `outcome_unknown` (which is named), and routing a
 * deterministic refusal into "uncertain" parks a never-sent intent in
 * reconcile with no order to reconcile — competitors closed for ever, the
 * wedge §5.1 criticizes by name. That includes 403 `no_authority_record` and
 * 404 `unknown_approval` (an absent or integrity-failed approval row, which
 * competitor revocation can produce mid-race).
 */
export function classifyDispatchAnswer(answer: DispatchAnswer): DispatchClass {
  const body = answer.body;
  if (answer.status === 200) {
    // Either `ok: true` with the owner projection spread in, or the
    // `already_submitted` refusal carrying its tracked record — the record
    // wins over everything, including the refusal that delivered it.
    const record = body.record as { state?: unknown } | undefined;
    const state = typeof body.state === 'string' ? body.state : String(record?.state ?? '');
    return UNSETTLED_RECORD_STATES.has(state) ? { kind: 'uncertain' } : { kind: 'confirmed' };
  }
  const reason = String(
    (body.refusal as string | undefined) ?? (body.error as string | undefined) ?? 'unknown',
  );
  if (TRANSIENT_REFUSALS.has(reason)) return { kind: 'transient', reason };
  if (reason === 'outcome_unknown') return { kind: 'uncertain' };
  return { kind: 'refused', reason };
}

/**
 * Replay's FIRST question (§5.1): does a buyer-order record exist for this
 * intent? The poisoned case this exists for: dispatch succeeded, the
 * approval was consumed at the send boundary, the crash landed before the
 * outcome was recorded — a naive replay now meets a consumed-approval 409
 * and reads it as definitive refusal, reopening competitors against an
 * order that is durably on its way: a double purchase by misclassification.
 * The record, when one exists, wins over everything.
 */
export function resolveIntentAgainstRecord(
  runtime: CommerceRuntime,
  supplierDid: string,
  purchaseOrderId: string,
): DispatchClass | null {
  const record = runtime.buyerOrders.get(supplierDid, purchaseOrderId);
  if (record === null) return null;
  return UNSETTLED_RECORD_STATES.has(record.state) ? { kind: 'uncertain' } : { kind: 'confirmed' };
}
