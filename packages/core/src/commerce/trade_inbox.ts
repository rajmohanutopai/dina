/**
 * The §7 order inbox — one read assembling BOTH directions of a
 * dual-role node into the list a clerk works through:
 *
 *   - pending confirms   — order drafts with vouchable lines (buyer);
 *   - pending quotes     — conversations quoted, awaiting approve (buyer);
 *   - open tenders       — §3.2 comparisons still collecting (buyer);
 *   - pending decisions  — orders waiting on a human (supplier);
 *   - unreceipted        — dispatched notes with no receipt (both);
 *   - short acceptances  — receipts accepting less than delivered
 *                          (supplier: the §4.3 dispute surface);
 *   - unacked payments   — payment notes with no acknowledgement (both).
 *
 * READ-ONLY AND METADATA-SHAPED: ids, counts, counterparties and
 * clocks — never line contents, so the same body can render on the
 * staff surface a grant admits. Batch vouch needs no machinery here:
 * confirm already vouches every included line in one ceremony, and the
 * 5-minute presence window covers as many ceremonies as the screen
 * aggregates.
 */

import { compareQuantities } from '@dina/commerce-protocol';

import { deriveOrderDraftState } from './order_draft_store';
import { rehydrateTradeDocument } from './trade_ledger';

import type { CommerceRuntime } from './runtime';

export interface TradeInboxItem {
  kind:
    | 'pending_confirm'
    | 'pending_quote'
    | 'open_tender'
    | 'pending_decision'
    | 'unreceipted_delivery'
    | 'short_acceptance'
    | 'unacknowledged_payment';
  /** Which install role works this item. */
  role: 'buyer' | 'supplier';
  /** The id the surface acts on: draft, tender, order or digest. */
  subject: string;
  counterpartyDid: string;
  createdAt: number;
}

export interface TradeInbox {
  items: TradeInboxItem[];
}

export function buildTradeInbox(runtime: CommerceRuntime, nowMs: number): TradeInbox {
  const items: TradeInboxItem[] = [];

  // Buyer: drafts with lines a ceremony has not covered yet.
  for (const draft of runtime.orderDrafts.list()) {
    if (draft.abandoned || deriveOrderDraftState(draft) === 'closed') continue;
    const unvouched = draft.lines.some(
      (line) =>
        !line.deferred &&
        line.submittedIn === null &&
        line.resolution.kind === 'resolved' &&
        line.vouch === null,
    );
    if (unvouched) {
      items.push({
        kind: 'pending_confirm',
        role: 'buyer',
        subject: draft.draftId,
        counterpartyDid: '',
        createdAt: draft.createdAtMs,
      });
    }
    for (const conversation of draft.conversations) {
      if (conversation.state === 'quoted') {
        items.push({
          kind: 'pending_quote',
          role: 'buyer',
          subject: `${draft.draftId}:${conversation.conversationId}`,
          counterpartyDid: conversation.supplierDid,
          createdAt: draft.updatedAtMs,
        });
      }
    }
  }

  // Buyer: tenders still inside their window.
  for (const tender of runtime.tenders.listTenders()) {
    if (tender.expiresAt <= nowMs) continue;
    items.push({
      kind: 'open_tender',
      role: 'buyer',
      subject: tender.tenderId,
      counterpartyDid: '',
      createdAt: tender.createdAt,
    });
  }

  // Supplier: orders a runner answered and a person has not.
  for (const pending of runtime.pendingDecisions.list()) {
    items.push({
      kind: 'pending_decision',
      role: 'supplier',
      subject: pending.purchaseOrderId,
      counterpartyDid: pending.buyerDid,
      createdAt: pending.createdAt,
    });
  }

  // Both directions of the khata sweeps (§4.3): what each side is
  // waiting on. An INBOUND note is this node's to receipt (buyer role);
  // an OUTBOUND note waiting is the supplier's uncontested dispatch.
  for (const direction of ['inbound', 'outbound'] as const) {
    for (const row of runtime.tradeDocuments.listByKind('delivery_note', direction)) {
      if (runtime.tradeDocuments.answersTo(row.recordDigest, 'delivery_receipt').length > 0) {
        continue;
      }
      items.push({
        kind: 'unreceipted_delivery',
        role: direction === 'inbound' ? 'buyer' : 'supplier',
        subject: row.recordDigest,
        counterpartyDid: row.counterpartyDid,
        createdAt: row.createdAt,
      });
    }
    for (const row of runtime.tradeDocuments.listByKind('payment_note', direction)) {
      if (runtime.tradeDocuments.answersTo(row.recordDigest, 'payment_ack').length > 0) continue;
      items.push({
        kind: 'unacknowledged_payment',
        role: direction === 'inbound' ? 'supplier' : 'buyer',
        subject: row.recordDigest,
        counterpartyDid: row.counterpartyDid,
        createdAt: row.createdAt,
      });
    }
  }

  // Supplier: receipts that accepted less than the note delivered — the
  // §4.3 short-acceptance dispute surface. Compared with the SAME
  // comparator the fold and the receipt verifier use (compareQuantities),
  // because a receipt line may legally answer a kg note in grams: raw
  // values would call 750 g against 1 kg full, and 0.5 kg against
  // 500 g short.
  for (const receiptRow of runtime.tradeDocuments.listByKind('delivery_receipt', 'inbound')) {
    try {
      const receipt = rehydrateTradeDocument(receiptRow);
      if (receipt.kind !== 'delivery_receipt') continue;
      const noteRow = runtime.tradeDocuments.get(receipt.document.delivery_note_digest);
      if (noteRow === null) continue;
      const note = rehydrateTradeDocument(noteRow);
      if (note.kind !== 'delivery_note') continue;
      const delivered = new Map(
        note.document.lines.map((line) => [line.line_id, line.delivered_quantity]),
      );
      const shorted = receipt.document.lines.some((line) => {
        const deliveredQuantity = delivered.get(line.line_id);
        return (
          deliveredQuantity !== undefined &&
          compareQuantities(line.accepted_quantity, deliveredQuantity) === -1
        );
      });
      if (shorted) {
        items.push({
          kind: 'short_acceptance',
          role: 'supplier',
          subject: receiptRow.recordDigest,
          counterpartyDid: receiptRow.counterpartyDid,
          createdAt: receiptRow.createdAt,
        });
      }
    } catch {
      // A row this build cannot re-verify drops out of the INBOX view;
      // the ledger integrity error surfaces where the row is acted on.
    }
  }

  items.sort((a, b) => a.createdAt - b.createdAt);
  return { items };
}
