/**
 * §5.5's lifecycle rows (PHOTO_COMMERCE_LANES_DESIGN, PC-8) — "the
 * lifecycle does not end at 'sent'", and none of these states may depend
 * on anybody watching:
 *
 *   - no quote before the request's `expires_at`  → `timed_out`
 *   - the quote lapses during the human pause     → `quote_expired`,
 *     any approval invalidated — an approval must never outlive the
 *     terms it approved
 *   - the §12.7 record resolves an unconfirmed submit:
 *       accepted        → `submitted`, lines record their order
 *       rejected        → `rejected` (reason on the row; lines reopen by
 *                         the buyer's explicit reopen action, §5.1)
 *       countered       → back to `quoted` with the approval dead:
 *                         §12.6's counterproposal is a new revision and
 *                         re-approval on the diff is required
 *       never_received  → `rejected(never_received)` — the supplier
 *                         provably never saw it
 *
 * Silence is never acceptance, and a dead conversation never wedges the
 * draft: every transition here is also reachable by an explicit buyer
 * action, and this sweep only makes the clock's answers durable. Driven
 * by the commerce sweeper tick both composition roots already start.
 */

import { recordCommerceEvent } from './observability';

import type { OrderConversation } from './order_draft_store';
import type { CommerceRuntime } from './runtime';

export interface LifecycleEvent {
  draftId: string;
  conversationId: string;
  transition:
    | 'timed_out'
    | 'quote_expired'
    | 'submitted'
    | 'rejected'
    | 'counterproposal'
    | 'never_received';
}

function isoBefore(iso: string, nowMs: number): boolean {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && parsed < nowMs;
}

/** One pass over every live conversation. Restart-safe: reads rows, writes rows. */
export function sweepOrderDraftLifecycle(
  runtime: CommerceRuntime,
  nowMs: number,
): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];
  for (const draft of runtime.orderDrafts.list()) {
    if (draft.abandoned) continue;
    let touched = false;

    const invalidateApproval = (conversation: OrderConversation): void => {
      if (conversation.approvalId !== null) {
        runtime.orderApprovals.consume(conversation.approvalId, nowMs);
        conversation.approvalId = null;
      }
    };

    for (const conversation of draft.conversations) {
      if (conversation.state === 'sent') {
        // The retained request is the clock. A request this node cannot
        // read any more is not judged — a missing row must not fake a
        // timeout.
        const retained =
          conversation.requestId === null
            ? null
            : runtime.buyerQuoteRequests.get(conversation.requestId);
        if (retained !== null && isoBefore(retained.expires_at, nowMs)) {
          conversation.state = 'timed_out';
          conversation.outcome = 'no_answer_before_expiry';
          touched = true;
          events.push({
            draftId: draft.draftId,
            conversationId: conversation.conversationId,
            transition: 'timed_out',
          });
        }
        continue;
      }

      if (conversation.state === 'quoted' || conversation.state === 'approved') {
        if (conversation.quoteValidUntil !== null && isoBefore(conversation.quoteValidUntil, nowMs)) {
          invalidateApproval(conversation);
          conversation.state = 'quote_expired';
          conversation.outcome = 'quote_lapsed';
          touched = true;
          events.push({
            draftId: draft.draftId,
            conversationId: conversation.conversationId,
            transition: 'quote_expired',
          });
        }
        continue;
      }

      if (conversation.state === 'submitted_unconfirmed' && conversation.purchaseOrderId !== null) {
        const record = runtime.buyerOrders.get(
          conversation.supplierDid,
          conversation.purchaseOrderId,
        );
        if (record === null) continue;
        if (record.state === 'accepted') {
          conversation.state = 'submitted';
          conversation.outcome = 'submitted';
          for (const lineId of conversation.lineIds) {
            const line = draft.lines.find((l) => l.lineId === lineId);
            if (line !== undefined) line.submittedIn = conversation.conversationId;
          }
          touched = true;
          events.push({
            draftId: draft.draftId,
            conversationId: conversation.conversationId,
            transition: 'submitted',
          });
        } else if (record.state === 'rejected' || record.state === 'never_received') {
          invalidateApproval(conversation);
          conversation.state = 'rejected';
          conversation.outcome = record.state === 'rejected' ? 'supplier_rejected' : 'never_received';
          touched = true;
          events.push({
            draftId: draft.draftId,
            conversationId: conversation.conversationId,
            transition: record.state === 'rejected' ? 'rejected' : 'never_received',
          });
        } else if (record.state === 'countered') {
          // §12.6 — the counter IS a new quote revision; it lands through
          // the quote lane and settles into this conversation once it is
          // back in `quoted`. The old approval is already dead.
          invalidateApproval(conversation);
          conversation.state = 'quoted';
          conversation.outcome = 'counterproposal';
          touched = true;
          events.push({
            draftId: draft.draftId,
            conversationId: conversation.conversationId,
            transition: 'counterproposal',
          });
        }
        // `submitted_unconfirmed` / `outcome_unknown` records: still §12.7's
        // question, not this sweep's answer.
      }
    }

    if (touched) {
      runtime.runInTransaction(() => {
        draft.updatedAtMs = nowMs;
        runtime.orderDrafts.put(draft);
      });
    }
  }
  // §8b — each transition the clock made durable, named; ids and states only.
  for (const event of events) {
    recordCommerceEvent({
      event: 'reconcile',
      lane: 'order',
      draftId: event.draftId,
      conversationId: event.conversationId,
      state: event.transition,
      atMs: nowMs,
    });
  }
  return events;
}
