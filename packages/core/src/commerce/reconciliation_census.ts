/**
 * Post-restore reconciliation census (§16.2, WS-4.3) — what is frozen, and
 * what each frozen order is waiting for.
 *
 * WHY A CENSUS AND NOT A SWEEP. The obvious reading of "bulk reconciliation"
 * is a job that walks every re-adopted order and clears the flag. It cannot
 * exist. The ceremony clears `reconciliation_required` by checking the buyer's
 * HELD order proposal against the digest this supplier already signed; a
 * re-adopted order has no lines, no quote context, and no external state, so
 * there is nothing local to check against. A sweep would have to invent the
 * terms — which is the exact thing the post-restore quote seam (X-10) exists
 * to forbid, one layer up.
 *
 * So the bulk operation reports. It tells the owner which orders cannot move
 * and which counterparty holds the evidence that would free each one. That is
 * genuinely useful — without it the owner learns about a frozen order only
 * when a buyer complains — and it is honest about who can finish the job.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. No line items, no money, no quote terms.
 * Partly because a re-adopted order does not have them, and partly because the
 * census is a management view: the answer to "what is stuck" is a list of
 * orders and buyers, not a re-export of the ledger.
 */

import type { CommerceOrderRef } from './order_refs';

/** One frozen order, as the owner needs to see it. */
export interface FrozenOrder {
  buyerDid: string;
  purchaseOrderId: string;
  /**
   * The epoch the order was admitted under. A value below the current epoch
   * says the order predates a restore; equal says it was re-adopted in this
   * generation. The owner does not need to reason about it, but an operator
   * chasing a pattern does.
   */
  admittedEpoch: string;
  /** When the reference was written. Drives the oldest-first ordering. */
  createdAt: number;
  /**
   * Whether this supplier ever answered the order. A decided order that is
   * frozen is the worse case: the buyer holds an acknowledgement this node
   * can no longer describe.
   */
  decided: boolean;
}

export interface ReconciliationCensus {
  /** Oldest first: the longest-frozen order is the one to chase. */
  frozen: FrozenOrder[];
  /**
   * How many DISTINCT counterparties must act. The count that matters for
   * effort, since one buyer with forty stuck orders is one conversation.
   */
  buyerCount: number;
  /**
   * Stated plainly so no caller mistakes this for a repair job. The owner
   * cannot clear these from here; each buyer presents its held proposal and
   * the per-order ceremony does the rest.
   */
  clearedBy: 'buyer_presents_held_order_proposal';
}

/**
 * Build the census from the order references awaiting reconciliation.
 *
 * Pure, and takes rows rather than a repository, so the "what does the owner
 * see" decision is testable without a database and cannot quietly acquire a
 * query of its own.
 */
export function buildReconciliationCensus(
  awaiting: readonly CommerceOrderRef[],
): ReconciliationCensus {
  const frozen = awaiting
    .map((ref) => ({
      buyerDid: ref.buyerDid,
      purchaseOrderId: ref.purchaseOrderId,
      admittedEpoch: ref.admittedEpoch,
      createdAt: ref.createdAt,
      decided: ref.state === 'decided',
    }))
    // Oldest first. A frozen order does not get better with time — the buyer
    // is waiting on an answer this node cannot give — so the longest-frozen
    // one is the one to chase, and a stable tiebreak keeps the list from
    // reshuffling between reads.
    .sort((a, b) =>
      a.createdAt !== b.createdAt
        ? a.createdAt - b.createdAt
        : a.purchaseOrderId.localeCompare(b.purchaseOrderId),
    );

  return {
    frozen,
    buyerCount: new Set(frozen.map((order) => order.buyerDid)).size,
    clearedBy: 'buyer_presents_held_order_proposal',
  };
}
